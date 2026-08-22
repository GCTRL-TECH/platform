"""Tests for the Codebase KB worker path (P1a).

Covers:
  - KGBuilder.build_graph applies entity/relation `props` via `+= $props`.
  - KGBuilder.purge_code_file_edges / purge_code_symbols build owner+repo+file scoped
    Cypher and keep the URIs they were told to keep.
  - code_job.build_entities_relations maps an IndexBatch file into the
    entity/relation dict contract (names, types, props, repo node, stubs).
  - code_job.build_chunk_dicts produces store_chunks-compatible dicts.
  - VectorStore.delete_chunks_by_source removes PG rows + Qdrant points by path.
"""

from unittest.mock import MagicMock, patch


def _builder_with_capturing_tx():
    from src.kg_builder import KGBuilder

    builder = KGBuilder()
    builder._driver = MagicMock()
    fake_session = MagicMock()
    builder._driver.session.return_value.__enter__.return_value = fake_session
    tx = MagicMock()
    tx.run.return_value.consume.return_value.counters.nodes_created = 1
    tx.run.return_value.consume.return_value.counters.relationships_created = 1
    tx.run.return_value.single.return_value = {"deleted": 3}
    # execute_write(fn, *args) -> call fn with our capturing tx
    fake_session.execute_write.side_effect = lambda fn, *args: fn(tx, *args)
    fake_session.execute_read.return_value = 0
    return builder, tx


class TestBuildGraphProps:
    def test_entity_props_are_passed_to_cypher(self):
        from src.kg_builder import KGBuilder
        from src import config as kex_config

        builder, tx = _builder_with_capturing_tx()
        entities = [{"text": "a.py::f", "type": "function", "coarse_type": "code", "label": "function",
                     "props": {"_repo": "r", "_file": "a.py", "line_start": 1, "line_end": 3}}]
        with patch.object(KGBuilder, "_load_corrected_triples", return_value=set()), \
             patch.object(kex_config, "GRAPH_PRUNE_ISOLATED", False):
            builder.build_graph("job-1", "user-1", entities, [])
        calls = [c for c in tx.run.call_args_list if "MERGE (n:Entity" in c.args[0]]
        assert calls, "entity MERGE not executed"
        cypher, kwargs = calls[0].args[0], calls[0].kwargs
        assert "n += $props" in cypher
        assert kwargs["props"] == {"_repo": "r", "_file": "a.py", "line_start": 1, "line_end": 3}

    def test_entity_without_props_sends_empty_map(self):
        from src.kg_builder import KGBuilder
        from src import config as kex_config

        builder, tx = _builder_with_capturing_tx()
        with patch.object(KGBuilder, "_load_corrected_triples", return_value=set()), \
             patch.object(kex_config, "GRAPH_PRUNE_ISOLATED", False):
            builder.build_graph("job-1", "user-1", [{"text": "X", "type": "person"}], [])
        calls = [c for c in tx.run.call_args_list if "MERGE (n:Entity" in c.args[0]]
        assert calls[0].kwargs["props"] == {}

    def test_relation_props_are_passed_to_cypher(self):
        from src.kg_builder import KGBuilder
        from src import config as kex_config

        builder, tx = _builder_with_capturing_tx()
        entities = [{"text": "a.py::f", "type": "function", "coarse_type": "code"},
                    {"text": "a.py::g", "type": "function", "coarse_type": "code"}]
        relations = [{"head": "a.py::f", "type": "CALLS", "tail": "a.py::g", "confidence": 0.6,
                      "props": {"_repo": "r", "_file": "a.py", "resolution": "heuristic"}}]
        with patch.object(KGBuilder, "_load_corrected_triples", return_value=set()), \
             patch.object(kex_config, "GRAPH_PRUNE_ISOLATED", False):
            builder.build_graph("job-1", "user-1", entities, relations)
        rel_calls = [c for c in tx.run.call_args_list if "MERGE (h)-[r:" in c.args[0]]
        assert rel_calls, "relation MERGE not executed"
        assert "r += $props" in rel_calls[0].args[0]
        assert rel_calls[0].kwargs["props"]["resolution"] == "heuristic"

    def test_code_is_a_keep_type(self):
        from src import config as kex_config
        assert "code" in kex_config.GRAPH_KEEP_TYPES


class TestPurgeHelpers:
    def test_purge_file_edges_cypher_scopes_owner_repo_file(self):
        from src.kg_builder import KGBuilder
        builder, tx = _builder_with_capturing_tx()
        n = builder.purge_code_file_edges("user-1", "r", ["a.py", "b.py"])
        cypher, kw = tx.run.call_args.args[0], tx.run.call_args.kwargs
        assert "MATCH ()-[r]->()" in cypher
        assert "r._owner = $owner" in cypher and "r._repo = $repo" in cypher and "r._file IN $paths" in cypher
        assert kw["paths"] == ["a.py", "b.py"] and kw["owner"] == "user-1"
        assert n == 3

    def test_purge_symbols_keeps_listed_uris(self):
        from src.kg_builder import KGBuilder
        builder, tx = _builder_with_capturing_tx()
        builder.purge_code_symbols("user-1", "r", "a.py", ["databorg:user1/function/a_py_f"])
        cypher, kw = tx.run.call_args.args[0], tx.run.call_args.kwargs
        assert "n._file = $path" in cypher and "NOT n.uri IN $keep" in cypher
        assert "DETACH DELETE n" in cypher
        assert kw["keep"] == ["databorg:user1/function/a_py_f"]
