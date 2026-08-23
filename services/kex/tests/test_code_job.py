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


class TestDeleteChunksBySource:
    def test_deletes_pg_rows_and_qdrant_points(self):
        from src.vector_store import VectorStore, _as_uuid

        store = VectorStore(qdrant_url="http://fake-qdrant:6333", pg_url="postgresql://fake/db")
        fake_conn = MagicMock()
        fake_cursor = MagicMock()
        fake_cursor.rowcount = 4
        fake_conn.cursor.return_value.__enter__.return_value = fake_cursor
        store._pg_conn = fake_conn
        qc = MagicMock()
        store._qdrant = qc
        store._collection_ready = True

        out = store.delete_chunks_by_source("user-1", "comp-1", ["a.py", "b.py"])

        sql, params = fake_cursor.execute.call_args.args
        assert "DELETE FROM text_chunks" in sql
        assert params[2] == [_as_uuid("a.py"), _as_uuid("b.py")]
        assert out["pg_deleted"] == 4
        assert qc.delete.called
        sel = qc.delete.call_args.kwargs["points_selector"]
        keys = [c.key for c in sel.must if hasattr(c, "key")]
        assert "user_id" in keys and "compilation_id" in keys and "source_document_id" in keys

    def test_no_ids_is_noop(self):
        from src.vector_store import VectorStore
        store = VectorStore(qdrant_url="http://fake-qdrant:6333", pg_url="postgresql://fake/db")
        assert store.delete_chunks_by_source("u", "c", []) == {"pg_deleted": 0, "qdrant_ok": True}


def _sample_payload():
    return {
        "job_id": "job-1", "user_id": "user-1", "compilation_id": "comp-1",
        "repo": {"name": "demo", "root": "/r", "commit": "abc"},
        "files": [{
            "path": "a.py", "sha256": "deadbeef", "lang": "python",
            "symbols": [
                {"kind": "function", "name": "a.py::f", "line_start": 1, "line_end": 3,
                 "signature": "def f()", "doc": "", "exported": True},
                {"kind": "function", "name": "b.py::g", "stub": True, "file": "b.py"},
                {"kind": "module", "name": "os"},
            ],
            "edges": [
                {"type": "CONTAINS", "head": "a.py", "tail": "a.py::f", "confidence": 1.0, "resolution": "syntax"},
                {"type": "CALLS", "head": "a.py::f", "tail": "b.py::g", "confidence": 0.6, "resolution": "heuristic"},
                {"type": "IMPORTS", "head": "a.py", "tail": "os", "confidence": 1.0, "resolution": "syntax"},
            ],
            "chunks": [{"symbol": "a.py::f", "content": "a.py:L1-L3 def f()\n    return 1"}],
        }],
        "removed": ["gone.py"],
    }


class TestBuildEntitiesRelations:
    def test_maps_symbols_edges_repo_and_stubs(self):
        from src.code_job import build_entities_relations
        entities, relations, keep = build_entities_relations(_sample_payload())
        by_name = {e["text"]: e for e in entities}
        # file node carries sha256 + _file = its own path
        assert by_name["a.py"]["type"] == "file"
        assert by_name["a.py"]["props"]["sha256"] == "deadbeef"
        assert by_name["a.py"]["props"]["_file"] == "a.py"
        # symbol props
        f = by_name["a.py::f"]
        assert f["coarse_type"] == "code" and f["type"] == "function"
        assert f["props"]["line_start"] == 1 and f["props"]["_repo"] == "demo"
        # stub gets its own file, not the batch file
        assert by_name["b.py::g"]["props"]["_file"] == "b.py"
        # module import target
        assert by_name["os"]["type"] == "module" and "_file" not in by_name["os"]["props"]
        # repo node + CONTAINS repo->file
        assert by_name["demo"]["type"] == "repo" and by_name["demo"]["props"]["commit"] == "abc"
        assert any(r["head"] == "demo" and r["tail"] == "a.py" and r["type"] == "CONTAINS" for r in relations)
        # every edge owned by the batch file
        for r in relations:
            assert r["props"]["_file"] == "a.py" and r["props"]["_repo"] == "demo"
        calls = [r for r in relations if r["type"] == "CALLS"][0]
        assert calls["props"]["resolution"] == "heuristic" and calls["confidence"] == 0.6
        # keep set: uris of the real symbols of a.py (file + f), not the stub
        from src.kg_builder import entity_uri
        assert keep["a.py"] == {entity_uri("user-1", "file", "a.py"), entity_uri("user-1", "function", "a.py::f")}

    def test_chunk_dicts_have_store_chunks_keys(self):
        from src.code_job import build_chunk_dicts
        chunks, mentions = build_chunk_dicts(_sample_payload()["files"][0], "user-1")
        assert set(chunks[0]) >= {"content", "start_char", "end_char", "chunk_sequence"}
        assert chunks[0]["chunk_sequence"] == 0 and chunks[0]["start_char"] == 0
        assert mentions[0][0]["text"] == "a.py::f" and mentions[0][0]["uri"].startswith("databorg:")

    def test_real_symbol_props_win_over_earlier_stub(self):
        from src.code_job import build_entities_relations
        from src.kg_builder import entity_uri
        payload = {
            "job_id": "job-1", "user_id": "user-1", "compilation_id": "comp-1",
            "repo": {"name": "demo", "root": "/r", "commit": "abc"},
            "files": [
                {
                    "path": "a.py", "sha256": "aaa", "lang": "python",
                    "symbols": [
                        {"kind": "function", "name": "b.py::g", "stub": True, "file": "b.py"},
                    ],
                    "edges": [],
                    "chunks": [],
                },
                {
                    "path": "b.py", "sha256": "bbb", "lang": "python",
                    "symbols": [
                        {"kind": "function", "name": "b.py::g", "line_start": 3, "line_end": 5,
                         "signature": "def g()", "exported": True},
                    ],
                    "edges": [],
                    "chunks": [],
                },
            ],
            "removed": [],
        }
        entities, relations, keep = build_entities_relations(payload)
        by_name = {e["text"]: e for e in entities}
        # single entity for the symbol, not two
        assert sum(1 for e in entities if e["text"] == "b.py::g") == 1
        g = by_name["b.py::g"]
        assert g["props"]["line_start"] == 3
        assert g["props"]["_file"] == "b.py"
        # keep set: b.py owns the real symbol, a.py's stub does not claim it
        assert entity_uri("user-1", "function", "b.py::g") in keep["b.py"]
        assert entity_uri("user-1", "function", "b.py::g") not in keep.get("a.py", set())

    def test_real_symbol_props_win_over_later_stub(self):
        from src.code_job import build_entities_relations
        payload = {
            "job_id": "job-1", "user_id": "user-1", "compilation_id": "comp-1",
            "repo": {"name": "demo", "root": "/r", "commit": "abc"},
            "files": [
                {
                    "path": "b.py", "sha256": "bbb", "lang": "python",
                    "symbols": [
                        {"kind": "function", "name": "b.py::g", "line_start": 3, "line_end": 5,
                         "signature": "def g()", "exported": True},
                    ],
                    "edges": [],
                    "chunks": [],
                },
                {
                    "path": "a.py", "sha256": "aaa", "lang": "python",
                    "symbols": [
                        {"kind": "function", "name": "b.py::g", "stub": True, "file": "b.py"},
                    ],
                    "edges": [],
                    "chunks": [],
                },
            ],
            "removed": [],
        }
        entities, relations, keep = build_entities_relations(payload)
        by_name = {e["text"]: e for e in entities}
        assert sum(1 for e in entities if e["text"] == "b.py::g") == 1
        assert by_name["b.py::g"]["props"]["line_start"] == 3


class TestRunCodeJob:
    def test_orchestrates_purge_write_chunks(self):
        from src.code_job import run_code_job
        kg = MagicMock()
        kg.build_graph.return_value = {"entities_created": 5, "relations_created": 3, "nodes_total": 10, "graph_uris": []}
        kg.purge_code_file_edges.return_value = 2
        kg.purge_code_symbols.return_value = 1
        vs = MagicMock()
        vs.store_chunks.return_value = 1
        vs.delete_chunks_by_source.return_value = {"pg_deleted": 1, "qdrant_ok": True}
        embedder = MagicMock()
        embedder.embed_batch.side_effect = lambda texts: [[0.0] * 3 for _ in texts]

        result = run_code_job(_sample_payload(), kg, vs, embedder, {"id": None, "name": "PUBLIC", "rank": 0})

        # purge edges for changed + removed, chunks for changed + removed
        kg.purge_code_file_edges.assert_called_once_with("user-1", "demo", ["a.py", "gone.py"])
        vs.delete_chunks_by_source.assert_called_once_with("user-1", "comp-1", ["a.py", "gone.py"])
        # removed file: all symbols dropped
        kg.purge_code_symbols.assert_any_call("user-1", "demo", "gone.py", [])
        # changed file: stale symbols dropped after write, keeping the fresh ones
        changed_call = [c for c in kg.purge_code_symbols.call_args_list if c.args[2] == "a.py"][0]
        assert len(changed_call.args[3]) == 2
        # write + chunks
        assert kg.build_graph.called
        kw = vs.store_chunks.call_args.kwargs
        assert kw["compilation_id"] == "comp-1" and kw["source_document_id"] == "a.py"
        assert result["status"] == "completed" and result["files_indexed"] == 1 and result["files_removed"] == 1
        assert result["vector_stats"]["chunks_stored"] == 1
