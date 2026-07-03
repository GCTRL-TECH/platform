"""
KEX Reindex Worker

Drains the Redis `kex:reindex` list and re-embeds each knowledge base's
text chunks from Postgres using the new embedding model, then upserts
the new vectors into Qdrant.

Failure policy: a failure on one KB logs and continues to the next.
One Qdrant collection is shared (GCTRL_chunks). If the new model has a
different vector dimension, the collection is recreated — this causes a
brief period where vector search returns nothing until the upsert is done.
"""

import json
import logging

import psycopg2
from qdrant_client import QdrantClient
from qdrant_client.models import Distance, PointStruct, PointVectors, VectorParams

from .embedding import EmbeddingClient

logger = logging.getLogger(__name__)

_REINDEX_QUEUE = "kex:reindex"
_DEFAULT_DIM = 768


def _get_collection_dim(client, collection):
    """Return the current vector size of the Qdrant collection, or None if unknown."""
    try:
        info = client.get_collection(collection)
        return info.config.params.vectors.size
    except Exception:
        return None


def _ensure_collection(client, collection, dim):
    """Ensure the Qdrant collection exists with the given dimension.

    If the collection does not exist, create it.
    If it exists but has a different dimension, recreate it (triggers a brief
    search outage — callers should be aware and the SSE response warns the admin).
    """
    existing_dim = _get_collection_dim(client, collection)
    if existing_dim is None:
        # Collection does not exist — create it.
        client.create_collection(
            collection_name=collection,
            vectors_config=VectorParams(size=dim, distance=Distance.COSINE),
        )
        logger.info("Reindex: created Qdrant collection '%s' (dim=%d)", collection, dim)
        return True  # payloads absent — caller must write full payloads
    elif existing_dim != dim:
        # Dimension mismatch — must recreate. This wipes all old vectors.
        logger.warning(
            "Reindex: dimension changed %d->%d — recreating Qdrant collection '%s'. "
            "Search will return no results until reindex completes.",
            existing_dim,
            dim,
            collection,
        )
        # Try recreate_collection first (older qdrant-client); fall back to
        # delete + create (newer clients that removed the convenience method).
        try:
            client.recreate_collection(
                collection_name=collection,
                vectors_config=VectorParams(size=dim, distance=Distance.COSINE),
            )
        except AttributeError:
            client.delete_collection(collection)
            client.create_collection(
                collection_name=collection,
                vectors_config=VectorParams(size=dim, distance=Distance.COSINE),
            )
        logger.info("Reindex: recreated '%s' with new dim=%d", collection, dim)
        return True  # payloads wiped by recreation — caller must write full payloads
    # existing_dim == dim — collection is already correct; payloads intact.
    return False


def _reindex_compilation(
    compilation_id,
    embedding_model,
    embedding_base,
    embedding_provider,
    pg_url,
    qdrant_url,
    collection,
):
    """Re-embed all chunks for one compilation and upsert into Qdrant."""
    logger.info(
        "Reindex: starting KB %s with model=%s", compilation_id, embedding_model
    )

    # 1. Read all chunks from Postgres — including every payload column, so a
    #    collection recreation (dimension change) can rebuild FULL Qdrant
    #    payloads instead of stripping them down to compilation_id (which would
    #    silently destroy the access-control pre-filter fields min_rank /
    #    classification_level_id plus text/entity_mentions/entity_uris).
    conn = psycopg2.connect(pg_url, connect_timeout=10)
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT id, content, job_id, user_id, source_document_id, "
                "       chunk_sequence, start_char, end_char, entity_mentions, "
                "       entity_uris, min_rank, classification_level_id "
                "FROM text_chunks WHERE compilation_id = %s",
                (compilation_id,),
            )
            rows = cur.fetchall()
    finally:
        conn.close()

    if not rows:
        logger.info("Reindex: KB %s has no chunks — skipping", compilation_id)
        return

    chunk_ids = [str(r[0]) for r in rows]
    texts = [r[1] or "" for r in rows]
    logger.info(
        "Reindex: KB %s — %d chunks to re-embed", compilation_id, len(texts)
    )

    # 2. Re-embed using the new model.
    provider = (embedding_provider or "ollama").strip()
    base_url = (embedding_base or "").strip() or "http://ollama:11434"
    model = (embedding_model or "nomic-embed-text").strip()

    embedder = EmbeddingClient(provider=provider, base_url=base_url, model=model)
    vectors = embedder.embed_batch(texts)

    # 3. Detect dimension from first non-None vector.
    dim = None
    for v in vectors:
        if v is not None:
            dim = len(v)
            break

    if dim is None:
        logger.warning(
            "Reindex: KB %s — all embeddings failed, skipping Qdrant upsert",
            compilation_id,
        )
        return

    # 4. Ensure Qdrant collection has the right dimension. When it had to be
    #    (re)created, all payloads are gone and must be rebuilt from Postgres;
    #    when the dimension is unchanged we only swap vectors and leave the
    #    existing payloads untouched.
    client = QdrantClient(url=qdrant_url, timeout=30)
    payloads_missing = _ensure_collection(client, collection, dim)

    if payloads_missing:
        # 5a. Full upsert with payloads rebuilt from the Postgres row —
        #     keys mirror vector_store.py's payload shape exactly.
        points = []
        for row, vector in zip(rows, vectors):
            if vector is None:
                continue
            job_id = str(row[2]) if row[2] else None
            points.append(
                PointStruct(
                    id=str(row[0]),
                    vector=vector,
                    payload={
                        "text": row[1] or "",
                        "job_id": job_id,
                        "source_job": job_id,
                        "user_id": str(row[3]) if row[3] else None,
                        "compilation_id": compilation_id,
                        "source_document_id": str(row[4]) if row[4] else None,
                        "chunk_sequence": row[5],
                        "start_char": row[6],
                        "end_char": row[7],
                        "entity_mentions": row[8] or [],
                        "entity_count": len(row[8] or []),
                        "entity_uris": list(row[9] or []),
                        "min_rank": row[10],
                        "classification_level_id": str(row[11]) if row[11] else None,
                    },
                )
            )
        if not points:
            logger.warning(
                "Reindex: KB %s — no valid vectors to upsert", compilation_id
            )
            return
        client.upsert(collection_name=collection, points=points)
        logger.info(
            "Reindex: KB %s — upserted %d vectors WITH rebuilt payloads (dim=%d)",
            compilation_id,
            len(points),
            dim,
        )
    else:
        # 5b. Dimension unchanged — update vectors only, preserving payloads.
        vector_updates = []
        for cid, vector in zip(chunk_ids, vectors):
            if vector is None:
                continue
            vector_updates.append(PointVectors(id=cid, vector=vector))
        if not vector_updates:
            logger.warning(
                "Reindex: KB %s — no valid vectors to update", compilation_id
            )
            return
        client.update_vectors(collection_name=collection, points=vector_updates)
        logger.info(
            "Reindex: KB %s — updated %d vectors in place (dim=%d, payloads preserved)",
            compilation_id,
            len(vector_updates),
            dim,
        )


def drain_reindex_queue(redis_client, pg_url, qdrant_url, collection):
    """Drain the kex:reindex Redis list, processing each job.

    Uses LPOP (non-blocking) to drain all current items without blocking.
    Returns the count of KBs successfully processed.
    """
    processed = 0
    while True:
        raw = redis_client.lpop(_REINDEX_QUEUE)
        if raw is None:
            break
        try:
            job = json.loads(raw)
            compilation_id = job.get("compilationId") or job.get("compilation_id")
            embedding_model = job.get("embedding_model", "nomic-embed-text")
            embedding_base = job.get("embedding_base")
            embedding_provider = job.get("embedding_provider", "ollama")

            if not compilation_id:
                logger.warning(
                    "Reindex: job missing compilationId — skipping: %s", raw[:200]
                )
                continue

            _reindex_compilation(
                compilation_id=compilation_id,
                embedding_model=embedding_model,
                embedding_base=embedding_base,
                embedding_provider=embedding_provider,
                pg_url=pg_url,
                qdrant_url=qdrant_url,
                collection=collection,
            )
            processed += 1

        except Exception as exc:
            logger.error(
                "Reindex: job failed (%s), continuing to next KB", exc
            )

    return processed
