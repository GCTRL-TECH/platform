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
from qdrant_client.models import Distance, PointStruct, VectorParams

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
    # else: existing_dim == dim — collection is already correct, no action needed.


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

    # 1. Read all chunks from Postgres.
    conn = psycopg2.connect(pg_url, connect_timeout=10)
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT id, content FROM text_chunks WHERE compilation_id = %s",
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

    # 4. Ensure Qdrant collection has the right dimension.
    client = QdrantClient(url=qdrant_url, timeout=30)
    _ensure_collection(client, collection, dim)

    # 5. Upsert points.
    points = []
    for cid, vector in zip(chunk_ids, vectors):
        if vector is None:
            continue
        points.append(
            PointStruct(
                id=cid,
                vector=vector,
                payload={"compilation_id": compilation_id},
            )
        )

    if not points:
        logger.warning(
            "Reindex: KB %s — no valid vectors to upsert", compilation_id
        )
        return

    client.upsert(collection_name=collection, points=points)
    logger.info(
        "Reindex: KB %s — upserted %d vectors (dim=%d)",
        compilation_id,
        len(points),
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
