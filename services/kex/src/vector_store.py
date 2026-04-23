"""
Vector store for KEX pipeline.

Persists text chunks in two places:
  1. Qdrant  — stores the embedding vectors + lightweight payload for similarity search
  2. PostgreSQL — stores the full chunk text + metadata for structured queries

Both stores use the same UUID as the primary key so they can be joined.

Failure policy:
  - If Qdrant is unreachable: log warning, skip vector storage, still write PostgreSQL.
  - If PostgreSQL is unreachable: log warning, skip SQL storage, still write Qdrant.
  - Individual point failures are caught per-chunk so one bad chunk never aborts the batch.
"""

import json
import logging
import uuid as uuid_lib
from typing import Optional

import psycopg2
import psycopg2.extras
from qdrant_client import QdrantClient
from qdrant_client.models import PointStruct

from . import config

logger = logging.getLogger(__name__)


class VectorStore:
    """
    Dual-write store: Qdrant (vectors) + PostgreSQL (text).

    Parameters
    ----------
    qdrant_url : str
        HTTP URL for the Qdrant instance.
    collection : str
        Qdrant collection name (must already exist with correct dimensionality).
    pg_url : str
        PostgreSQL DSN (psycopg2 format: postgresql://user:pass@host:port/db).
    """

    def __init__(
        self,
        qdrant_url: str = "http://qdrant:6333",
        collection: str = "GCTRL_chunks",
        pg_url: Optional[str] = None,
    ):
        self.qdrant_url = qdrant_url
        self.collection = collection
        self.pg_url = pg_url or config.PG_URL
        self._qdrant: Optional[QdrantClient] = None
        self._pg_conn = None

    # ── Qdrant ──────────────────────────────────────────────────────────

    def _get_qdrant(self) -> Optional[QdrantClient]:
        """Lazy-init Qdrant client. Returns None if unreachable."""
        if self._qdrant is not None:
            return self._qdrant
        try:
            client = QdrantClient(url=self.qdrant_url, timeout=10)
            # Verify connectivity with a lightweight collections list call
            client.get_collections()
            self._qdrant = client
            logger.info(f"VectorStore: Qdrant connected at {self.qdrant_url}")
        except Exception as exc:
            logger.warning(f"VectorStore: Qdrant unavailable at {self.qdrant_url}: {exc}")
            self._qdrant = None
        return self._qdrant

    def _upsert_to_qdrant(
        self,
        point_id: str,
        vector: list[float],
        payload: dict,
    ) -> bool:
        """Upsert a single point. Returns True on success."""
        client = self._get_qdrant()
        if client is None:
            return False
        try:
            client.upsert(
                collection_name=self.collection,
                points=[PointStruct(id=point_id, vector=vector, payload=payload)],
            )
            return True
        except Exception as exc:
            logger.warning(f"VectorStore: Qdrant upsert failed for point {point_id}: {exc}")
            # Reset client so next call re-probes connectivity
            self._qdrant = None
            return False

    def _upsert_batch_to_qdrant(
        self,
        points: list[PointStruct],
    ) -> int:
        """Upsert a batch of points. Returns count successfully stored."""
        if not points:
            return 0
        client = self._get_qdrant()
        if client is None:
            return 0
        try:
            client.upsert(collection_name=self.collection, points=points)
            return len(points)
        except Exception as exc:
            logger.warning(f"VectorStore: Qdrant batch upsert failed: {exc}")
            self._qdrant = None
            # Fall back to one-by-one to salvage as many as possible
            stored = 0
            for p in points:
                if self._upsert_to_qdrant(p.id, p.vector, p.payload):
                    stored += 1
            return stored

    # ── PostgreSQL ───────────────────────────────────────────────────────

    def _get_pg(self):
        """Lazy-init PostgreSQL connection. Returns None if unavailable."""
        if self._pg_conn is not None:
            try:
                # Cheap liveness check
                self._pg_conn.cursor().execute("SELECT 1")
                return self._pg_conn
            except Exception:
                self._pg_conn = None

        try:
            conn = psycopg2.connect(self.pg_url)
            conn.autocommit = False
            self._pg_conn = conn
            logger.info(f"VectorStore: PostgreSQL connected")
        except Exception as exc:
            logger.warning(f"VectorStore: PostgreSQL unavailable: {exc}")
            self._pg_conn = None
        return self._pg_conn

    def _insert_chunks_pg(
        self,
        rows: list[tuple],
    ) -> int:
        """
        Bulk-insert chunk rows into text_chunks table.

        Row tuple: (id, job_id, compilation_id, user_id, content,
                    start_char, end_char, chunk_sequence,
                    qdrant_point_id, entity_mentions)
        Returns count inserted.
        """
        if not rows:
            return 0
        conn = self._get_pg()
        if conn is None:
            return 0

        sql = """
            INSERT INTO text_chunks (
                id, job_id, compilation_id, user_id,
                content, start_char, end_char, chunk_sequence,
                qdrant_point_id, entity_mentions
            ) VALUES %s
            ON CONFLICT (id) DO NOTHING
        """
        try:
            with conn.cursor() as cur:
                psycopg2.extras.execute_values(cur, sql, rows, page_size=100)
            conn.commit()
            return len(rows)
        except Exception as exc:
            logger.warning(f"VectorStore: PostgreSQL bulk insert failed: {exc}")
            try:
                conn.rollback()
            except Exception:
                pass
            self._pg_conn = None
            return 0

    # ── Public API ───────────────────────────────────────────────────────

    def store_chunks(
        self,
        chunks: list[dict],
        embeddings: list[Optional[list[float]]],
        job_id: str,
        user_id: str,
        compilation_id: Optional[str] = None,
        entity_mentions: Optional[list[list[dict]]] = None,
        source_document_id: Optional[str] = None,
    ) -> int:
        """
        Store text chunks in Qdrant (vectors) and PostgreSQL (text).

        Parameters
        ----------
        chunks : list[dict]
            Output of TextChunker.chunk() — each dict has content, start_char,
            end_char, chunk_sequence.
        embeddings : list[Optional[list[float]]]
            Index-aligned embedding vectors. None entries are skipped for Qdrant
            but the chunk is still written to PostgreSQL (without a qdrant_point_id).
        job_id : str
            Extraction job identifier.
        user_id : str
            Owner of this extraction.
        compilation_id : str | None
            KG compilation this chunk belongs to (set later if unknown now).
        entity_mentions : list[list[dict]] | None
            Per-chunk entity mentions extracted during NER, index-aligned with chunks.
        source_document_id : str | None
            Identifier of the source document (file upload id, URL, etc.).

        Returns
        -------
        int
            Number of chunks successfully stored (in at least one backend).
        """
        if not chunks:
            return 0

        if len(embeddings) != len(chunks):
            logger.warning(
                f"VectorStore: chunks/embeddings length mismatch "
                f"({len(chunks)} vs {len(embeddings)}) — truncating to shorter"
            )
            n = min(len(chunks), len(embeddings))
            chunks = chunks[:n]
            embeddings = embeddings[:n]

        entity_mentions = entity_mentions or [[] for _ in chunks]
        if len(entity_mentions) != len(chunks):
            entity_mentions = [[] for _ in chunks]

        # Generate one UUID per chunk — shared between Qdrant and PostgreSQL
        point_ids = [str(uuid_lib.uuid4()) for _ in chunks]

        # Build Qdrant points (only for chunks with valid embeddings)
        qdrant_points: list[PointStruct] = []
        for i, (chunk, vector, pid) in enumerate(zip(chunks, embeddings, point_ids)):
            if vector is None:
                continue
            # Build entity_mentions payload for the Qdrant point
            mentions_payload = []
            for e in entity_mentions[i]:
                mentions_payload.append({
                    "name": e.get("text", e.get("name", "")),
                    "type": e.get("type", ""),
                    "label": e.get("label", ""),
                })

            payload = {
                "text": chunk["content"],  # full text for RAG retrieval
                "job_id": job_id,
                "user_id": user_id,
                "compilation_id": compilation_id,
                "source_document_id": source_document_id,
                "chunk_sequence": chunk["chunk_sequence"],
                "start_char": chunk["start_char"],
                "end_char": chunk["end_char"],
                "entity_mentions": mentions_payload,
                "entity_count": len(entity_mentions[i]),
            }
            qdrant_points.append(PointStruct(id=pid, vector=vector, payload=payload))

        qdrant_stored = self._upsert_batch_to_qdrant(qdrant_points)
        if qdrant_points:
            logger.info(
                f"VectorStore: Qdrant upserted {qdrant_stored}/{len(qdrant_points)} points "
                f"(job={job_id})"
            )

        # Build PostgreSQL rows for ALL chunks (including those without embeddings)
        pg_rows: list[tuple] = []
        for i, (chunk, pid) in enumerate(zip(chunks, point_ids)):
            has_vector = embeddings[i] is not None
            mentions_json = json.dumps(entity_mentions[i]) if entity_mentions[i] else None
            pg_rows.append((
                pid,                        # id (UUID)
                job_id,                     # job_id
                compilation_id,             # compilation_id (nullable)
                user_id,                    # user_id
                chunk["content"],           # content
                chunk["start_char"],        # start_char
                chunk["end_char"],          # end_char
                chunk["chunk_sequence"],    # chunk_sequence
                pid if has_vector else None,  # qdrant_point_id (None if no vector)
                mentions_json,              # entity_mentions (JSON string)
            ))

        pg_stored = self._insert_chunks_pg(pg_rows)
        if pg_rows:
            logger.info(
                f"VectorStore: PostgreSQL inserted {pg_stored}/{len(pg_rows)} rows "
                f"(job={job_id})"
            )

        # Return count stored in at least one backend
        total = max(qdrant_stored, pg_stored)
        return total

    def close(self) -> None:
        """Release connections."""
        if self._pg_conn:
            try:
                self._pg_conn.close()
            except Exception:
                pass
            self._pg_conn = None
        if self._qdrant:
            try:
                self._qdrant.close()
            except Exception:
                pass
            self._qdrant = None


# ── Module-level singleton ────────────────────────────────────────────

_store: Optional[VectorStore] = None


def get_vector_store() -> VectorStore:
    """Return (and cache) a VectorStore instance using settings from config."""
    global _store
    if _store is None:
        _store = VectorStore(
            qdrant_url=config.QDRANT_URL,
            collection=config.QDRANT_COLLECTION,
            pg_url=config.PG_URL,
        )
    return _store

