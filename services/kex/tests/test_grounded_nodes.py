"""Tests for P2a — grounded nodes: entity URIs on chunk mentions.

Covers:
  - kg_builder.entity_uri() is a pure wrapper that matches the write-path slug
    algorithm exactly (same inputs -> same uri as `_make_uri` / `_write_entities`).
  - build_graph() returns `graph_uris` — the set of uris actually written
    (post-pruning) — so callers can tell "grounded" from "pruned" mentions.
  - vector_store.store_chunks() derives entity_uris (deduped, pruned excluded)
    from annotated entity_mentions and writes them to both the Postgres row and
    the Qdrant payload.
"""

from unittest.mock import MagicMock, patch


# ── entity_uri(): pure fn parity with the write-path slug algorithm ─────────

class TestEntityUriParity:
    def test_matches_make_uri_write_path_exactly(self):
        from src.kg_builder import entity_uri, _make_uri

        uri = entity_uri("user-abc-123", "organization", "Acme Corp")
        assert uri == _make_uri("Acme Corp", "organization", "user-abc-123")

    def test_captured_expected_value_regression(self):
        """A captured expected uri for a fixed input — guards against an
        accidental change to the slug algorithm (would silently orphan every
        `entity_uris` value already written to Postgres/Qdrant)."""
        from src.kg_builder import entity_uri

        uri = entity_uri("11111111-2222-3333-4444-555555555555", "person", "Ada Lovelace")
        assert uri == "databorg:111111112222/person/ada_lovelace"

    def test_deterministic_same_inputs_same_uri(self):
        from src.kg_builder import entity_uri

        a = entity_uri("user-1", "technology", "Ground Control")
        b = entity_uri("user-1", "technology", "Ground Control")
        assert a == b

    def test_scoped_per_user(self):
        from src.kg_builder import entity_uri

        a = entity_uri("user-1", "person", "Steve Jobs")
        b = entity_uri("user-2", "person", "Steve Jobs")
        assert a != b


# ── build_graph(): graph_uris reflects post-pruning kept entities ──────────

class TestBuildGraphGraphUris:
    def _make_builder_with_fake_session(self):
        from src.kg_builder import KGBuilder

        builder = KGBuilder()
        builder._driver = MagicMock()
        fake_session = MagicMock()
        builder._driver.session.return_value.__enter__.return_value = fake_session
        fake_session.execute_write.side_effect = lambda fn, *args: 0
        fake_session.execute_read.return_value = 0
        return builder, fake_session

    def test_graph_uris_returned_for_kept_entities(self):
        from src.kg_builder import KGBuilder, entity_uri
        from src import config as kex_config

        builder, _session = self._make_builder_with_fake_session()
        entities = [
            {"text": "Acme Corp", "type": "organization", "coarse_type": "organization"},
            {"text": "Widget", "type": "technology", "coarse_type": "technology"},
        ]
        # Pruning is orthogonal to what this test checks (graph_uris covers every
        # KEPT entity) — disable it so an isolated non-core "Widget" isn't pruned
        # for lack of a relation, which would conflate the two behaviors.
        with patch.object(KGBuilder, "_load_corrected_triples", return_value=set()), \
             patch.object(kex_config, "GRAPH_PRUNE_ISOLATED", False):
            stats = builder.build_graph("job-1", "user-1", entities, [])

        expected = {
            entity_uri("user-1", "organization", "Acme Corp"),
            entity_uri("user-1", "technology", "Widget"),
        }
        assert set(stats["graph_uris"]) == expected

    def test_pruned_entity_excluded_from_graph_uris(self):
        """A non-core, isolated entity (no relation, not in GRAPH_KEEP_TYPES) is
        pruned from the graph — its uri must NOT appear in graph_uris."""
        from src.kg_builder import KGBuilder, entity_uri
        from src import config as kex_config

        builder, _session = self._make_builder_with_fake_session()
        entities = [
            {"text": "Acme Corp", "type": "organization", "coarse_type": "organization"},
            {"text": "vaguely happy", "type": "emotion", "coarse_type": "field"},
        ]
        with patch.object(KGBuilder, "_load_corrected_triples", return_value=set()), \
             patch.object(kex_config, "GRAPH_PRUNE_ISOLATED", True):
            stats = builder.build_graph("job-1", "user-1", entities, [])

        kept_uri = entity_uri("user-1", "organization", "Acme Corp")
        pruned_uri = entity_uri("user-1", "field", "vaguely happy")
        assert kept_uri in stats["graph_uris"]
        assert pruned_uri not in stats["graph_uris"]


# ── vector_store: entity_uris derived from annotated entity_mentions ───────

class TestVectorStoreEntityUris:
    def _make_store_with_fake_pg(self):
        from src.vector_store import VectorStore

        store = VectorStore(qdrant_url="http://fake-qdrant:6333", pg_url="postgresql://fake/db")
        fake_conn = MagicMock()
        fake_cursor = MagicMock()
        fake_conn.cursor.return_value.__enter__.return_value = fake_cursor
        store._pg_conn = fake_conn
        store._qdrant = None  # force Qdrant path to no-op; only PG matters here
        return store

    def test_entity_uris_column_populated_excluding_pruned(self):
        store = self._make_store_with_fake_pg()
        chunks = [{"content": "Acme hired Ada.", "start_char": 0, "end_char": 15, "chunk_sequence": 0}]
        embeddings = [None]
        mentions = [[
            {"text": "Acme", "type": "organization", "uri": "databorg:u1/organization/acme"},
            {"text": "vaguely happy", "type": "field", "pruned": True},
        ]]

        with patch("src.vector_store.psycopg2.extras.execute_values") as mock_execute_values:
            store.store_chunks(chunks, embeddings, "job-1", "user-1", entity_mentions=mentions)

        rows = mock_execute_values.call_args[0][2]
        entity_uris_col = rows[0][-1]
        assert entity_uris_col == ["databorg:u1/organization/acme"]

    def test_entity_uris_deduped(self):
        store = self._make_store_with_fake_pg()
        chunks = [{"content": "Acme and Acme again.", "start_char": 0, "end_char": 20, "chunk_sequence": 0}]
        embeddings = [None]
        mentions = [[
            {"text": "Acme", "type": "organization", "uri": "databorg:u1/organization/acme"},
            {"text": "Acme", "type": "organization", "uri": "databorg:u1/organization/acme"},
        ]]

        with patch("src.vector_store.psycopg2.extras.execute_values") as mock_execute_values:
            store.store_chunks(chunks, embeddings, "job-1", "user-1", entity_mentions=mentions)

        rows = mock_execute_values.call_args[0][2]
        assert rows[0][-1] == ["databorg:u1/organization/acme"]

    def test_no_mentions_yields_empty_entity_uris(self):
        store = self._make_store_with_fake_pg()
        chunks = [{"content": "plain text", "start_char": 0, "end_char": 10, "chunk_sequence": 0}]
        embeddings = [None]

        with patch("src.vector_store.psycopg2.extras.execute_values") as mock_execute_values:
            store.store_chunks(chunks, embeddings, "job-1", "user-1")

        rows = mock_execute_values.call_args[0][2]
        assert rows[0][-1] == []

    def test_mention_dict_gains_uri_additively_in_entity_mentions_json(self):
        import json
        store = self._make_store_with_fake_pg()
        chunks = [{"content": "Acme is here.", "start_char": 0, "end_char": 13, "chunk_sequence": 0}]
        embeddings = [None]
        mentions = [[
            {"text": "Acme", "type": "organization", "label": "organization",
             "uri": "databorg:u1/organization/acme"},
        ]]

        with patch("src.vector_store.psycopg2.extras.execute_values") as mock_execute_values:
            store.store_chunks(chunks, embeddings, "job-1", "user-1", entity_mentions=mentions)

        rows = mock_execute_values.call_args[0][2]
        stored_mentions = json.loads(rows[0][9])  # entity_mentions column
        assert stored_mentions[0]["name"] == "Acme"
        assert stored_mentions[0]["uri"] == "databorg:u1/organization/acme"
