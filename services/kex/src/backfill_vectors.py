"""
One-off backfill: re-embed existing text_chunks into the Qdrant collection.

Why this exists: the "Ground Control" rebuild stored 8 text_chunks in Postgres
(with text) but the vector upsert silently no-op'd because the Qdrant collection
did not exist at the time (it has since been created by the startup fix). This
re-embeds those existing chunks via Ollama nomic-embed-text and upserts them with
the SAME payload shape the /search handler expects (text, job_id, source_job,
user_id, compilation_id, min_rank, entity_mentions objects).

Idempotent: upsert is keyed by the chunk's existing id (or qdrant_point_id), so
re-running overwrites rather than duplicates. Does NOT touch Neo4j or the graph.

Run inside the kex container:
    docker compose exec kex python3 -m src.backfill_vectors [--all | <compilation_id>]

Selection:
  * no arg / "--all"  → every text_chunk that has no vector yet (whole table)
  * a compilation id  → only chunks for that compilation (matches compilation_id
                        OR, since the rebuild left it NULL, chunks belonging to
                        the compilation's source_job_ids — passed via env)
"""

import json
import logging
import sys
import uuid as uuid_lib

import psycopg2
import psycopg2.extras
from qdrant_client.models import PointStruct

from . import config
from .embedding import get_embedding_client
from .vector_store import get_vector_store

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("backfill")


def _norm_mentions(raw) -> list[dict]:
    """Coerce stored entity_mentions JSON into the {name,type,label} payload the
    /search handler produces. Handles already-normalized objects."""
    if not raw:
        return []
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except Exception:
            return []
    out = []
    for e in raw or []:
        if not isinstance(e, dict):
            continue
        out.append({
            "name": e.get("name", e.get("text", "")),
            "type": e.get("type", ""),
            "label": e.get("label", ""),
        })
    return out


def main(argv: list[str]) -> int:
    selector = argv[1] if len(argv) > 1 else "--all"

    vs = get_vector_store()
    qc = vs._get_qdrant()           # also ensures the collection exists
    if qc is None:
        logger.error("Qdrant unavailable — aborting")
        return 2
    logger.info(f"Collection '{vs.collection}' ready; selector={selector}")

    conn = psycopg2.connect(config.PG_URL)
    conn.autocommit = False

    # Pull chunks. We re-embed regardless of qdrant_point_id (the points are
    # missing from Qdrant), but only rows that actually carry text.
    where = "content IS NOT NULL AND length(content) > 0"
    params: list = []
    if selector not in ("--all", "", None):
        # Scope to a compilation: match compilation_id OR the source jobs of that
        # compilation (the rebuild left compilation_id NULL on the chunks).
        where += (
            " AND (compilation_id = %s::uuid OR job_id = ANY("
            "   SELECT unnest(COALESCE(source_job_ids,'{}'::uuid[])) FROM compilations WHERE id = %s::uuid"
            " ))"
        )
        params = [selector, selector]

    sql = (
        "SELECT id, job_id, compilation_id, user_id, content, "
        "       qdrant_point_id, entity_mentions, min_rank, classification_level_id "
        f"FROM text_chunks WHERE {where} ORDER BY created_at"
    )
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(sql, params)
        rows = cur.fetchall()

    if not rows:
        logger.info("No matching chunks found — nothing to backfill.")
        return 0
    logger.info(f"Found {len(rows)} chunk(s) to (re-)embed")

    embedder = get_embedding_client()
    texts = [r["content"] for r in rows]
    vectors = embedder.embed_batch(texts)

    points: list[PointStruct] = []
    skipped = 0
    for r, vec in zip(rows, vectors):
        if vec is None:
            skipped += 1
            logger.warning(f"  chunk {r['id']}: embedding failed — skipped")
            continue
        # Reuse the chunk's existing qdrant_point_id if present, else its id.
        pid = str(r["qdrant_point_id"] or r["id"])
        payload = {
            "text": r["content"],
            "job_id": str(r["job_id"]) if r["job_id"] else None,
            "source_job": str(r["job_id"]) if r["job_id"] else None,
            "user_id": str(r["user_id"]) if r["user_id"] else None,
            "compilation_id": str(r["compilation_id"]) if r["compilation_id"] else None,
            "entity_mentions": _norm_mentions(r.get("entity_mentions")),
            "min_rank": int(r["min_rank"]) if r["min_rank"] is not None else 0,
            "classification_level_id": str(r["classification_level_id"]) if r["classification_level_id"] else None,
        }
        points.append(PointStruct(id=pid, vector=vec, payload=payload))
        # Make sure Postgres records the point id we used.
        if str(r["qdrant_point_id"] or "") != pid:
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE text_chunks SET qdrant_point_id = %s::uuid WHERE id = %s",
                    (pid, r["id"]),
                )

    if not points:
        logger.error(f"All {len(rows)} embeddings failed — nothing upserted.")
        conn.rollback()
        return 3

    qc.upsert(collection_name=vs.collection, points=points)
    conn.commit()
    conn.close()

    info = qc.get_collection(vs.collection)
    logger.info(
        f"Backfill done: upserted {len(points)} point(s) "
        f"(skipped {skipped}); collection now has {info.points_count} point(s)."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
