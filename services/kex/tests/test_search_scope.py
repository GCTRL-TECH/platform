"""Hard job scope of /search (src/search_scope.py) — the knowledge-base boundary a
KB-scoped access token must never cross. Pure parts only, so this runs offline:
normalization + the empty short-circuit, the SQL/Qdrant filter builders, the final
post-Hebbian guard, and the Hebbian neighbour lookup carrying the scope.

main.py itself is not importable without the full worker stack, so its wiring is
pinned by a source guard at the bottom (same idea as the api-rs call-site guards).
"""

import pathlib
import re

from src import hebb, search_scope

JOB_A = "11111111-1111-1111-1111-111111111111"
JOB_B = "22222222-2222-2222-2222-222222222222"


class TestNormalize:
    def test_none_means_unscoped(self):
        assert search_scope.normalize_job_ids(None) is None
        assert search_scope.denies_all(None) is False

    def test_empty_list_denies_everything(self):
        assert search_scope.normalize_job_ids([]) == []
        assert search_scope.denies_all([]) is True

    def test_canonicalizes_and_dedupes(self):
        out = search_scope.normalize_job_ids([JOB_A.upper(), f" {JOB_A} ", JOB_B])
        assert out == [JOB_A, JOB_B]
        assert search_scope.denies_all(out) is False

    def test_non_uuid_entries_are_dropped_and_all_invalid_fails_closed(self):
        assert search_scope.normalize_job_ids(["nope", JOB_A, None, 7]) == [JOB_A]
        only_junk = search_scope.normalize_job_ids(["nope", "'; DROP TABLE text_chunks;--"])
        assert only_junk == [] and search_scope.denies_all(only_junk)

    def test_accepts_list_subclasses_and_tuples(self):
        # The prod image is Cython-compiled: an exact-`list` param would reject these.
        class L(list):
            pass
        assert search_scope.normalize_job_ids(L([JOB_A])) == [JOB_A]
        assert search_scope.normalize_job_ids((JOB_A,)) == [JOB_A]


class TestSqlClause:
    def test_unscoped_adds_nothing(self):
        assert search_scope.sql_clause(None) == (None, {})

    def test_scoped_is_a_parameterized_any(self):
        clause, params = search_scope.sql_clause([JOB_A, JOB_B], column="tc.job_id")
        assert clause == "tc.job_id = ANY(%(jobs)s::uuid[])"
        assert params == {"jobs": [JOB_A, JOB_B]}
        assert JOB_A not in clause  # ids travel as a bound param, never inlined

    def test_empty_scope_still_yields_a_clause(self):
        # `= ANY('{}')` matches no row — an empty scope can never widen to "no filter".
        clause, params = search_scope.sql_clause([])
        assert clause is not None and params == {"jobs": []}


class TestQdrantCondition:
    def test_unscoped_adds_nothing(self):
        assert search_scope.qdrant_condition(None) is None

    def test_scoped_matches_any_on_the_job_id_payload(self):
        cond = search_scope.qdrant_condition([JOB_A, JOB_B])
        assert cond.key == "job_id"
        assert list(cond.match.any) == [JOB_A, JOB_B]


class TestFilterChunks:
    def _chunks(self):
        return [
            {"chunk_id": "a", "job_id": JOB_A},
            {"chunk_id": "foreign", "job_id": JOB_B},
            {"chunk_id": "nojob", "job_id": None},
            {"chunk_id": "missing"},
            {"chunk_id": "a-upper", "job_id": JOB_A.upper()},
        ]

    def test_unscoped_is_identity(self):
        chunks = self._chunks()
        assert search_scope.filter_chunks(chunks, None) is chunks

    def test_foreign_and_jobless_chunks_are_dropped(self):
        kept = search_scope.filter_chunks(self._chunks(), [JOB_A])
        assert [c["chunk_id"] for c in kept] == ["a", "a-upper"]

    def test_empty_scope_drops_everything(self):
        assert search_scope.filter_chunks(self._chunks(), []) == []

    def test_coactivated_neighbour_outside_scope_is_removed_after_hebb(self):
        # What /search does: apply_prior may pull a neighbour in, the guard runs last.
        ranked = [{"chunk_id": "c0", "job_id": JOB_A, "text": "t", "score": 0.6}]
        neighbour = {"chunk_id": "n1", "job_id": JOB_B, "text": "foreign", "score": 0.35}
        out = hebb.apply_prior(ranked, {}, [("c0", neighbour, 0.9)], 4)
        assert [c["chunk_id"] for c in out] == ["c0", "n1"]
        assert [c["chunk_id"] for c in search_scope.filter_chunks(out, [JOB_A])] == ["c0"]


class _Cursor:
    def __init__(self, rows_by_call):
        self._rows = rows_by_call
        self.calls = []

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def execute(self, sql, params=None):
        self.calls.append((sql, params))

    def fetchall(self):
        return self._rows.pop(0) if self._rows else []


class _Conn:
    def __init__(self, rows_by_call):
        self.cur = _Cursor(rows_by_call)

    def cursor(self):
        return self.cur


class TestHebbNeighbourScope:
    def _conn(self):
        return _Conn([[("c0", 0.0)], [("c0", "n1", 0.8)], []])

    def test_neighbour_lookup_carries_the_job_scope(self):
        conn = self._conn()
        hebb.load_prior_inputs(conn, "u1", [{"chunk_id": "c0"}], None, None, [JOB_A])
        sql, params = conn.cur.calls[2]
        assert "job_id = ANY(%(jobs)s::uuid[])" in sql
        assert params["jobs"] == [JOB_A]

    def test_unscoped_neighbour_lookup_is_unchanged(self):
        conn = self._conn()
        hebb.load_prior_inputs(conn, "u1", [{"chunk_id": "c0"}], None, None)
        sql, params = conn.cur.calls[2]
        assert "job_id = ANY" not in sql and "jobs" not in params

    def test_wrapper_passes_the_scope_through(self):
        conn = self._conn()
        hebb.rerank_with_memory([{"chunk_id": "c0", "job_id": JOB_A}], user_id="u1", limit=4,
                                max_rank=None, compilation_id=None,
                                conn_factory=lambda: conn, job_ids=[JOB_A])
        assert conn.cur.calls[2][1]["jobs"] == [JOB_A]


class TestSearchEndpointWiring:
    """Source guard over main.py (not importable offline). A refactor that drops
    one of these lines silently re-opens the cross-KB chunk leak."""

    SRC = (pathlib.Path(__file__).resolve().parents[1] / "src" / "main.py").read_text(encoding="utf-8")

    def _fn(self, name):
        m = re.search(rf"^(?:async )?def {name}\(.*?(?=^(?:async )?def |^@app\.|^class )", self.SRC, re.S | re.M)
        assert m, f"{name} not found in main.py"
        return m.group(0)

    def test_request_model_has_the_field(self):
        assert re.search(r"job_ids:\s*Optional\[list\[str\]\]\s*=\s*None", self.SRC)

    def test_dense_channel_filters_inside_the_shared_conditions(self):
        body = self._fn("_dense_search")
        helper = body[body.index("def _owner_clearance_conditions"):body.index("must_conditions =")]
        assert "search_scope.qdrant_condition(req.job_ids)" in helper
        # The compilation fallback must rebuild from the SAME helper (job scope kept).
        assert "fallback_conds = _owner_clearance_conditions()" in body

    def test_lexical_channel_filters_both_queries(self):
        body = self._fn("_lexical_search")
        assert body.count("search_scope.sql_clause(req.job_ids") == 2  # tsquery + ILIKE

    def test_endpoint_short_circuits_carries_and_guards(self):
        body = self._fn("search_endpoint")
        norm = body.index("search_scope.normalize_job_ids(req.job_ids)")
        deny = body.index("search_scope.denies_all(req.job_ids)")
        embed = body.index("get_embedding_client().embed")
        assert norm < deny < embed, "empty scope must return before any retrieval work"
        corpus = body[body.index("corpus_req = SearchReq("):body.index("corpus_lex =")]
        assert "job_ids=req.job_ids" in corpus, "whole-corpus fallback lost the job scope"
        hebb_call = body.index("hebb.rerank_with_memory(")
        guard = body.index("search_scope.filter_chunks(reranked, req.job_ids)")
        assert "job_ids=req.job_ids" in body[hebb_call:guard]
        assert hebb_call < guard < body.index('return {"chunks": reranked}')
