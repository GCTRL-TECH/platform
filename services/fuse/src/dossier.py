"""
A2 — Entity Dossier builder (the HOT memory tier)
─────────────────────────────────────────────────

Compiles an authoritative per-entity memory for the top-degree ("god node")
entities of a compilation, and on-demand for a single named entity. A dossier is:

  • summary       — a concise LLM synthesis (REUSES the distiller's local-Ollama
                    per-entity pass; same prompt shape, zero cloud).
  • key_facts     — the entity's relations as structured facts, each with the
                    edge's `confidence` (from KEX relex). [{rel, target, type,
                    direction, confidence}].
  • origin_files  — the files this entity was extracted from, resolved via the
                    node's `_source_job`/`_origin` → jobs.input.fileName/sourceRef.
  • timeline      — dated facts (any neighbour/fact whose target parses as a date),
                    sorted ascending. [{date, fact}].
  • trust         — 0.8 (high, but below an explicitly user-pinned fact).

Upserted into `entity_dossiers` keyed by (user_id, entity_uri) so a rebuild
refreshes in place. Everything runs FULLY LOCAL against the in-container Ollama.

Build triggers:
  • `build_top_dossiers(compilation_id, user_id, top_n)` — called from the distill
    job so distilling a WIKI/source ALSO refreshes dossiers for its top entities.
  • `build_dossier_for_name(user_id, entity_name, ...)` — on-demand single entity
    (the api-rs GET /dossier?name=X build-on-the-fly path).
"""

import datetime as _dt
import json
import logging
import re
from typing import Optional

import psycopg2
import psycopg2.extras
from neo4j import GraphDatabase

from . import telemetry

from . import config
from . import distiller

logger = logging.getLogger(__name__)

DOSSIER_TRUST = 0.8

# Structural edges that are not domain facts (mirrors the distiller).
_STRUCTURAL_RELS = {"CONTAINS", "SIMILAR_TO"}

# A few permissive date shapes for the timeline: ISO (2026-06-13), year (2026),
# month-year, and DD.MM.YYYY (German). Best-effort — non-dates are simply skipped.
_DATE_PATTERNS = [
    (re.compile(r"^\s*(\d{4})-(\d{2})-(\d{2})"), "%Y-%m-%d"),
    (re.compile(r"^\s*(\d{2})\.(\d{2})\.(\d{4})"), "%d.%m.%Y"),
    (re.compile(r"^\s*(\d{4})\s*$"), "%Y"),
]


def _pg_connect():
    return psycopg2.connect(config.PG_URL, connect_timeout=5)


def _neo_driver():
    return GraphDatabase.driver(
        config.NEO4J_URI, auth=(config.NEO4J_USER, config.NEO4J_PASSWORD)
    )


# ── Neo4j: one entity + its rich 1-hop neighbourhood (with confidence + dir) ────

def _fetch_entity_facts(driver, user_id: str, entity_name: str) -> Optional[dict]:
    """Resolve the CANONICAL node for `entity_name` (highest degree) scoped to the
    user, plus its directed relations with edge confidence and each neighbour's
    `_source_job`. Returns None if no owned node matches.

    Scope mirrors the api-rs entity reads: `_owner = $uid OR user_id = $uid OR
    user_id IS NULL` (shared nodes are visible). Picks the highest-degree node so
    a pre-fusion name with several nodes resolves to the meaningful one.
    """
    # When a name has several nodes (a pre-/post-fusion artifact), prefer the
    # node that actually carries provenance (`_source_job`) and the richest edges:
    # rank by (has source_job, edges-with-confidence, degree). This avoids picking
    # a bare duplicate that lost its confidence + origin metadata in a merge.
    query = """
    MATCH (n {name: $name})
      WHERE (n._owner = $uid OR n.user_id = $uid OR n.user_id IS NULL)
    OPTIONAL MATCH (n)-[ro]->(o)
      WHERE NOT type(ro) IN $structural
    OPTIONAL MATCH (i)-[ri]->(n)
      WHERE NOT type(ri) IN $structural
    WITH n,
         count(DISTINCT o) + count(DISTINCT i) AS degree,
         count(DISTINCT CASE WHEN ro.confidence IS NOT NULL THEN o END)
           + count(DISTINCT CASE WHEN ri.confidence IS NOT NULL THEN i END) AS conf_edges,
         CASE WHEN n._source_job IS NOT NULL THEN 1 ELSE 0 END AS has_prov,
         collect(DISTINCT {dir: 'out', rel: type(ro), name: o.name,
                           type: coalesce(o.coarse_type, o.type),
                           confidence: ro.confidence,
                           authority: ro._authority,
                           superseded_by_doc: ro._superseded_by_doc})[..40] AS outs,
         collect(DISTINCT {dir: 'in', rel: type(ri), name: i.name,
                           type: coalesce(i.coarse_type, i.type),
                           confidence: ri.confidence,
                           authority: ri._authority,
                           superseded_by_doc: ri._superseded_by_doc})[..40] AS ins
    ORDER BY has_prov DESC, conf_edges DESC, degree DESC, id(n) ASC
    RETURN n.name AS name,
           coalesce(n.coarse_type, n.type, 'entity') AS type,
           n._source_job AS source_job,
           n._origin AS origin,
           n.uri AS uri,
           outs, ins
    LIMIT 1
    """
    with driver.session() as session:
        rec = session.run(
            query, name=entity_name, uid=user_id, structural=list(_STRUCTURAL_RELS)
        ).single()
    return _parse_entity_record(rec, entity_name)


def _fetch_entity_facts_scoped(
    driver, entity_name: str, job_ids: list[str]
) -> Optional[dict]:
    """KB-SCOPED variant of `_fetch_entity_facts`: authorizes on the GRANTED
    source-jobs instead of ownership, and confines the canonical node AND every
    neighbour to `_source_job IN $job_ids`. This is what lets a colleague token get
    a HOT dossier for an entity in its granted knowledge base — leak-safe BY
    CONSTRUCTION: no node, edge, or neighbour name from outside the grant can enter
    the compiled facts. Returns None when the entity has no node inside the grant."""
    if not job_ids:
        return None
    # Mirror of the owner query, but every MATCH endpoint is gated on the granted
    # jobs (the grant IS the authorization boundary — no `_owner`/`user_id` clause).
    query = """
    MATCH (n {name: $name})
      WHERE n._source_job IN $job_ids
    OPTIONAL MATCH (n)-[ro]->(o)
      WHERE NOT type(ro) IN $structural AND o._source_job IN $job_ids
    OPTIONAL MATCH (i)-[ri]->(n)
      WHERE NOT type(ri) IN $structural AND i._source_job IN $job_ids
    WITH n,
         count(DISTINCT o) + count(DISTINCT i) AS degree,
         count(DISTINCT CASE WHEN ro.confidence IS NOT NULL THEN o END)
           + count(DISTINCT CASE WHEN ri.confidence IS NOT NULL THEN i END) AS conf_edges,
         CASE WHEN n._source_job IS NOT NULL THEN 1 ELSE 0 END AS has_prov,
         collect(DISTINCT {dir: 'out', rel: type(ro), name: o.name,
                           type: coalesce(o.coarse_type, o.type),
                           confidence: ro.confidence,
                           authority: ro._authority,
                           superseded_by_doc: ro._superseded_by_doc})[..40] AS outs,
         collect(DISTINCT {dir: 'in', rel: type(ri), name: i.name,
                           type: coalesce(i.coarse_type, i.type),
                           confidence: ri.confidence,
                           authority: ri._authority,
                           superseded_by_doc: ri._superseded_by_doc})[..40] AS ins
    ORDER BY has_prov DESC, conf_edges DESC, degree DESC, id(n) ASC
    RETURN n.name AS name,
           coalesce(n.coarse_type, n.type, 'entity') AS type,
           n._source_job AS source_job,
           n._origin AS origin,
           n.uri AS uri,
           outs, ins
    LIMIT 1
    """
    with driver.session() as session:
        rec = session.run(
            query, name=entity_name, job_ids=job_ids,
            structural=list(_STRUCTURAL_RELS),
        ).single()
    return _parse_entity_record(rec, entity_name)


def _parse_entity_record(rec, entity_name: str) -> Optional[dict]:
    """Shared record → facts/neighbors/source_jobs projection for both the owner
    (`_fetch_entity_facts`) and the KB-scoped (`_fetch_entity_facts_scoped`)
    fetchers, so the two can't drift."""
    if not rec:
        return None

    facts: list[dict] = []
    neighbors: list[dict] = []
    source_jobs: set[str] = set()
    if rec["source_job"]:
        source_jobs.add(str(rec["source_job"]))

    for bucket in (rec["outs"], rec["ins"]):
        for f in bucket or []:
            tgt = distiller._clean_name(f.get("name"))
            rel = f.get("rel")
            if not tgt or not rel:
                continue
            direction = f.get("dir") or "out"
            conf = f.get("confidence")
            try:
                conf = float(conf) if conf is not None else None
            except (TypeError, ValueError):
                conf = None
            fact = {
                "rel": rel,
                "target": tgt,
                "type": f.get("type") or "entity",
                "direction": direction,
                "confidence": conf,
            }
            # P3 — recency authority: when conflict detection marked this edge
            # ("current" vs "superseded" + the doc that supersedes it), carry
            # the annotation into key_facts so dossier readers (Pi's
            # get_dossier, the RAG hot block) can say "current per <doc>,
            # older value from <doc>" instead of asserting a stale fact.
            if f.get("authority"):
                fact["authority"] = f.get("authority")
                if f.get("superseded_by_doc"):
                    fact["supersededByDoc"] = f.get("superseded_by_doc")
            facts.append(fact)
            neighbors.append({
                "name": tgt, "type": f.get("type"), "rel": rel,
            })

    # Deterministic ordering: high-confidence facts first, then alphabetical.
    facts.sort(key=lambda x: (-(x["confidence"] or 0.0), x["rel"], x["target"]))

    return {
        "name": distiller._clean_name(rec["name"]) or entity_name,
        "type": rec["type"] or "entity",
        "source_job": str(rec["source_job"]) if rec["source_job"] else None,
        "origin": rec["origin"],
        "uri": rec["uri"],
        "source_jobs": sorted(source_jobs),
        "facts": facts,
        "neighbors": neighbors,
    }


def _fetch_top_entity_names(driver, source_job_ids: list[str], top_n: int) -> list[str]:
    """The highest-degree entity names in the compilation's source graph."""
    if not source_job_ids:
        return []
    query = """
    MATCH (e:Entity)
      WHERE e._source_job IN $job_ids
    OPTIONAL MATCH (e)-[r]-(m:Entity)
      WHERE NOT type(r) IN $structural AND m._source_job IN $job_ids
    WITH e, count(DISTINCT m) AS degree
    WHERE e.name IS NOT NULL
    RETURN e.name AS name
    ORDER BY degree DESC, name ASC
    LIMIT $top_n
    """
    out: list[str] = []
    with driver.session() as session:
        for rec in session.run(
            query, job_ids=source_job_ids, structural=list(_STRUCTURAL_RELS), top_n=top_n
        ):
            nm = distiller._clean_name(rec["name"])
            if nm and nm not in out:
                out.append(nm)
    return out


# ── Postgres: resolve origin files from source jobs ─────────────────────────────

def _resolve_origin_files(conn, user_id: str, source_jobs: list[str]) -> list[str]:
    """Map each source job → its fileName/sourceRef. Dedup, preserve order."""
    files: list[str] = []
    if not source_jobs:
        return files
    with conn.cursor() as cur:
        for sj in source_jobs:
            try:
                cur.execute(
                    "SELECT COALESCE(input->>'fileName', input->>'sourceRef', "
                    "        left(input->>'text', 60)) "
                    "FROM jobs WHERE id = %s::uuid AND user_id = %s::uuid",
                    (sj, user_id),
                )
                row = cur.fetchone()
            except Exception:
                conn.rollback()
                continue
            if row and row[0] and row[0] not in files:
                files.append(row[0])
    return files


# ── P2a: precise grounding chunks via the node's graph uri ──────────────────────

def _fetch_grounding_chunks_by_uri(conn, entity_uri_val: Optional[str], max_chunks: int = 3) -> list[dict]:
    """Fetch grounding chunks for an entity via its stable graph uri (P2a).

    Precise: matches `text_chunks.entity_uris` (written at KEX ingest time), no
    name-substring false positives. Returns [] when the entity has no uri (older
    extraction predating P2a, or pruned from the graph) so the caller falls back
    to the legacy name-based Qdrant lookup — same shape as
    `distiller._fetch_grounding_chunks` ([{chunkId, source, text_snippet,
    min_rank, class_labels}])."""
    if not entity_uri_val:
        return []
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT id, source_document_id, content, min_rank, class_labels "
                "FROM text_chunks WHERE entity_uris @> ARRAY[%s]::text[] "
                "ORDER BY created_at DESC LIMIT %s",
                (entity_uri_val, max_chunks),
            )
            rows = cur.fetchall()
    except Exception as exc:
        conn.rollback()
        logger.warning(f"dossier: entity_uris chunk lookup failed for {entity_uri_val}: {exc}")
        return []

    matches: list[dict] = []
    for chunk_id, source_doc, content, min_rank, class_labels in rows:
        snippet = (content or "").strip()
        if len(snippet) > 400:
            snippet = snippet[:400].rsplit(" ", 1)[0] + "…"
        matches.append({
            "chunkId": str(chunk_id),
            "source": str(source_doc) if source_doc else "",
            "text_snippet": snippet,
            "min_rank": int(min_rank) if min_rank is not None else 0,
            "class_labels": class_labels or [],
        })
    return matches


# ── Timeline extraction (dated facts) ───────────────────────────────────────────

def _build_timeline(facts: list[dict]) -> list[dict]:
    """Pull facts whose TARGET parses as a date into a sorted timeline."""
    dated: list[tuple[str, dict]] = []
    for f in facts:
        tgt = (f.get("target") or "").strip()
        for pat, _fmt in _DATE_PATTERNS:
            m = pat.match(tgt)
            if not m:
                continue
            # Normalize the sort key to an ISO-ish prefix.
            g = m.groups()
            if len(g) == 3 and len(g[0]) == 4:      # YYYY-MM-DD
                key = f"{g[0]}-{g[1]}-{g[2]}"
            elif len(g) == 3:                        # DD.MM.YYYY
                key = f"{g[2]}-{g[1]}-{g[0]}"
            else:                                    # YYYY
                key = f"{g[0]}-00-00"
            rel = f["rel"].replace("_", " ").lower()
            dated.append((key, {"date": tgt, "fact": f"{rel}: {tgt}"}))
            break
    dated.sort(key=lambda x: x[0])
    return [d for _, d in dated]


# ── Summary synthesis (REUSES the distiller's local-Ollama per-entity pass) ─────

def _build_summary(entity: dict, conn=None) -> str:
    """One concise paragraph from the distiller's Ollama synthesis. Falls back to
    a deterministic fact list if the LLM is unavailable (graceful, still grounded).
    """
    # P2a: prefer the precise entity_uris-based lookup (no name-substring false
    # positives) when the node has a graph uri; fall back to the legacy
    # name+source-job Qdrant scroll otherwise (older extraction, or uri absent).
    citations = []
    uri = entity.get("uri")
    if uri and conn is not None:
        try:
            citations = _fetch_grounding_chunks_by_uri(conn, uri, max_chunks=3)
        except Exception as exc:
            logger.warning(f"dossier: uri-based grounding fetch failed for {entity['name']}: {exc}")
    if not citations and entity.get("source_jobs"):
        try:
            citations = distiller._fetch_grounding_chunks(
                entity["source_jobs"], entity["name"], max_chunks=3
            )
        except Exception as exc:
            logger.warning(f"dossier: grounding fetch failed for {entity['name']}: {exc}")

    # Self-contained dossier-summary prompt (1-3 sentences). We DON'T slice the
    # distiller's full-page prompt — that loses the entity name/type framing and
    # makes the model misread the subject. Build the fact + snippet context here
    # and name the subject + its type explicitly so the summary stays grounded.
    neighbor_lines = "\n".join(
        f"- {n['name']} ({n.get('type') or 'entity'}) via {n.get('rel') or 'related_to'}"
        for n in entity.get("neighbors", [])
    ) or "- (no recorded relationships)"
    snippet_lines = "\n".join(
        f"[{i + 1}] {c['text_snippet']}" for i, c in enumerate(citations)
    ) or "(no source snippets available)"
    prompt = (
        f"Write a 1-3 sentence factual summary of the entity «{entity['name']}» "
        f"(a {entity['type']}). Describe WHO or WHAT «{entity['name']}» is and its "
        "most important relationships, using ONLY the facts below. Refer to the "
        f"subject as «{entity['name']}». Do NOT invent facts, do NOT confuse the "
        "subject with a related entity. No headings, no markdown, no citations — "
        "just the summary sentences.\n\n"
        f"Relationships of «{entity['name']}»:\n{neighbor_lines}\n\n"
        f"Source snippets:\n{snippet_lines}\n"
    )
    try:
        summary = distiller._llm_complete(prompt).strip()
        # Strip any stray heading the model emitted.
        summary = re.sub(r"^#+\s.*$", "", summary, flags=re.MULTILINE).strip()
        if summary:
            return summary
    except Exception as exc:
        logger.warning(f"dossier: LLM summary failed for {entity['name']}: {exc}")

    # Fallback: deterministic one-liner from the top facts.
    top = entity["facts"][:4]
    if top:
        rels = "; ".join(
            f"{f['rel'].replace('_', ' ').lower()} {f['target']}" for f in top
        )
        return f"{entity['name']} ({entity['type']}). Key relationships: {rels}."
    return f"{entity['name']} ({entity['type']})."


# ── Upsert ──────────────────────────────────────────────────────────────────────

def _entity_uri(entity: dict) -> str:
    """Stable dossier key. Prefer the node's `_origin`/`_source_job` discriminator
    so two same-named entities from different sources keep distinct dossiers;
    fall back to name+type."""
    base = entity["name"]
    disc = entity.get("source_job") or "shared"
    return f"{base}|{entity['type']}|{disc}"


def _upsert_dossier(
    conn, user_id: str, *, entity_uri: str, entity_name: str,
    summary: str, key_facts: list[dict], origin_files: list[str], timeline: list[dict],
) -> str:
    """Upsert a dossier (refresh in place on rebuild). Preserves pin/heat/access
    counters across rebuilds — only the compiled content + updated_at change."""
    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO entity_dossiers
                (user_id, entity_uri, entity_name, summary, key_facts,
                 origin_files, timeline, trust, updated_at)
            VALUES (%s::uuid, %s, %s, %s, %s::jsonb, %s, %s::jsonb, %s, NOW())
            ON CONFLICT (user_id, entity_uri) DO UPDATE SET
                entity_name  = EXCLUDED.entity_name,
                summary      = EXCLUDED.summary,
                key_facts    = EXCLUDED.key_facts,
                origin_files = EXCLUDED.origin_files,
                timeline     = EXCLUDED.timeline,
                updated_at   = NOW()
            RETURNING (xmax = 0) AS inserted
            """,
            (user_id, entity_uri, entity_name, summary,
             json.dumps(key_facts), origin_files, json.dumps(timeline),
             DOSSIER_TRUST),
        )
        inserted = cur.fetchone()[0]
    return "created" if inserted else "updated"


# ── Public: compile one dossier ─────────────────────────────────────────────────

def _compile_one(driver, conn, user_id: str, entity_name: str) -> Optional[dict]:
    entity = _fetch_entity_facts(driver, user_id, entity_name)
    if entity is None:
        return None

    origin_files = _resolve_origin_files(conn, user_id, entity["source_jobs"])
    timeline = _build_timeline(entity["facts"])
    summary = _build_summary(entity, conn)
    uri = _entity_uri(entity)

    with conn:
        action = _upsert_dossier(
            conn, user_id,
            entity_uri=uri, entity_name=entity["name"], summary=summary,
            key_facts=entity["facts"], origin_files=origin_files, timeline=timeline,
        )
    return {
        "entity_uri": uri,
        "entity_name": entity["name"],
        "summary": summary,
        "key_facts": entity["facts"],
        "origin_files": origin_files,
        "timeline": timeline,
        "trust": DOSSIER_TRUST,
        "action": action,
    }


def build_dossier_for_name(user_id: str, entity_name: str) -> Optional[dict]:
    """On-demand: build/refresh the dossier for a single named entity. Returns the
    compiled dossier dict, or None if the user owns no node with that name."""
    logger.info(f"[dossier] on-demand build '{entity_name}' for user {user_id}")
    driver = _neo_driver()
    conn = _pg_connect()
    try:
        with telemetry.span("fuse.dossier", "CHAIN", {"input.value": entity_name, "user_id": user_id}):
            return _compile_one(driver, conn, user_id, entity_name)
    finally:
        driver.close()
        conn.close()


def _resolve_origin_files_scoped(conn, source_jobs: list[str], granted_jobs: set) -> list[str]:
    """Origin-file resolution for a KB-scoped build. Resolves ONLY jobs inside the
    grant (the granted set is the authorization boundary) and does NOT filter by
    user_id — the jobs belong to the KB owner, but the caller is explicitly granted
    them, so their fileName/sourceRef is in-scope. Skips any job not in the grant."""
    files: list[str] = []
    for sj in source_jobs or []:
        if str(sj) not in granted_jobs:
            continue
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT COALESCE(input->>'fileName', input->>'sourceRef', "
                    "        left(input->>'text', 60)) "
                    "FROM jobs WHERE id = %s::uuid",
                    (sj,),
                )
                row = cur.fetchone()
        except Exception:
            conn.rollback()
            continue
        if row and row[0] and row[0] not in files:
            files.append(row[0])
    return files


def build_dossier_for_name_scoped(
    user_id: str, entity_name: str, source_job_ids: list[str]
) -> Optional[dict]:
    """On-demand KB-SCOPED build: compile the dossier for `entity_name` confined to
    the caller's granted `source_job_ids`, and store it under `user_id` (the scoped
    caller — NOT the KB owner) so the colleague's confined dossier never mixes with,
    nor pollutes, the owner's cross-KB aggregate. Leak-safe by construction: the
    facts, neighbours and origin files come ONLY from the granted jobs. Returns None
    when the grant contains no node with that name."""
    logger.info(
        f"[dossier] scoped on-demand build '{entity_name}' for user {user_id} "
        f"({len(source_job_ids)} granted job(s))"
    )
    if not source_job_ids:
        return None
    granted = {str(j) for j in source_job_ids}
    driver = _neo_driver()
    conn = _pg_connect()
    try:
        with telemetry.span(
            "fuse.dossier_scoped", "CHAIN",
            {"input.value": entity_name, "user_id": user_id, "fuse.granted_jobs": len(granted)},
        ):
            entity = _fetch_entity_facts_scoped(driver, entity_name, list(granted))
        if entity is None:
            return None
        origin_files = _resolve_origin_files_scoped(conn, entity["source_jobs"], granted)
        timeline = _build_timeline(entity["facts"])
        summary = _build_summary(entity, conn)
        uri = _entity_uri(entity)
        with conn:
            action = _upsert_dossier(
                conn, user_id,
                entity_uri=uri, entity_name=entity["name"], summary=summary,
                key_facts=entity["facts"], origin_files=origin_files, timeline=timeline,
            )
        return {
            "entity_uri": uri,
            "entity_name": entity["name"],
            "summary": summary,
            "key_facts": entity["facts"],
            "origin_files": origin_files,
            "timeline": timeline,
            "trust": DOSSIER_TRUST,
            "action": action,
        }
    finally:
        driver.close()
        conn.close()


def build_top_dossiers(
    compilation_id: str, user_id: str, source_job_ids: list[str], top_n: int = 10
) -> dict:
    """Build/refresh dossiers for the top-degree ('god node') entities of a
    compilation. Called from the distill job. Returns a summary."""
    logger.info(
        f"[dossier] top-{top_n} build for comp {compilation_id} "
        f"({len(source_job_ids)} source job(s))"
    )
    driver = _neo_driver()
    conn = _pg_connect()
    created = updated = 0
    built: list[str] = []
    try:
        names = _fetch_top_entity_names(driver, source_job_ids, top_n)
        for nm in names:
            try:
                res = _compile_one(driver, conn, user_id, nm)
            except Exception as exc:
                logger.warning(f"[dossier] failed to compile '{nm}': {exc}")
                continue
            if not res:
                continue
            built.append(res["entity_name"])
            if res["action"] == "created":
                created += 1
            else:
                updated += 1
    finally:
        driver.close()
        conn.close()
    logger.info(
        f"[dossier] comp {compilation_id}: {created} created, {updated} updated "
        f"({', '.join(built[:10])})"
    )
    return {
        "dossiers_built": created + updated,
        "created": created,
        "updated": updated,
        "entities": built,
    }
