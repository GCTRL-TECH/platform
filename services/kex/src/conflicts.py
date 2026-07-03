"""
P3 — Fact-conflict detection + recency authority.

Answers the customer's core pain: "10 files talk about the same thing — which
is current?". A FUNCTIONAL relation (relation_registry, seeded in migration
061) is expected to carry exactly ONE current value per key entity — e.g. an
organization has one CEO. The KEX relation writer MERGEs edges by the FULL
triple (head, rel_type, tail), so a conflicting fact (same head+rel, DIFFERENT
tail) never overwrites — it lands as a SEPARATE sibling edge. Detection is
therefore a sibling-edge query: same key-side node, same relation type,
different other end, all owned by the same user.

When siblings exist, edges are ranked by RECENCY AUTHORITY:

    _source_doc_modified_at DESC   (the source document's own modified time)
    -> asserted_at DESC            (when a job last asserted the edge)
    -> dossier trust DESC          (entity_dossiers.trust of the value entity)
    -> confidence DESC             (extractor confidence, final tiebreak)

The winner edge gets `_authority: "current"`; losers get `_authority:
"superseded"` + `_superseded_by_doc: <winner's source doc>`. A row is upserted
into `fact_conflicts` keyed UNIQUE(user_id, relation, key_uri) with the tails
JSONB rebuilt from ALL current siblings — re-running detection updates
rankings in place, never duplicates.

FAIL-SAFE CONTRACT: every public entry point catches and logs; a conflict-
detection failure must NEVER fail the extraction or merge job that invoked it.

NOTE — this file is MIRRORED between services/kex/src/conflicts.py and
services/fuse/src/conflicts.py (the services are separate deployables; same
precedent as llm_client.py). Keep both copies IDENTICAL.

CYTHON NOTE: the prod build is Cython-compiled, where dict/list/set
annotations enforce exact-type checks that reject subclasses. Locals and
params in this module are deliberately unannotated.
"""

import json
import logging
import re

logger = logging.getLogger(__name__)


def safe_rel_type(relation_type):
    """Sanitise an arbitrary relation label to a valid Neo4j relationship type.
    Mirrors kg_builder._safe_rel_type so registry names (ceo_of) match the
    edge types actually written (CEO_OF)."""
    upper = str(relation_type or "").upper()
    safe = re.sub(r"[^A-Z0-9]+", "_", upper).strip("_")
    if not safe:
        safe = "RELATED_TO"
    if safe[0].isdigit():
        safe = "REL_" + safe
    return safe


def load_functional_relations(pg_url):
    """Load the enabled functional relations from relation_registry (Postgres).

    Returns a list of specs: {relation, rel_type, key_side, key_type}.
    Fail-safe: any error (PG down, table missing pre-migration) returns []
    so detection silently no-ops instead of failing the job.
    """
    try:
        import psycopg2
        conn = psycopg2.connect(pg_url, connect_timeout=5)
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT relation, key_side, key_type FROM relation_registry "
                    "WHERE enabled = true AND functional = true"
                )
                rows = cur.fetchall()
        finally:
            conn.close()
    except Exception as exc:  # noqa: BLE001 — fail-safe by contract
        logger.warning("conflicts: could not load relation_registry: %s", exc)
        return []

    specs = []
    for relation, key_side, key_type in rows:
        if key_side not in ("head", "tail"):
            continue
        specs.append({
            "relation": relation,
            "rel_type": safe_rel_type(relation),
            "key_side": key_side,
            "key_type": key_type,
        })
    return specs


# ── Authority ranking ────────────────────────────────────────────────────────

def _num(value):
    try:
        return float(value) if value is not None else None
    except (TypeError, ValueError):
        return None


def authority_sort_key(edge):
    """Recency-authority ordering (best first when used with sorted()):
    _source_doc_modified_at DESC -> asserted_at DESC -> trust DESC ->
    confidence DESC. An edge WITHOUT a source-doc mtime ranks below any edge
    that has one (an unknown source date must not beat a known-recent one)."""
    mtime = _num(edge.get("source_doc_modified_at"))
    asserted = _num(edge.get("asserted_at"))
    trust = _num(edge.get("trust"))
    confidence = _num(edge.get("confidence"))
    return (
        mtime is None,
        -(mtime or 0.0),
        -(asserted or 0.0),
        -(trust or 0.0),
        -(confidence or 0.0),
    )


def rank_edges(edges):
    """Sort competing edges best-first per the recency-authority ordering."""
    return sorted(edges, key=authority_sort_key)


# ── Internals ────────────────────────────────────────────────────────────────

def _dossier_trust(conn, user_id, entity_name):
    """entity_dossiers.trust for the value entity (authority tiebreak #3).
    0.0 when no dossier exists or the lookup fails."""
    if not entity_name:
        return 0.0
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT trust FROM entity_dossiers "
                "WHERE user_id = %s::uuid AND lower(entity_name) = lower(%s) "
                "  AND archived = false "
                "ORDER BY pinned DESC, heat DESC LIMIT 1",
                (user_id, entity_name),
            )
            row = cur.fetchone()
        return float(row[0]) if row and row[0] is not None else 0.0
    except Exception:  # noqa: BLE001 — tiebreak only, never fatal
        try:
            conn.rollback()
        except Exception:  # noqa: BLE001
            pass
        return 0.0


def _sibling_edges(session, user_id, spec, key_uri):
    """All edges of this functional relation attached to the key node,
    owned by the user. Matched by the key node's unique uri (works for both
    source-graph Entity nodes and merged Entity:Merged nodes)."""
    rel_type = spec["rel_type"]
    if spec["key_side"] == "tail":
        match = "MATCH (v:Entity)-[r:`%s`]->(k:Entity {uri: $key_uri})" % rel_type
    else:
        match = "MATCH (k:Entity {uri: $key_uri})-[r:`%s`]->(v:Entity)" % rel_type
    cypher = match + (
        " WHERE k._owner = $uid"
        " AND ($key_type IS NULL OR coalesce(k.coarse_type, k.type) = $key_type)"
        " RETURN v.uri AS value_uri, coalesce(v.name, '') AS value_name,"
        "        r.confidence AS confidence, r.asserted_at AS asserted_at,"
        "        r._source_doc AS source_doc,"
        "        r._source_doc_modified_at AS source_doc_modified_at"
    )
    result = session.run(
        cypher, key_uri=key_uri, uid=user_id, key_type=spec.get("key_type"),
    )
    return [dict(rec) for rec in result]


def _set_authority(session, user_id, spec, key_uri, value_uri, authority, superseded_by):
    """SET _authority (+ _superseded_by_doc) on the edge(s) between the key
    node and one value node. Setting _superseded_by_doc to null on the winner
    clears a stale marker from an earlier evaluation (idempotent re-ranking)."""
    rel_type = spec["rel_type"]
    if spec["key_side"] == "tail":
        match = (
            "MATCH (v:Entity {uri: $value_uri})-[r:`%s`]->(k:Entity {uri: $key_uri})"
            % rel_type
        )
    else:
        match = (
            "MATCH (k:Entity {uri: $key_uri})-[r:`%s`]->(v:Entity {uri: $value_uri})"
            % rel_type
        )
    session.run(
        match + " WHERE k._owner = $uid"
                " SET r._authority = $authority,"
                "     r._superseded_by_doc = $superseded_by",
        key_uri=key_uri, value_uri=value_uri, uid=user_id,
        authority=authority, superseded_by=superseded_by,
    )


def _upsert_conflict(conn, user_id, compilation_id, spec, key_uri, key_name,
                     tails, authority_winner):
    """Upsert the fact_conflicts row for (user, relation, key). tails is
    rebuilt in full every evaluation (idempotent). 'dismissed' stays dismissed;
    'resolved' reopens (resolution deleted+blocked the losers, so a re-fire
    means a genuinely new conflicting assertion)."""
    with conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO fact_conflicts
                    (user_id, compilation_id, relation, key_uri, key_name,
                     key_side, tails, authority_winner, status)
                VALUES (%s::uuid, %s::uuid, %s, %s, %s, %s, %s::jsonb, %s, 'open')
                ON CONFLICT (user_id, relation, key_uri) DO UPDATE SET
                    compilation_id = COALESCE(EXCLUDED.compilation_id,
                                              fact_conflicts.compilation_id),
                    key_name          = EXCLUDED.key_name,
                    key_side          = EXCLUDED.key_side,
                    tails             = EXCLUDED.tails,
                    authority_winner  = EXCLUDED.authority_winner,
                    last_evaluated_at = now(),
                    status = CASE WHEN fact_conflicts.status = 'dismissed'
                                  THEN 'dismissed' ELSE 'open' END
                """,
                (user_id, compilation_id, spec["relation"], key_uri, key_name,
                 spec["key_side"], json.dumps(tails), authority_winner),
            )


def _evaluate_key(session, conn, user_id, compilation_id, spec, key_uri, key_name):
    """Evaluate ONE (functional relation, key entity): fetch sibling edges,
    rank authority, write edge props, upsert the conflict row.
    Returns True when a conflict (>= 2 distinct values) exists."""
    edges = _sibling_edges(session, user_id, spec, key_uri)
    distinct_values = {e.get("value_uri") for e in edges if e.get("value_uri")}
    if len(distinct_values) < 2:
        return False

    for e in edges:
        e["trust"] = _dossier_trust(conn, user_id, e.get("value_name"))

    ranked = rank_edges(edges)
    winner = ranked[0]
    winner_uri = winner.get("value_uri")
    winner_doc = str(winner["source_doc"]) if winner.get("source_doc") else None

    tails = []
    for e in ranked:
        is_current = e.get("value_uri") == winner_uri
        _set_authority(
            session, user_id, spec, key_uri, e.get("value_uri"),
            "current" if is_current else "superseded",
            None if is_current else winner_doc,
        )
        tails.append({
            "value": e.get("value_name") or "",
            "uri": e.get("value_uri") or "",
            "sourceDoc": str(e["source_doc"]) if e.get("source_doc") else None,
            "sourceDocModifiedAt": e.get("source_doc_modified_at"),
            "assertedAt": e.get("asserted_at"),
            "confidence": e.get("confidence"),
            "trust": e.get("trust"),
            "authority": "current" if is_current else "superseded",
        })

    _upsert_conflict(
        conn, user_id, compilation_id, spec, key_uri, key_name,
        tails, winner.get("value_name") or "",
    )
    logger.info(
        "conflicts: %s(%s) has %d competing values — winner '%s'",
        spec["relation"], key_name, len(distinct_values),
        winner.get("value_name"),
    )
    return True


# ── Public entry points ──────────────────────────────────────────────────────

def detect_for_job(session, pg_url, user_id, relations, name_to_uri):
    """KEX write-time detection: after a job's relation writes, evaluate every
    (functional relation, key entity) THIS job touched. `relations` are the
    raw relation dicts just written; `name_to_uri` is the same surface-name ->
    uri map kg_builder used, so the key resolves to the exact node written.

    Fail-safe: returns the number of conflicts found; never raises.
    """
    try:
        registry = load_functional_relations(pg_url)
        if not registry:
            return 0
        by_type = {}
        for spec in registry:
            by_type[spec["rel_type"]] = spec

        seen = set()
        candidates = []
        for rel in relations or []:
            rel_type = safe_rel_type(rel.get("type", ""))
            spec = by_type.get(rel_type)
            if spec is None:
                continue
            key_text = (rel.get("tail") if spec["key_side"] == "tail"
                        else rel.get("head")) or ""
            key_text = key_text.strip()
            if not key_text:
                continue
            key_uri = (name_to_uri or {}).get(key_text.lower())
            if not key_uri:
                continue
            dedup = (rel_type, key_uri)
            if dedup in seen:
                continue
            seen.add(dedup)
            candidates.append((spec, key_uri, key_text))
        if not candidates:
            return 0

        import psycopg2
        conn = psycopg2.connect(pg_url, connect_timeout=5)
        found = 0
        try:
            for spec, key_uri, key_name in candidates:
                try:
                    if _evaluate_key(session, conn, user_id, None,
                                     spec, key_uri, key_name):
                        found += 1
                except Exception as exc:  # noqa: BLE001 — per-key isolation
                    logger.warning(
                        "conflicts: evaluation failed for %s '%s': %s",
                        spec["relation"], key_name, exc,
                    )
        finally:
            conn.close()
        return found
    except Exception as exc:  # noqa: BLE001 — NEVER fail the extraction job
        logger.warning("conflicts: write-time detection skipped: %s", exc)
        return 0


def detect_for_compilation(session, pg_url, user_id, compilation_id):
    """FUSE post-merge scan: after _write_merged_graph/_merge_relations, scan
    the merged compilation for functional relations whose (merged, variant-
    unified) key nodes now carry >= 2 distinct values — merges make conflicts
    visible that per-source extraction could not see.

    Fail-safe: returns the number of conflicts found; never raises.
    """
    try:
        registry = load_functional_relations(pg_url)
        if not registry:
            return 0

        import psycopg2
        conn = psycopg2.connect(pg_url, connect_timeout=5)
        found = 0
        try:
            for spec in registry:
                rel_type = spec["rel_type"]
                if spec["key_side"] == "tail":
                    match = (
                        "MATCH (v:Entity:Merged {_compilation: $cid})"
                        "-[r:`%s`]->(k:Entity:Merged {_compilation: $cid})"
                        % rel_type
                    )
                else:
                    match = (
                        "MATCH (k:Entity:Merged {_compilation: $cid})"
                        "-[r:`%s`]->(v:Entity:Merged {_compilation: $cid})"
                        % rel_type
                    )
                cypher = match + (
                    " WHERE k._owner = $uid"
                    " AND ($key_type IS NULL OR coalesce(k.coarse_type, k.type) = $key_type)"
                    " WITH k, count(DISTINCT v.uri) AS nvals"
                    " WHERE nvals > 1"
                    " RETURN k.uri AS key_uri, coalesce(k.name, '') AS key_name"
                )
                try:
                    result = session.run(
                        cypher, cid=compilation_id, uid=user_id,
                        key_type=spec.get("key_type"),
                    )
                    keys = [(rec["key_uri"], rec["key_name"]) for rec in result]
                except Exception as exc:  # noqa: BLE001 — per-relation isolation
                    logger.warning(
                        "conflicts: merged-scan query failed for %s: %s",
                        spec["relation"], exc,
                    )
                    continue
                for key_uri, key_name in keys:
                    if not key_uri:
                        continue
                    try:
                        if _evaluate_key(session, conn, user_id, compilation_id,
                                         spec, key_uri, key_name):
                            found += 1
                    except Exception as exc:  # noqa: BLE001 — per-key isolation
                        logger.warning(
                            "conflicts: evaluation failed for %s '%s': %s",
                            spec["relation"], key_name, exc,
                        )
        finally:
            conn.close()
        return found
    except Exception as exc:  # noqa: BLE001 — NEVER fail the merge job
        logger.warning("conflicts: post-merge detection skipped: %s", exc)
        return 0
