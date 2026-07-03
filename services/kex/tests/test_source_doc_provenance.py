"""Tests for P2b provenance threading: source_document_id / source_modified_at
flowing from the job payload into kg_builder relation writes and vector_store
chunk inserts.

Mocking strategy (no DB/Neo4j needed):
  - kg_builder._write_relations is a @staticmethod that takes a Neo4j `tx`
    object; a MagicMock tx captures the Cypher params passed to tx.run().
  - vector_store._insert_chunks_pg is exercised with a fake psycopg2
    connection/cursor; psycopg2.extras.execute_values is patched to capture
    the row tuples instead of hitting a real database.

Parity requirement: when source_document_id / source_modified_at are absent
(older jobs, direct KEX callers), behaviour must be identical to before this
feature existed — the new params just carry None through.
"""

from unittest.mock import MagicMock, patch

import pytest


# ── main.py: _iso_to_ms ──────────────────────────────────────────────────────

class TestIsoToMs:
    def test_parses_zulu_iso_timestamp(self):
        from src.timeutil import iso_to_ms as _iso_to_ms

        # 2024-01-01T00:00:00Z == 1704067200000 ms epoch
        assert _iso_to_ms("2024-01-01T00:00:00Z") == 1704067200000

    def test_parses_offset_iso_timestamp(self):
        from src.timeutil import iso_to_ms as _iso_to_ms

        # Same instant expressed with an explicit +00:00 offset (what serde_json
        # emits for a Rust chrono::DateTime<Utc>) must parse to the same value.
        assert _iso_to_ms("2024-01-01T00:00:00+00:00") == 1704067200000

    def test_none_input_returns_none(self):
        from src.timeutil import iso_to_ms as _iso_to_ms

        assert _iso_to_ms(None) is None

    def test_empty_string_returns_none(self):
        from src.timeutil import iso_to_ms as _iso_to_ms

        assert _iso_to_ms("") is None

    def test_unparseable_string_returns_none_non_fatal(self):
        from src.timeutil import iso_to_ms as _iso_to_ms

        assert _iso_to_ms("not-a-timestamp") is None


# ── kg_builder: relation edges carry _source_doc / _source_doc_modified_at ──

def _fake_tx(relationships_created: int = 1) -> MagicMock:
    """A Neo4j transaction stand-in: tx.run(...) returns a result whose
    .consume() yields summary.counters.relationships_created."""
    tx = MagicMock()
    result = MagicMock()
    summary = MagicMock()
    summary.counters.relationships_created = relationships_created
    result.consume.return_value = summary
    tx.run.return_value = result
    return tx


def _one_relation():
    return [{"head": "Alice", "tail": "Acme", "type": "WORKS_AT", "confidence": 0.9}]


def _name_to_uri():
    return {"alice": "databorg:person/alice", "acme": "databorg:organization/acme"}


class TestWriteRelationsSourceDocProvenance:
    def test_source_doc_fields_passed_to_cypher_when_provided(self):
        from src.kg_builder import KGBuilder

        tx = _fake_tx()
        created = KGBuilder._write_relations(
            tx, "job-1", _one_relation(),
            "label-json", 0, "PUBLIC",
            corrected=set(), name_to_uri=_name_to_uri(),
            source_document_id="doc-uuid-123",
            source_modified_at_ms=1730000000000,
        )

        assert created == 1
        assert tx.run.called
        _args, kwargs = tx.run.call_args
        assert kwargs["source_doc"] == "doc-uuid-123"
        assert kwargs["source_doc_modified_at"] == 1730000000000

        # The Cypher text must actually set both properties ON CREATE and ON MATCH.
        cypher_text = _args[0]
        assert "r._source_doc" in cypher_text
        assert "r._source_doc_modified_at" in cypher_text

    def test_absent_source_doc_fields_are_none_parity(self):
        """Parity: calling without source_document_id/source_modified_at_ms
        (as every call site did before P2b) must not error and must pass
        None through — Neo4j's `SET r.prop = null` leaves the property unset,
        so this is behaviourally identical to before the feature existed."""
        from src.kg_builder import KGBuilder

        tx = _fake_tx()
        created = KGBuilder._write_relations(
            tx, "job-1", _one_relation(),
            "label-json", 0, "PUBLIC",
            corrected=set(), name_to_uri=_name_to_uri(),
        )

        assert created == 1
        _args, kwargs = tx.run.call_args
        assert kwargs["source_doc"] is None
        assert kwargs["source_doc_modified_at"] is None

    def test_build_graph_threads_source_doc_into_write_relations(self):
        """build_graph's new kwargs reach _write_relations unchanged."""
        from src.kg_builder import KGBuilder

        builder = KGBuilder()
        builder._driver = MagicMock()
        fake_session = MagicMock()
        builder._driver.session.return_value.__enter__.return_value = fake_session

        # execute_write(fn, *args) → call fn(tx, *args) synchronously so we can
        # capture what build_graph passed through, without a real driver.
        captured = {}

        def fake_execute_write(fn, *args):
            captured["fn"] = fn
            captured["args"] = args
            return 1

        fake_session.execute_write.side_effect = fake_execute_write
        fake_session.execute_read.return_value = 0

        with patch.object(KGBuilder, "_load_corrected_triples", return_value=set()):
            builder.build_graph(
                "job-1", "user-1", [], _one_relation(),
                classification={"id": None, "name": "PUBLIC", "rank": 0},
                origin="test.txt",
                source_document_id="doc-uuid-456",
                source_modified_at_ms=1730000000000,
            )

        # Two execute_write calls happen (_write_entities, _write_relations);
        # the relations call is the one whose args end with our source-doc pair.
        relations_call = None
        for call in fake_session.execute_write.call_args_list:
            args = call.args
            if args[0] is KGBuilder._write_relations:
                relations_call = args
        assert relations_call is not None, "execute_write(_write_relations, ...) was not called"
        assert relations_call[-2:] == ("doc-uuid-456", 1730000000000)


# ── vector_store: text_chunks INSERT carries source_document_id ────────────

class TestInsertChunksPgSourceDocumentId:
    def _make_store_with_fake_pg(self):
        from src.vector_store import VectorStore

        store = VectorStore(qdrant_url="http://fake-qdrant:6333", pg_url="postgresql://fake/db")
        fake_conn = MagicMock()
        fake_cursor = MagicMock()
        fake_conn.cursor.return_value.__enter__.return_value = fake_cursor
        store._pg_conn = fake_conn
        return store, fake_conn

    def test_insert_sql_includes_source_document_id_column(self):
        store, _conn = self._make_store_with_fake_pg()

        with patch("src.vector_store.psycopg2.extras.execute_values") as mock_execute_values:
            row = (
                "chunk-1", "job-1", None, "user-1",
                "some text", 0, 9, 0,
                None, None, None, 0, "[]",
                "doc-uuid-789",
            )
            count = store._insert_chunks_pg([row])

        assert count == 1
        assert mock_execute_values.called
        _cur, sql, rows = mock_execute_values.call_args[0][:3]
        assert "source_document_id" in sql
        assert rows[0][-1] == "doc-uuid-789"

    def test_insert_sql_source_document_id_nullable_parity(self):
        """A row with source_document_id=None (old callers / no identity
        resolved) must insert without error — the column is nullable."""
        store, _conn = self._make_store_with_fake_pg()

        with patch("src.vector_store.psycopg2.extras.execute_values") as mock_execute_values:
            row = (
                "chunk-2", "job-1", None, "user-1",
                "some text", 0, 9, 0,
                None, None, None, 0, "[]",
                None,
            )
            count = store._insert_chunks_pg([row])

        assert count == 1
        rows = mock_execute_values.call_args[0][2]
        assert rows[0][-1] is None

    def test_store_chunks_passes_source_document_id_through_to_pg_row(self):
        """End-to-end (mocked): store_chunks(source_document_id=...) must land
        as the last element of every PostgreSQL row tuple."""
        store, _conn = self._make_store_with_fake_pg()
        store._qdrant = None  # force Qdrant path to no-op; only PG matters here

        chunks = [{"content": "hello world", "start_char": 0, "end_char": 11, "chunk_sequence": 0}]
        embeddings = [None]  # no vector — still must be written to Postgres

        with patch("src.vector_store.psycopg2.extras.execute_values") as mock_execute_values:
            store.store_chunks(
                chunks, embeddings, "job-1", "user-1",
                source_document_id="doc-uuid-999",
            )

        assert mock_execute_values.called
        rows = mock_execute_values.call_args[0][2]
        assert rows[0][-1] is not None  # _as_uuid() coerces the string, never None here

    def test_store_chunks_absent_source_document_id_parity(self):
        """Parity: omitting source_document_id (every caller before P2b, and
        direct KEX HTTP endpoints today) must behave exactly as before —
        no error, row's source_document_id is None."""
        store, _conn = self._make_store_with_fake_pg()
        store._qdrant = None

        chunks = [{"content": "hello world", "start_char": 0, "end_char": 11, "chunk_sequence": 0}]
        embeddings = [None]

        with patch("src.vector_store.psycopg2.extras.execute_values") as mock_execute_values:
            store.store_chunks(chunks, embeddings, "job-1", "user-1")

        rows = mock_execute_values.call_args[0][2]
        assert rows[0][-1] is None
