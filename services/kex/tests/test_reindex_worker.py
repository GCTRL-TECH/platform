"""Unit tests for the reindex worker.

Mock strategy:
  - Postgres: monkeypatch psycopg2.connect → fake cursor with 2 chunks
  - EmbeddingClient: monkeypatched to return fixed 3-dim vectors
  - QdrantClient: MagicMock capturing upsert calls
  - No real network calls.
"""
from unittest.mock import MagicMock, patch, call
import pytest


# ── helpers ───────────────────────────────────────────────────────────────────

def _make_pg_conn(rows):
    """Return a fake psycopg2 connection that yields `rows` for any SELECT."""
    cur = MagicMock()
    cur.fetchall.return_value = rows
    cur.__enter__ = lambda s: s
    cur.__exit__ = MagicMock(return_value=False)
    conn = MagicMock()
    conn.cursor.return_value = cur
    conn.__enter__ = lambda s: s
    conn.__exit__ = MagicMock(return_value=False)
    return conn


class FakeEmbedder:
    """Returns a fixed 3-dim vector for any text (mimics EmbeddingClient)."""
    def __init__(self, dim=3):
        self.dim = dim
        self.calls = []

    def embed_batch(self, texts):
        self.calls.extend(texts)
        return [[0.1] * self.dim for _ in texts]


# ── tests ─────────────────────────────────────────────────────────────────────

class TestDrainReindexQueue:
    def test_re_embeds_both_chunks(self):
        from src.reindex_worker import drain_reindex_queue
        import json

        fake_embedder = FakeEmbedder(dim=768)
        fake_qdrant = MagicMock()
        fake_qdrant.collection_exists.return_value = True

        # Two chunks for one compilation
        fake_pg = _make_pg_conn([
            ("chunk-id-1", "text chunk one"),
            ("chunk-id-2", "text chunk two"),
        ])

        job = json.dumps({
            "compilationId": "comp-abc",
            "embedding_model": "nomic-embed-text",
            "embedding_base": "http://ollama:11434",
            "embedding_provider": "ollama",
        })

        with patch("psycopg2.connect", return_value=fake_pg), \
             patch("src.reindex_worker.EmbeddingClient", return_value=fake_embedder), \
             patch("src.reindex_worker.QdrantClient", return_value=fake_qdrant):

            # Push one job onto a fake Redis
            fake_redis = MagicMock()
            fake_redis.lpop.side_effect = [job, None]  # one job, then empty

            count = drain_reindex_queue(
                redis_client=fake_redis,
                pg_url="postgres://test",
                qdrant_url="http://qdrant:6333",
                collection="GCTRL_chunks",
            )

        assert count == 1, f"expected 1 KB processed, got {count}"
        assert len(fake_embedder.calls) == 2, (
            f"expected 2 embed calls for 2 chunks, got {fake_embedder.calls}"
        )
        assert fake_qdrant.upsert.called, "Qdrant upsert must be called"

    def test_empty_queue_processes_zero(self):
        from src.reindex_worker import drain_reindex_queue

        fake_redis = MagicMock()
        fake_redis.lpop.return_value = None  # queue empty immediately

        count = drain_reindex_queue(
            redis_client=fake_redis,
            pg_url="postgres://test",
            qdrant_url="http://qdrant:6333",
            collection="GCTRL_chunks",
        )

        assert count == 0

    def test_failure_on_one_kb_continues_to_next(self):
        """A crash processing KB1 must not abort KB2."""
        from src.reindex_worker import drain_reindex_queue
        import json

        bad_job  = json.dumps({"compilationId": "bad-comp",  "embedding_model": "nomic-embed-text", "embedding_base": None, "embedding_provider": "ollama"})
        good_job = json.dumps({"compilationId": "good-comp", "embedding_model": "nomic-embed-text", "embedding_base": None, "embedding_provider": "ollama"})

        fake_redis = MagicMock()
        fake_redis.lpop.side_effect = [bad_job, good_job, None]

        # good_job returns 1 chunk; bad_job triggers a psycopg2 exception
        call_count = [0]
        def pg_connect_side_effect(*args, **kwargs):
            call_count[0] += 1
            if call_count[0] == 1:
                raise Exception("simulated DB failure for bad-comp")
            return _make_pg_conn([("chunk-id-1", "text one")])

        fake_embedder = FakeEmbedder(dim=768)
        fake_qdrant = MagicMock()
        fake_qdrant.collection_exists.return_value = True

        with patch("psycopg2.connect", side_effect=pg_connect_side_effect), \
             patch("src.reindex_worker.EmbeddingClient", return_value=fake_embedder), \
             patch("src.reindex_worker.QdrantClient", return_value=fake_qdrant):

            count = drain_reindex_queue(
                redis_client=fake_redis,
                pg_url="postgres://test",
                qdrant_url="http://qdrant:6333",
                collection="GCTRL_chunks",
            )

        # 2 KBs attempted; 1 succeeded
        assert count == 1, f"expected 1 successful KB, got {count}"

    def test_dim_change_triggers_collection_recreate(self):
        """When the new model has a different dimension than 768, the Qdrant
        collection must be recreated."""
        from src.reindex_worker import drain_reindex_queue
        import json

        fake_embedder = FakeEmbedder(dim=1536)  # e.g. OpenAI ada-002
        fake_qdrant = MagicMock()
        fake_qdrant.collection_exists.return_value = True
        # Simulate the existing collection having size 768 (the old default)
        fake_info = MagicMock()
        fake_info.config.params.vectors.size = 768
        fake_qdrant.get_collection.return_value = fake_info

        fake_pg = _make_pg_conn([("chunk-id-1", "text one")])

        job = json.dumps({
            "compilationId": "comp-xyz",
            "embedding_model": "text-embedding-3-small",
            "embedding_base": "https://api.openai.com/v1",
            "embedding_provider": "openai",
        })

        fake_redis = MagicMock()
        fake_redis.lpop.side_effect = [job, None]

        with patch("psycopg2.connect", return_value=fake_pg), \
             patch("src.reindex_worker.EmbeddingClient", return_value=fake_embedder), \
             patch("src.reindex_worker.QdrantClient", return_value=fake_qdrant):

            drain_reindex_queue(
                redis_client=fake_redis,
                pg_url="postgres://test",
                qdrant_url="http://qdrant:6333",
                collection="GCTRL_chunks",
            )

        # recreate_collection must have been called because dim changed (768→1536)
        assert fake_qdrant.recreate_collection.called or fake_qdrant.delete_collection.called, (
            "collection must be recreated when embedding dimension changes"
        )
