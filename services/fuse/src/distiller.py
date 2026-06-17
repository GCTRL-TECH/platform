"""
WIKI Distiller for GCTRL FUSE — a faithful Karpathy "LLM Wiki"
─────────────────────────────────────────────────────────────

Turns a RAW knowledge-graph compilation into a *living* human-readable wiki —
not just per-entity pages, but the full "bookkeeping" layer that makes it a real
wiki (Andrej Karpathy's LLM-Wiki gist):

  Three layers:  Raw (source RAW graphs) → Wiki (`wiki_pages`) → Schema (this file).

Page kinds produced
  • entity   — one page per important entity (LLM-synthesized, grounded, cited).
  • concept  — one page per major coarse-type cluster (Technology / People / …),
               summarizing its members with [[wikilinks]].
  • index    — a content catalog: EVERY page listed, by category, with one-liners,
               counts and [[wikilinks]]. Regenerated every distill.
  • log      — an APPEND-ONLY changelog. Each run appends a dated section. Old
               entries are NEVER rewritten.
  • lint     — a maintenance report (orphans, entities-without-pages, conflicts).

Cross-cutting maintenance, refreshed EVERY distill ("touch 15 files in one pass"):
  • Backlinks — each entity/concept page gets a "## Referenced by" section computed
                from the [[wikilink]] graph across all pages in this wiki.
  • Index / concept pages — regenerated wholesale (cheap, deterministic).
  • Log — appended with this run's created/updated/sources + lint summary.

Incremental rule (content_hash): entity pages are only re-synthesized by the LLM
when their underlying entity/neighbours changed. But index, backlinks and the log
ALWAYS refresh — they are the cheap cross-cutting layer.

Everything runs FULLY LOCAL against the in-container Ollama (zero cloud). The LLM
call is isolated in `_llm_complete` so cloud providers can be slotted in later via
GCTRL_DISTILL_PROVIDER / GCTRL_DISTILL_MODEL.
"""

import datetime as _dt
import hashlib
import json
import logging
import os
import re
import unicodedata
from collections import defaultdict
from typing import Optional

import psycopg2
import psycopg2.extras
import requests
from neo4j import GraphDatabase

from . import config

logger = logging.getLogger(__name__)

# ── Distiller config (env-overridable, zero-config defaults) ──────────────────
DISTILL_PROVIDER = os.environ.get("GCTRL_DISTILL_PROVIDER", "ollama")
DISTILL_MODEL = os.environ.get("GCTRL_DISTILL_MODEL", "llama3.2")
# In-container Ollama URL. FUSE shares the ollama-net network with the ollama
# container, so the service name resolves. Falls back to host.docker.internal.
OLLAMA_BASE = os.environ.get("OLLAMA_BASE", "http://ollama:11434")
QDRANT_URL = os.environ.get("QDRANT_URL", "http://qdrant:6333")
QDRANT_COLLECTION = os.environ.get("QDRANT_COLLECTION", "GCTRL_chunks")

_LLM_TIMEOUT = 120

# Reserved slugs for the bookkeeping pages — never collide with an entity slug.
INDEX_SLUG = "index"
LOG_SLUG = "log"
LINT_SLUG = "lint"

# Human-readable names for the coarse_type buckets used on concept pages.
_CONCEPT_LABELS = {
    "person": "People",
    "organization": "Organizations",
    "location": "Locations",
    "technology": "Technology",
    "work": "Works",
    "event": "Events",
    "concept": "Concepts",
    "other": "Other",
}


# ── Slug helper ───────────────────────────────────────────────────────────────

def _clean_name(name: Optional[str]) -> str:
    """Collapse internal whitespace (incl. newlines) in an entity name so
    titles, [[wikilinks]] and one-liners stay on a single line. Some source
    graphs carry names with embedded newlines (e.g. 'Axel-Cyrille Ngonga\\nNgomo')."""
    if not name:
        return ""
    return re.sub(r"\s+", " ", str(name)).strip()


def slugify(name: str) -> str:
    """Stable, URL-safe slug from an entity name (ASCII, lowercase, hyphenated)."""
    norm = unicodedata.normalize("NFKD", name or "").encode("ascii", "ignore").decode("ascii")
    norm = norm.lower().strip()
    norm = re.sub(r"[^a-z0-9]+", "-", norm).strip("-")
    return norm or "entity"


# ── Wikilink extraction ────────────────────────────────────────────────────────

_WIKILINK_RE = re.compile(r"\[\[([^\[\]|]+?)(?:\|[^\[\]]+)?\]\]")


def _extract_wikilinks(body_md: str) -> set[str]:
    """Return the set of [[Target]] link targets in a markdown body (slugified)."""
    return {slugify(m.group(1)) for m in _WIKILINK_RE.finditer(body_md or "")}


def _strip_frontmatter(body_md: str) -> str:
    """Remove a leading YAML frontmatter block (--- … ---) if present."""
    if body_md.startswith("---\n"):
        end = body_md.find("\n---\n", 4)
        if end != -1:
            return body_md[end + 5:]
    return body_md


def _strip_backlinks_section(body_md: str) -> str:
    """Remove a trailing '## Referenced by' section so it can be recomputed."""
    idx = body_md.find("\n## Referenced by")
    if idx != -1:
        return body_md[:idx].rstrip() + "\n"
    return body_md


def _frontmatter(
    *, kind: str, tags: list[str], source_count: int,
    entity_uri: Optional[str], last_distilled: str,
    core_hash: Optional[str] = None,
) -> str:
    """Render a YAML frontmatter block (Obsidian/Dataview-friendly).

    `core_hash` (entity pages only) records the hash of the LLM-synthesized core
    so the NEXT distill can decide incrementally whether to re-call the LLM —
    without re-synthesizing just to compare.
    """
    tag_str = "[" + ", ".join(tags) + "]" if tags else "[]"
    lines = [
        "---",
        f"kind: {kind}",
        f"tags: {tag_str}",
        f"source_count: {source_count}",
    ]
    if entity_uri:
        # Quote the uri (can contain spaces / special chars).
        safe = entity_uri.replace('"', "'")
        lines.append(f'entity_uri: "{safe}"')
    if core_hash:
        lines.append(f"core_hash: {core_hash}")
    lines.append(f"last_distilled: {last_distilled}")
    lines.append("---")
    return "\n".join(lines) + "\n\n"


_CORE_HASH_RE = re.compile(r"^core_hash:\s*([0-9a-f]{64})\s*$", re.MULTILINE)


def _read_core_hash(body_md: str) -> Optional[str]:
    """Pull the previously-stored entity core hash out of frontmatter, if any."""
    if not body_md.startswith("---\n"):
        return None
    end = body_md.find("\n---\n", 4)
    if end == -1:
        return None
    m = _CORE_HASH_RE.search(body_md[:end])
    return m.group(1) if m else None


# ── Classification helpers ────────────────────────────────────────────────────
#
# Compliance rule for distilled pages (see migration 053): a synthesized page may
# weave facts from several source documents/entities, so it must be gated at the
# MOST-RESTRICTIVE (highest) rank of anything that flowed into it. This is the
# OPPOSITE of a graph node's `_min_rank`, which stores the most-PERMISSIVE rank for
# read filtering. We therefore use `_label_ranks` (the list of every contributing
# rank) and take its MAX — never the permissive `_min_rank` floor, which would
# under-classify a page distilled from a confidential chunk and leak it.

def _restrictive_rank(label_ranks, min_rank) -> int:
    """Most-restrictive (highest) classification rank for a node, from its
    `_label_ranks` list. Falls back to `_min_rank`, then 0 (PUBLIC)."""
    try:
        ranks = [int(r) for r in (label_ranks or []) if r is not None]
    except (TypeError, ValueError):
        ranks = []
    if ranks:
        return max(ranks)
    if min_rank is not None:
        try:
            return int(min_rank)
        except (TypeError, ValueError):
            return 0
    return 0


def _norm_labels(labels) -> list[str]:
    """Normalize a Neo4j `_class_labels` value (list of JSON-encoded provenance
    strings, or None) into a clean list of strings."""
    if not labels:
        return []
    return [str(x) for x in labels if x]


# ── Neo4j: entities + 1-hop neighbours for the RAW comp's source jobs ─────────

def _fetch_entities_with_neighbors(
    driver, source_job_ids: list[str], limit: int
) -> list[dict]:
    """Return up to `limit` entities (highest degree first), each with its 1-hop
    neighbours. Each item: {name, type, coarse_type, conflict, min_rank,
    class_labels, neighbors:[...]}.

    Scoped to the RAW comp's source jobs via `_source_job`. Skips the structural
    CONTAINS/SIMILAR_TO edges so neighbours are real domain relationships.

    `min_rank` is the page's compliance gate: the MOST-RESTRICTIVE rank over the
    entity AND every neighbour it mentions (a page that names a confidential
    neighbour must itself be confidential). `class_labels` is the union of the
    contributing provenance labels.
    """
    query = """
    MATCH (e:Entity)
    WHERE e._source_job IN $job_ids
    OPTIONAL MATCH (e)-[r]-(n:Entity)
      WHERE NOT type(r) IN ['CONTAINS', 'SIMILAR_TO']
            AND n._source_job IN $job_ids
    WITH e, count(DISTINCT n) AS degree,
         collect(DISTINCT {name: n.name, type: n.type, rel: type(r),
                           label_ranks: n._label_ranks, min_rank: n._min_rank,
                           class_labels: n._class_labels})[..12] AS neighbors
    RETURN e.name AS name, e.type AS type,
           e.coarse_type AS coarse_type, e._class_conflict AS conflict,
           e._label_ranks AS label_ranks, e._min_rank AS min_rank,
           e._class_labels AS class_labels,
           degree, neighbors
    ORDER BY degree DESC, name ASC
    LIMIT $limit
    """
    out: list[dict] = []
    with driver.session() as session:
        result = session.run(query, job_ids=source_job_ids, limit=limit)
        for rec in result:
            name = _clean_name(rec["name"])
            if not name:
                continue
            raw_neighbors = [n for n in (rec["neighbors"] or []) if n and n.get("name")]
            neighbors = [
                {"name": _clean_name(n.get("name")), "type": n.get("type"), "rel": n.get("rel")}
                for n in raw_neighbors
            ]
            # Page gate = max over entity + every neighbour it names.
            rank = _restrictive_rank(rec["label_ranks"], rec["min_rank"])
            labels = set(_norm_labels(rec["class_labels"]))
            for n in raw_neighbors:
                rank = max(rank, _restrictive_rank(n.get("label_ranks"), n.get("min_rank")))
                labels.update(_norm_labels(n.get("class_labels")))
            out.append({
                "name": name,
                "type": rec["type"] or "entity",
                "coarse_type": (rec["coarse_type"] or rec["type"] or "other"),
                "conflict": bool(rec["conflict"]),
                "degree": rec["degree"] or 0,
                "min_rank": rank,
                "class_labels": sorted(labels),
                "neighbors": neighbors,
            })
    return out


def _count_source_entities(driver, source_job_ids: list[str]) -> int:
    """Total distinct entities in the source graph (for the lint 'no page yet' count)."""
    query = (
        "MATCH (e:Entity) WHERE e._source_job IN $job_ids "
        "RETURN count(DISTINCT e.name) AS c"
    )
    with driver.session() as session:
        rec = session.run(query, job_ids=source_job_ids).single()
        return int(rec["c"]) if rec and rec["c"] is not None else 0


# ── Qdrant: grounding chunks for an entity (REST scroll, no embedding) ─────────

def _fetch_grounding_chunks(
    source_job_ids: list[str], entity_name: str, max_chunks: int = 3
) -> list[dict]:
    """Fetch up to `max_chunks` chunks that mention the entity, scoped to the RAW
    comp's source jobs. Uses Qdrant's scroll API with a job_id filter + a text
    substring match (case-insensitive) — no embedding needed.

    Returns [{chunkId, source, text_snippet, min_rank, class_labels}]. The chunk
    `min_rank` (its source document's classification) gates any page that cites it.
    """
    body = {
        "filter": {
            "must": [
                {"key": "job_id", "match": {"any": source_job_ids}},
            ]
        },
        "limit": 64,
        "with_payload": True,
        "with_vector": False,
    }
    try:
        resp = requests.post(
            f"{QDRANT_URL}/collections/{QDRANT_COLLECTION}/points/scroll",
            json=body,
            timeout=15,
        )
        resp.raise_for_status()
        points = resp.json().get("result", {}).get("points", [])
    except Exception as exc:
        logger.warning(f"distill: Qdrant scroll failed for '{entity_name}': {exc}")
        return []

    needle = entity_name.lower()
    matches: list[dict] = []
    for p in points:
        payload = p.get("payload") or {}
        text = payload.get("text") or ""
        if needle and needle in text.lower():
            snippet = text.strip()
            if len(snippet) > 400:
                snippet = snippet[:400].rsplit(" ", 1)[0] + "…"
            chunk_rank = payload.get("min_rank")
            try:
                chunk_rank = int(chunk_rank) if chunk_rank is not None else 0
            except (TypeError, ValueError):
                chunk_rank = 0
            matches.append({
                "chunkId": str(p.get("id", "")),
                "source": payload.get("source_document_id") or payload.get("job_id") or "",
                "text_snippet": snippet,
                "min_rank": chunk_rank,
                "class_labels": _norm_labels(payload.get("class_labels")),
            })
            if len(matches) >= max_chunks:
                break
    return matches


# ── LLM call (isolated so cloud providers can be slotted in) ──────────────────

def _llm_complete(
    prompt: str, model: Optional[str] = None, ollama_base: Optional[str] = None
) -> str:
    """Single completion. Default path = local Ollama /api/generate (zero config).

    `DISTILL_PROVIDER` selects the backend; only 'ollama' is implemented,
    but the structure keeps the call site clean for adding openai/nim later.

    `model` / `ollama_base` are optional per-job overrides (the owner's
    Settings → AI Models distill model + Settings → Infrastructure Ollama base);
    empty/None falls back to the env defaults so the default install is unchanged.
    """
    distill_model = (model or "").strip() or DISTILL_MODEL
    base = (ollama_base or "").strip() or OLLAMA_BASE
    provider = DISTILL_PROVIDER.lower()
    if provider == "ollama":
        resp = requests.post(
            f"{base.rstrip('/')}/api/generate",
            json={"model": distill_model, "prompt": prompt, "stream": False},
            timeout=_LLM_TIMEOUT,
            # SSRF hardening: don't follow redirects to a metadata endpoint.
            allow_redirects=False,
        )
        resp.raise_for_status()
        return (resp.json().get("response") or "").strip()
    # Future: openai / nim via OpenAI-compatible /v1/chat/completions.
    raise RuntimeError(f"distill: unsupported GCTRL_DISTILL_PROVIDER '{DISTILL_PROVIDER}'")


def _build_prompt(entity: dict, citations: list[dict]) -> str:
    neighbors = entity.get("neighbors", [])
    neighbor_lines = "\n".join(
        f"- {n['name']} ({n.get('type') or 'entity'}) via relationship {n.get('rel') or 'related_to'}"
        for n in neighbors
    ) or "- (no recorded relationships)"
    snippet_lines = "\n".join(
        f"[{i + 1}] {c['text_snippet']}" for i, c in enumerate(citations)
    ) or "(no source snippets available)"

    return (
        f"Write a concise wiki page in Markdown for the entity «{entity['name']}» "
        f"(type: {entity['type']}).\n\n"
        "Use ONLY the facts below — do not invent information. Keep it factual and brief "
        "(2-4 short paragraphs). When you mention a related entity that appears in the "
        "neighbours list, link it as [[Entity Name]]. End the page with a '## Sources' "
        "section listing the numbered source snippets you used (e.g. '[1] ...'). "
        "If the sources conflict, add a line '> ⚠ Sources disagree' near the relevant claim.\n\n"
        f"## Facts\n\nRelated entities (neighbours):\n{neighbor_lines}\n\n"
        f"Source snippets:\n{snippet_lines}\n\n"
        f"Now write the wiki page for «{entity['name']}». Start with a '# {entity['name']}' heading."
    )


# ── Postgres helpers ──────────────────────────────────────────────────────────

def _pg_connect():
    return psycopg2.connect(config.PG_URL, connect_timeout=5)


def _resolve_wiki_source(conn, compilation_id: str) -> tuple[list[str], list[str]]:
    """Return (source_compilation_ids, source_job_ids) for a WIKI compilation.

    A WIKI may distil from MULTIPLE RAW source graphs. Sources come from the
    `wiki_sources` link table; the legacy single column `wiki_source_compilation_id`
    is folded in as a fallback so older/single-source wikis keep working. The
    returned `source_job_ids` is the UNION of every selected source comp's
    `source_job_ids`, deduplicated.

    Raises ValueError if the compilation isn't a WIKI. A WIKI with no selected
    source is NOT an error — it yields empty lists and the caller writes 0 pages
    (this is the default-seeded "Knowledge Wiki" before the user picks sources).
    """
    with conn.cursor() as cur:
        cur.execute(
            "SELECT type::text, wiki_source_compilation_id FROM compilations WHERE id = %s",
            (compilation_id,),
        )
        row = cur.fetchone()
        if not row:
            raise ValueError(f"compilation {compilation_id} not found")
        comp_type, legacy_source_id = row
        if comp_type != "WIKI":
            raise ValueError(f"compilation {compilation_id} is type {comp_type}, not WIKI")

        cur.execute(
            "SELECT source_compilation_id::text FROM wiki_sources WHERE wiki_compilation_id = %s",
            (compilation_id,),
        )
        source_ids = [r[0] for r in cur.fetchall() if r and r[0]]
        if legacy_source_id and str(legacy_source_id) not in source_ids:
            source_ids.append(str(legacy_source_id))

        if not source_ids:
            return [], []

        cur.execute(
            "SELECT array_to_string("
            "  COALESCE("
            "    array_agg(DISTINCT j) FILTER (WHERE j IS NOT NULL),"
            "    '{}'::uuid[]"
            "  ), ',') "
            "FROM compilations c, LATERAL unnest(COALESCE(c.source_job_ids, '{}'::uuid[])) AS j "
            "WHERE c.id = ANY(%s::uuid[])",
            (source_ids,),
        )
        src_row = cur.fetchone()
        raw = (src_row[0] if src_row else "") or ""
        source_job_ids = [s for s in (raw.split(",") if raw else []) if s]
    return source_ids, source_job_ids


def _upsert_page(
    conn,
    compilation_id: str,
    *,
    slug: str,
    kind: str,
    entity_uri: Optional[str],
    title: str,
    body_md: str,
    citations: list[dict],
    content_hash: str,
    min_rank: int = 0,
    class_labels: Optional[list[str]] = None,
) -> str:
    """Upsert one wiki page. Bumps `version` only when content_hash changed.
    Returns the action taken: 'created' | 'updated' | 'unchanged'.

    `min_rank`/`class_labels` are the page's compliance gate — always written
    (even on 'unchanged') so a re-classification from the source graph takes
    effect without forcing a body re-synthesis.
    """
    labels = class_labels or []
    with conn.cursor() as cur:
        cur.execute(
            "SELECT content_hash FROM wiki_pages WHERE compilation_id = %s AND slug = %s",
            (compilation_id, slug),
        )
        existing = cur.fetchone()
        if existing is None:
            cur.execute(
                """
                INSERT INTO wiki_pages
                    (compilation_id, kind, slug, title, entity_uri, body_md,
                     citations, content_hash, version, last_distilled_at,
                     min_rank, class_labels)
                VALUES (%s, %s, %s, %s, %s, %s, %s::jsonb, %s, 1, NOW(), %s, %s)
                """,
                (compilation_id, kind, slug, title, entity_uri, body_md,
                 json.dumps(citations), content_hash, min_rank, labels),
            )
            return "created"
        if existing[0] == content_hash:
            # Body unchanged — still refresh classification (cheap, keeps the gate
            # current if the source graph was re-classified) + the distill stamp.
            cur.execute(
                "UPDATE wiki_pages SET last_distilled_at = NOW(), min_rank = %s, "
                "class_labels = %s WHERE compilation_id = %s AND slug = %s",
                (min_rank, labels, compilation_id, slug),
            )
            return "unchanged"
        cur.execute(
            """
            UPDATE wiki_pages
               SET title = %s, kind = %s, entity_uri = %s, body_md = %s,
                   citations = %s::jsonb, content_hash = %s,
                   version = version + 1, last_distilled_at = NOW(),
                   min_rank = %s, class_labels = %s
             WHERE compilation_id = %s AND slug = %s
            """,
            (title, kind, entity_uri, body_md, json.dumps(citations),
             content_hash, min_rank, labels, compilation_id, slug),
        )
        return "updated"


def _content_hash(entity: dict, citations: list[dict]) -> str:
    """sha256 of name + sorted neighbour names + sorted chunk ids. Stable across
    runs so unchanged entities don't bump version or trigger a needless re-write."""
    neighbor_names = sorted(n["name"] for n in entity.get("neighbors", []) if n.get("name"))
    chunk_ids = sorted(c["chunkId"] for c in citations if c.get("chunkId"))
    basis = entity["name"] + "|" + "|".join(neighbor_names) + "|" + "|".join(chunk_ids)
    return hashlib.sha256(basis.encode("utf-8")).hexdigest()


# ── Public entry point ────────────────────────────────────────────────────────

def distill(
    compilation_id: str,
    user_id: str,
    limit: int = 15,
    model: Optional[str] = None,
    ollama_base: Optional[str] = None,
) -> dict:
    """Distil a WIKI compilation into a faithful living wiki.

    Pipeline:
      1. entity pages (incremental — only re-synthesized when content_hash changed)
      2. concept pages (one per coarse_type cluster) — regenerated wholesale
      3. backlinks ("## Referenced by") on every entity/concept page — recomputed
      4. index page — regenerated wholesale
      5. lint pass (orphans / entities-without-pages / conflicts)
      6. log page — APPEND a dated entry with this run's summary + lint

    Returns {pages_written, pages_created, pages_updated, pages_unchanged,
             compilation_id, source_compilation_ids, entities_considered, lint}.
    """
    logger.info(f"[distill {compilation_id}] start (limit={limit}, user={user_id})")
    today = _dt.date.today().isoformat()
    now_iso = _dt.datetime.now(_dt.timezone.utc).isoformat(timespec="seconds")

    conn = _pg_connect()
    try:
        source_compilation_ids, source_job_ids = _resolve_wiki_source(conn, compilation_id)
    except Exception:
        conn.close()
        raise

    if not source_job_ids:
        logger.info(
            f"[distill {compilation_id}] no source jobs "
            f"(sources={source_compilation_ids or 'none'}) — writing 0 pages"
        )
        with conn:
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE compilations SET last_distill_at = NOW() WHERE id = %s",
                    (compilation_id,),
                )
        conn.close()
        return {
            "pages_written": 0, "pages_created": 0, "pages_updated": 0,
            "pages_unchanged": 0, "compilation_id": compilation_id,
            "source_compilation_ids": source_compilation_ids,
            "entities_considered": 0, "lint": {},
        }

    driver = GraphDatabase.driver(
        config.NEO4J_URI, auth=(config.NEO4J_USER, config.NEO4J_PASSWORD)
    )
    try:
        entities = _fetch_entities_with_neighbors(driver, source_job_ids, limit)
        total_source_entities = _count_source_entities(driver, source_job_ids)
        logger.info(
            f"[distill {compilation_id}] {len(entities)} entities selected from "
            f"{len(source_job_ids)} source job(s) ({total_source_entities} total in graph)"
        )

        src_count = len(source_compilation_ids)

        # ── 1. Entity pages (incremental) ────────────────────────────────────
        created = updated = unchanged = 0
        # Track per-entity metadata so concept/index/backlink passes can reuse it.
        # slug → {title, slug, coarse, kind, one_liner}
        page_meta: dict[str, dict] = {}
        created_titles: list[str] = []
        updated_titles: list[str] = []

        for ent in entities:
            citations = _fetch_grounding_chunks(source_job_ids, ent["name"])
            chash = _content_hash(ent, citations)
            slug = slugify(ent["name"])
            entity_uri = f"{ent['name']}_{ent['type']}_{compilation_id}"

            # Incremental: read the stored body ONCE. If its recorded core_hash
            # matches the freshly-computed entity hash, the entity/neighbours/
            # chunks are unchanged → reuse the stored LLM core, SKIP the LLM call.
            # Only the cross-cutting layers (frontmatter, backlinks) get refreshed.
            prior_body = _read_stored_body(conn, compilation_id, slug)
            prior_core_hash = _read_core_hash(prior_body) if prior_body else None
            if prior_body is not None and prior_core_hash == chash:
                core = _strip_backlinks_section(_strip_frontmatter(prior_body)).rstrip() + "\n"
            else:
                try:
                    core = _llm_complete(
                        _build_prompt(ent, citations), model=model, ollama_base=ollama_base
                    )
                except Exception as exc:
                    logger.warning(f"[distill {compilation_id}] LLM failed for '{ent['name']}': {exc}")
                    core = _fallback_body(ent, citations)

            # Compliance gate: most-restrictive over the entity (+ neighbours) and
            # every grounding chunk actually cited in this page.
            page_rank = ent.get("min_rank", 0)
            page_labels = set(ent.get("class_labels") or [])
            for c in citations:
                page_rank = max(page_rank, int(c.get("min_rank") or 0))
                page_labels.update(c.get("class_labels") or [])

            page_meta[slug] = {
                "slug": slug, "title": ent["name"], "kind": "entity",
                "coarse": ent["coarse_type"], "one_liner": _one_liner(core, ent),
                "core": core, "entity_uri": entity_uri, "citations": citations,
                "content_hash": chash, "conflict": ent["conflict"],
                "links": _extract_wikilinks(core),
                "min_rank": page_rank, "class_labels": sorted(page_labels),
            }

        # ── 2. Concept pages (one per coarse_type cluster) ───────────────────
        by_coarse = defaultdict(list)  # untyped (Cython rejects defaultdict-as-dict)
        for meta in page_meta.values():
            by_coarse[meta["coarse"]].append(meta)
        concept_meta: dict[str, dict] = {}
        for coarse, members in sorted(by_coarse.items()):
            if len(members) < 1:
                continue
            label = _CONCEPT_LABELS.get(coarse, coarse.title())
            cslug = "concept-" + slugify(label)
            core = _build_concept_body(label, coarse, members)
            # A concept page names all its members, so it inherits their most-
            # restrictive rank + the union of their labels.
            c_rank = max((m.get("min_rank", 0) for m in members), default=0)
            c_labels = sorted({l for m in members for l in (m.get("class_labels") or [])})
            concept_meta[cslug] = {
                "slug": cslug, "title": label, "kind": "concept",
                "coarse": coarse, "one_liner": f"{len(members)} {label.lower()} in this wiki.",
                "core": core, "entity_uri": None, "citations": [],
                "links": _extract_wikilinks(core),
                "min_rank": c_rank, "class_labels": c_labels,
            }

        # ── 3. Backlinks: invert the [[wikilink]] graph across all pages ─────
        all_meta = {**page_meta, **concept_meta}
        backlinks = defaultdict(list)  # untyped (Cython rejects defaultdict-as-dict)
        for src_slug, meta in all_meta.items():
            for target_slug in meta["links"]:
                if target_slug in all_meta and target_slug != src_slug:
                    backlinks[target_slug].append(meta["title"])

        # ── 5(prep). Lint pass ───────────────────────────────────────────────
        # Orphans: pages with no inbound wikilinks (excluding bookkeeping pages).
        orphans = sorted(
            m["title"] for s, m in all_meta.items() if not backlinks.get(s)
        )
        entities_without_pages = max(0, total_source_entities - len(page_meta))
        conflicts = sorted(m["title"] for m in page_meta.values() if m.get("conflict"))
        lint = {
            "orphans": orphans,
            "entities_without_pages": entities_without_pages,
            "conflicts": conflicts,
            "pages_total": len(all_meta),
        }

        # ── Assemble + upsert entity & concept pages (with frontmatter+backlinks)
        def _assemble(meta: dict) -> str:
            fm = _frontmatter(
                kind=meta["kind"],
                tags=[meta["kind"], meta["coarse"]],
                source_count=src_count,
                entity_uri=meta.get("entity_uri"),
                last_distilled=now_iso,
                core_hash=meta.get("content_hash"),
            )
            body = _strip_backlinks_section(_strip_frontmatter(meta["core"]).rstrip())
            bl = backlinks.get(meta["slug"], [])
            if bl:
                uniq = sorted(set(bl))
                bl_md = "\n## Referenced by\n\n" + "\n".join(f"- [[{t}]]" for t in uniq) + "\n"
            else:
                bl_md = "\n## Referenced by\n\n_No pages link here yet (orphan)._\n"
            return fm + body.rstrip() + "\n" + bl_md

        for slug, meta in page_meta.items():
            body_md = _assemble(meta)
            # content_hash for storage = entity core hash + backlink fingerprint,
            # so a backlink change bumps the page even if the core is unchanged.
            store_hash = hashlib.sha256(
                (meta["content_hash"] + "|bl:" + "|".join(sorted(set(backlinks.get(slug, []))))
                 ).encode("utf-8")
            ).hexdigest()
            with conn:
                action = _upsert_page(
                    conn, compilation_id,
                    slug=slug, kind="entity", entity_uri=meta["entity_uri"],
                    title=meta["title"], body_md=body_md,
                    citations=meta["citations"], content_hash=store_hash,
                    min_rank=meta.get("min_rank", 0),
                    class_labels=meta.get("class_labels"),
                )
            if action == "created":
                created += 1
                created_titles.append(meta["title"])
            elif action == "updated":
                updated += 1
                updated_titles.append(meta["title"])
            else:
                unchanged += 1

        for slug, meta in concept_meta.items():
            body_md = _assemble(meta)
            chash = hashlib.sha256(body_md.encode("utf-8")).hexdigest()
            with conn:
                _upsert_page(
                    conn, compilation_id,
                    slug=slug, kind="concept", entity_uri=None,
                    title=meta["title"], body_md=body_md,
                    citations=[], content_hash=chash,
                    min_rank=meta.get("min_rank", 0),
                    class_labels=meta.get("class_labels"),
                )

        # Bookkeeping pages (index/lint/log) enumerate EVERY content page's title,
        # so they leak the existence of classified pages unless gated at the
        # most-restrictive rank across the whole wiki. The per-viewer navigation
        # is the clearance-filtered left-pane list (list_wiki_pages), not these.
        wiki_max_rank = max(
            (m.get("min_rank", 0) for m in {**page_meta, **concept_meta}.values()),
            default=0,
        )
        wiki_all_labels = sorted({
            l for m in {**page_meta, **concept_meta}.values()
            for l in (m.get("class_labels") or [])
        })

        # ── 4. Index page (regenerated wholesale) ────────────────────────────
        index_body = _build_index_body(
            now_iso, src_count, page_meta, concept_meta, lint
        )
        with conn:
            _upsert_page(
                conn, compilation_id,
                slug=INDEX_SLUG, kind="index", entity_uri=None,
                title="Index", body_md=index_body, citations=[],
                content_hash=hashlib.sha256(index_body.encode("utf-8")).hexdigest(),
                min_rank=wiki_max_rank, class_labels=wiki_all_labels,
            )

        # ── 5. Lint page (regenerated wholesale) ─────────────────────────────
        lint_body = _build_lint_body(now_iso, src_count, lint)
        with conn:
            _upsert_page(
                conn, compilation_id,
                slug=LINT_SLUG, kind="lint", entity_uri=None,
                title="Lint Report", body_md=lint_body, citations=[],
                content_hash=hashlib.sha256(lint_body.encode("utf-8")).hexdigest(),
                min_rank=wiki_max_rank, class_labels=wiki_all_labels,
            )

        # ── 6. Log page (APPEND-ONLY) ────────────────────────────────────────
        _append_log(
            conn, compilation_id, today, src_count, now_iso,
            created=created, updated=updated, unchanged=unchanged,
            created_titles=created_titles, updated_titles=updated_titles,
            source_compilation_ids=source_compilation_ids, lint=lint,
            min_rank=wiki_max_rank, class_labels=wiki_all_labels,
        )

        # Update the WIKI comp's page_count + last_distill_at (total live pages).
        with conn:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT count(*) FROM wiki_pages WHERE compilation_id = %s",
                    (compilation_id,),
                )
                total_pages = cur.fetchone()[0]
                cur.execute(
                    "UPDATE compilations SET page_count = %s, last_distill_at = NOW() WHERE id = %s",
                    (total_pages, compilation_id),
                )

        pages_written = created + updated + unchanged
        logger.info(
            f"[distill {compilation_id}] done: entity written={pages_written} "
            f"(created={created}, updated={updated}, unchanged={unchanged}); "
            f"concepts={len(concept_meta)}; total_pages={total_pages}; "
            f"lint(orphans={len(orphans)}, no_page={entities_without_pages}, conflicts={len(conflicts)})"
        )

        # ── A2: refresh dossiers for the top-degree ('god node') source entities.
        # Distilling a WIKI/source also refreshes the HOT memory tier for its most
        # important entities. Best-effort — a dossier failure never fails distill.
        dossiers: dict = {}
        try:
            from . import dossier as _dossier
            dossiers = _dossier.build_top_dossiers(
                compilation_id, user_id, source_job_ids, top_n=min(limit, 10)
            )
        except Exception as exc:
            logger.warning(f"[distill {compilation_id}] dossier refresh failed: {exc}")

        return {
            "pages_written": pages_written,
            "pages_created": created,
            "pages_updated": updated,
            "pages_unchanged": unchanged,
            "concept_pages": len(concept_meta),
            "compilation_id": compilation_id,
            "source_compilation_ids": source_compilation_ids,
            "entities_considered": len(entities),
            "lint": lint,
            "dossiers": dossiers,
        }
    finally:
        driver.close()
        conn.close()


# ── Body builders ──────────────────────────────────────────────────────────────

def _read_stored_body(conn, compilation_id: str, slug: str) -> Optional[str]:
    """Read back the full stored body_md for a slug, or None if the page is absent."""
    with conn.cursor() as cur:
        cur.execute(
            "SELECT body_md FROM wiki_pages WHERE compilation_id = %s AND slug = %s",
            (compilation_id, slug),
        )
        row = cur.fetchone()
    if not row or not row[0]:
        return None
    return row[0]


def _fallback_body(ent: dict, citations: list[dict]) -> str:
    neigh = ", ".join(f"[[{n['name']}]]" for n in ent["neighbors"][:8]) or "—"
    return (
        f"# {ent['name']}\n\n"
        f"**Type:** {ent['type']}\n\n"
        f"Related entities: {neigh}\n\n"
        f"## Sources\n\n"
        + ("\n".join(f"[{i + 1}] {c['text_snippet']}" for i, c in enumerate(citations))
           or "_No source snippets available._")
    )


def _one_liner(core: str, ent: dict) -> str:
    """Derive a one-line description for the index from the page body's first
    sentence after the heading; fall back to type + top neighbours."""
    body = _strip_frontmatter(core)
    for line in body.splitlines():
        s = line.strip()
        if not s or s.startswith("#") or s.startswith(">") or s.startswith("["):
            continue
        # First real prose line — trim to one sentence / ~140 chars.
        s = re.sub(r"\[\[([^\]|]+)(?:\|[^\]]+)?\]\]", r"\1", s)  # de-link
        s = re.sub(r"[*_`]", "", s)
        sentence = re.split(r"(?<=[.!?])\s", s)[0]
        if len(sentence) > 140:
            sentence = sentence[:140].rsplit(" ", 1)[0] + "…"
        if sentence:
            return sentence
    neigh = ", ".join(n["name"] for n in ent.get("neighbors", [])[:3])
    return f"{ent['type'].title()}" + (f" — related to {neigh}" if neigh else "")


def _build_concept_body(label: str, coarse: str, members: list[dict]) -> str:
    """Concept page: summarizes one coarse-type cluster with [[wikilinks]]."""
    lines = [f"# {label}", "",
             f"This page groups the **{len(members)}** {label.lower()} "
             f"distilled in this wiki (coarse type `{coarse}`).", ""]
    lines.append("## Members\n")
    for m in sorted(members, key=lambda x: x["title"].lower()):
        lines.append(f"- [[{m['title']}]] — {m['one_liner']}")
    lines.append("")
    return "\n".join(lines) + "\n"


def _build_index_body(
    now_iso: str, src_count: int,
    page_meta: dict, concept_meta: dict, lint: dict,
) -> str:
    """The content catalog: every page by category, with one-liners + counts."""
    fm = _frontmatter(kind="index", tags=["index"], source_count=src_count,
                      entity_uri=None, last_distilled=now_iso)
    lines = ["# Index", "",
             f"Content catalog for this wiki — **{lint['pages_total']}** "
             f"content pages across {src_count} source graph(s). "
             "Regenerated on every distill.", ""]

    # Overview / bookkeeping section.
    lines.append("## Overview\n")
    lines.append("- [[Index]] — this content catalog")
    lines.append("- [[Changelog]] — append-only distill history (`log`)")
    lines.append("- [[Lint Report]] — orphans, missing pages, conflicts (`lint`)")
    lines.append("")

    # Concepts.
    if concept_meta:
        lines.append(f"## Concepts ({len(concept_meta)})\n")
        for m in sorted(concept_meta.values(), key=lambda x: x["title"].lower()):
            lines.append(f"- [[{m['title']}]] — {m['one_liner']}")
        lines.append("")

    # Entities, grouped by coarse type.
    by_coarse = defaultdict(list)  # untyped (Cython rejects defaultdict-as-dict)
    for m in page_meta.values():
        by_coarse[m["coarse"]].append(m)
    lines.append(f"## Entities ({len(page_meta)})\n")
    for coarse in sorted(by_coarse):
        label = _CONCEPT_LABELS.get(coarse, coarse.title())
        members = sorted(by_coarse[coarse], key=lambda x: x["title"].lower())
        lines.append(f"### {label} ({len(members)})\n")
        for m in members:
            lines.append(f"- [[{m['title']}]] — {m['one_liner']}")
        lines.append("")
    return fm + "\n".join(lines) + "\n"


def _build_lint_body(now_iso: str, src_count: int, lint: dict) -> str:
    fm = _frontmatter(kind="lint", tags=["lint"], source_count=src_count,
                      entity_uri=None, last_distilled=now_iso)
    lines = ["# Lint Report", "",
             "Lightweight maintenance pass. Contradictions are **preserved**, "
             "not auto-resolved.", ""]
    lines.append(f"- **Orphan pages** (no inbound links): {len(lint['orphans'])}")
    for t in lint["orphans"]:
        lines.append(f"  - [[{t}]]")
    lines.append(f"- **Entities with no page yet** (capped by distill limit): "
                 f"{lint['entities_without_pages']}")
    lines.append(f"- **Class conflicts** (⚠ sources disagree): {len(lint['conflicts'])}")
    for t in lint["conflicts"]:
        lines.append(f"  - [[{t}]] — ⚠ sources disagree on its class")
    lines.append("")
    return fm + "\n".join(lines) + "\n"


def _lint_summary_line(lint: dict) -> str:
    return (f"orphans={len(lint['orphans'])}, "
            f"entities_without_pages={lint['entities_without_pages']}, "
            f"conflicts={len(lint['conflicts'])}")


def _append_log(
    conn, compilation_id: str, today: str, src_count: int, now_iso: str,
    *, created: int, updated: int, unchanged: int,
    created_titles: list[str], updated_titles: list[str],
    source_compilation_ids: list[str], lint: dict,
    min_rank: int = 0, class_labels: Optional[list[str]] = None,
) -> None:
    """APPEND a dated entry to the `log` page. Never rewrites prior entries.

    The page body is frontmatter + a stable header + a growing list of dated
    sections. We read the existing body, strip its frontmatter, and re-emit
    fresh frontmatter (last_distilled bumps) followed by the UNCHANGED prior log
    sections + the new section appended at the END.
    """
    with conn.cursor() as cur:
        cur.execute(
            "SELECT body_md FROM wiki_pages WHERE compilation_id = %s AND slug = %s",
            (compilation_id, LOG_SLUG),
        )
        row = cur.fetchone()

    header = "# Changelog\n\nAppend-only distill history. Newest entries at the bottom.\n"
    if row and row[0]:
        prior = _strip_frontmatter(row[0])
        # Drop the leading header line block; keep everything from the first
        # dated section onward so prior entries are byte-preserved.
        m = re.search(r"^## \[", prior, flags=re.MULTILINE)
        prior_entries = prior[m.start():].rstrip() + "\n" if m else ""
    else:
        prior_entries = ""

    new_entry_lines = [
        f"## [{today}] distill | {created} pages created, {updated} updated",
        "",
        f"- sources distilled: {len(source_compilation_ids)} graph(s) "
        f"({', '.join(source_compilation_ids) if source_compilation_ids else 'none'})",
        f"- entity pages: {created} created, {updated} updated, {unchanged} unchanged",
    ]
    if created_titles:
        new_entry_lines.append("- created: " + ", ".join(f"[[{t}]]" for t in created_titles[:20]))
    if updated_titles:
        new_entry_lines.append("- updated: " + ", ".join(f"[[{t}]]" for t in updated_titles[:20]))
    new_entry_lines.append(f"- lint: {_lint_summary_line(lint)}")
    new_entry_lines.append(f"- run at: {now_iso}")
    new_entry = "\n".join(new_entry_lines) + "\n"

    fm = _frontmatter(kind="log", tags=["log"], source_count=src_count,
                      entity_uri=None, last_distilled=now_iso)
    body_md = fm + header + "\n" + (prior_entries + "\n" if prior_entries else "") + new_entry

    # Hash must always differ (append), so include now_iso — guarantees a new
    # version every run and that the append is persisted.
    chash = hashlib.sha256(body_md.encode("utf-8")).hexdigest()
    with conn:
        _upsert_page(
            conn, compilation_id,
            slug=LOG_SLUG, kind="log", entity_uri=None,
            title="Changelog", body_md=body_md, citations=[],
            content_hash=chash,
            min_rank=min_rank, class_labels=class_labels,
        )
