"""QDRANT_API_KEY reaches every Qdrant client the worker builds; an empty key
builds the client exactly as before (no api_key argument)."""

import json
from unittest.mock import MagicMock, patch


def _vs_client_kwargs(api_key):
    from src.vector_store import VectorStore

    vs = VectorStore(qdrant_url="http://qdrant:6333", collection="c", pg_url="postgres://x",
                     qdrant_api_key=api_key)
    fake = MagicMock()
    fake.collection_exists.return_value = True
    with patch("src.vector_store.QdrantClient", return_value=fake) as ctor:
        vs._get_qdrant()
    return ctor.call_args.kwargs


def test_vector_store_sends_key():
    assert _vs_client_kwargs("sekret")["api_key"] == "sekret"


def test_vector_store_without_key_unchanged():
    assert "api_key" not in _vs_client_kwargs("")


def _reindex_client_kwargs(api_key):
    from src.reindex_worker import drain_reindex_queue
    from tests.test_reindex_worker import FakeEmbedder, _chunk_row, _make_pg_conn

    fake_qdrant = MagicMock()
    fake_qdrant.collection_exists.return_value = True
    fake_redis = MagicMock()
    fake_redis.lpop.side_effect = [json.dumps({"compilationId": "kb"}), None]
    with patch("psycopg2.connect", return_value=_make_pg_conn([_chunk_row("c1", "text")])), \
         patch("src.reindex_worker.EmbeddingClient", return_value=FakeEmbedder(dim=768)), \
         patch("src.reindex_worker.QdrantClient", return_value=fake_qdrant) as ctor:
        count = drain_reindex_queue(redis_client=fake_redis, pg_url="postgres://x",
                                    qdrant_url="http://qdrant:6333", collection="c",
                                    qdrant_api_key=api_key)
    assert count == 1
    return ctor.call_args.kwargs


def test_reindex_worker_sends_key():
    assert _reindex_client_kwargs("sekret")["api_key"] == "sekret"


def test_reindex_worker_without_key_unchanged():
    assert "api_key" not in _reindex_client_kwargs("")
