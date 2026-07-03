"""
One-off backfill: populate text_chunks.entity_uris for chunks written BEFORE
P2a (grounded nodes) added the column.

Why this exists: entity_mentions already carries {name,type,label} per mention,
but older rows have no `uri` per mention and an empty entity_uris array, so a
grounding lookup (entity_uris @> ARRAY[uri]) finds nothing for pre-P2a chunks.
This recomputes each mention's uri via kg_builder.entity_uri() — the SAME pure
slug fn the live write path uses — then verifies the entity actually EXISTS as
a node in Neo4j (an entity pruned from the graph, e.g. an isolated non-core
concept, never got written, so its "uri" would be a dangling reference).
Existing -> mention.uri + into entity_uris. Missing -> mention.pruned = true.

Resilient per-row (one bad row is logged and skipped, not fatal) and batched
(one Neo4j round-trip + one Qdrant patch pass per BATCH_SIZE rows).

Run on the HOST against the local stack (not inside the kex container — this
is new code the running container image predates):
    cd services/kex
    python -m src.backfill_mentions [--dry-run]

Talks to the same endpoints the container uses, from the host:
  Postgres : PG_URL        (container 5432 -> host 5433; override via env)
  Neo4j    : NEO4J_URI      (bolt://localhost:7687 from host — config default)
  Qdrant   : QDRANT_URL     (http://localhost:6333 from host; override via env)
"""

import json
import logging
import sys

import psycopg2
import psycopg2.extras
from neo4j import GraphDatabase

from . import config
from .kg_builder import entity_uri
from .vector_store import get_vector_store

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("backfill_mentions")

BATCH_SIZE = 200


def _load_mentions(raw):
    """Coerce the stored entity_mentions JSON into a list of dicts."""
    if not raw:
        return []
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except Exception:
            return []
    if not isinstance(raw, list):
        return []
    return [m for m in raw if isinstance(m, dict)]


def main(argv: list[str]) -> int:
    dry_run = "--dry-run" in argv[1:]

    conn = psycopg2.connect(config.PG_URL)
    conn.autocommit = False

    driver = GraphDatabase.driver(
        config.NEO4J_URI, auth=(config.NEO4J_USER, config.NEO4J_PASSWORD)
    )
    try:
        driver.verify_connectivity()
    except Exception as exc:
        logger.error(f"Neo4j unavailable at {config.NEO4J_URI}: {exc}")
        return 2
    logger.info(f"Neo4j connected: {config.NEO4J_URI}")

    vs = get_vector_store()
    qc = vs._get_qdrant()
    if qc is None:
        logger.warning(
            "Qdrant unavailable — PostgreSQL will still be backfilled, "
            "but existing Qdrant point payloads won't be patched"
        )
    else:
        logger.info(f"Qdrant connected: {vs.qdrant_url} (collection '{vs.collection}')")

    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(
            """
            SELECT id, user_id, entity_mentions, qdrant_point_id
              FROM text_chunks
             WHERE entity_uris = '{}'
               AND entity_mentions IS NOT NULL
               AND entity_mentions::text != '[]'
             ORDER BY created_at
            """
        )
        rows = cur.fetchall()

    if not rows:
        logger.info("No chunks need backfilling — entity_uris already populated everywhere.")
        return 0
    logger.info(f"Found {len(rows)} chunk(s) to backfill (dry_run={dry_run})")

    total_mentions = 0
    resolved_mentions = 0
    pruned_mentions = 0
    missing_point = 0
    processed_rows = 0
    error_rows = 0

    for batch_start in range(0, len(rows), BATCH_SIZE):
        batch = rows[batch_start:batch_start + BATCH_SIZE]

        # Pass 1: recompute each mention's candidate uri (pure, no I/O), and
        # collect the full candidate set so ONE Cypher call can check them all.
        row_mentions = {}
        candidate_uris = set()
        for row in batch:
            mentions = _load_mentions(row.get("entity_mentions"))
            uid = str(row["user_id"]) if row["user_id"] else ""
            annotated = []
            for m in mentions:
                name = (m.get("name") or m.get("text") or "").strip()
                if not name:
                    annotated.append((m, None))
                    continue
                mtype = m.get("type") or "other"
                candidate = entity_uri(uid, mtype, name)
                candidate_uris.add(candidate)
                annotated.append((m, candidate))
            row_mentions[row["id"]] = annotated

        # Pass 2: one batched Neo4j round-trip — which candidates are real nodes?
        existing = set()
        if candidate_uris:
            try:
                with driver.session() as session:
                    result = session.run(
                        "MATCH (n:Entity) WHERE n.uri IN $uris RETURN n.uri AS uri",
                        uris=list(candidate_uris),
                    )
                    for rec in result:
                        existing.add(rec["uri"])
            except Exception as exc:
                logger.error(
                    f"Neo4j batch lookup failed for {len(candidate_uris)} candidate(s) "
                    f"({exc}) — this batch's mentions will all resolve as pruned"
                )

        qdrant_updates = []  # [(point_id, payload_patch), ...]

        for row in batch:
            try:
                final_mentions = []
                row_uris = []
                for m, candidate in row_mentions[row["id"]]:
                    if candidate is None:
                        final_mentions.append(m)
                        continue
                    total_mentions += 1
                    m = dict(m)
                    if candidate in existing:
                        m["uri"] = candidate
                        m.pop("pruned", None)
                        if candidate not in row_uris:
                            row_uris.append(candidate)
                        resolved_mentions += 1
                    else:
                        m["pruned"] = True
                        m.pop("uri", None)
                        pruned_mentions += 1
                    final_mentions.append(m)

                processed_rows += 1

                if dry_run:
                    continue

                with conn.cursor() as cur:
                    cur.execute(
                        "UPDATE text_chunks SET entity_mentions = %s, entity_uris = %s WHERE id = %s",
                        (json.dumps(final_mentions), row_uris, row["id"]),
                    )

                if row["qdrant_point_id"]:
                    qdrant_updates.append((
                        str(row["qdrant_point_id"]),
                        {"entity_mentions": final_mentions, "entity_uris": row_uris},
                    ))
                else:
                    missing_point += 1

            except Exception as exc:
                error_rows += 1
                logger.warning(f"  chunk {row['id']}: backfill failed ({exc}) — skipped")
                continue

        if not dry_run:
            conn.commit()
            if qdrant_updates and qc is not None:
                for point_id, payload in qdrant_updates:
                    try:
                        qc.set_payload(
                            collection_name=vs.collection,
                            payload=payload,
                            points=[point_id],
                        )
                    except Exception as exc:
                        logger.warning(f"  Qdrant set_payload failed for point {point_id}: {exc}")

        logger.info(
            f"  batch {batch_start // BATCH_SIZE + 1}: {len(batch)} row(s), "
            f"{len(candidate_uris)} candidate uri(s), {len(existing)} resolved"
        )

    conn.close()
    driver.close()

    resolved_pct = (resolved_mentions / total_mentions * 100) if total_mentions else 0.0
    pruned_pct = (pruned_mentions / total_mentions * 100) if total_mentions else 0.0
    missing_point_pct = (missing_point / processed_rows * 100) if processed_rows else 0.0

    logger.info(
        f"Backfill {'DRY-RUN ' if dry_run else ''}done: {processed_rows} row(s) processed, "
        f"{error_rows} error(s). Mentions: {total_mentions} total, "
        f"{resolved_mentions} resolved ({resolved_pct:.1f}%), "
        f"{pruned_mentions} pruned ({pruned_pct:.1f}%). "
        f"Rows with no qdrant_point_id (Postgres-only, not patched in Qdrant): "
        f"{missing_point} ({missing_point_pct:.1f}%)."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
