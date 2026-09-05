"""Hebbian retrieval prior (src/hebb.py): heat lifts, bonus is capped, neighbours
join below their anchor and within budget, and nothing ever raises."""

import math

from src import hebb


def _chunks(n):
    return [{"chunk_id": f"c{i}", "text": f"t{i}", "score": 0.6} for i in range(n)]


class TestHeatBonus:
    def test_zero_heat_no_bonus(self):
        assert hebb.heat_bonus(0.0) == 0.0
        assert hebb.heat_bonus(None) == 0.0

    def test_heat_one_lifts_about_three_ranks(self):
        ranks = hebb.heat_bonus(1.0) / hebb.RANK_STEP
        assert 3 <= ranks <= 4

    def test_bonus_is_capped(self):
        assert hebb.heat_bonus(1e6) == hebb.PRIOR_CAP
        assert math.isclose(hebb.heat_bonus(10.0), min(hebb.PRIOR_CAP, 0.1 * math.log1p(10.0)))


class TestApplyPrior:
    def test_no_heat_keeps_order(self):
        out = hebb.apply_prior(_chunks(5), {}, [], 5)
        assert [c["chunk_id"] for c in out] == ["c0", "c1", "c2", "c3", "c4"]
        assert all(c["hebb_bonus"] == 0.0 for c in out)

    def test_heat_lifts_a_chunk_by_the_expected_ranks(self):
        # heat 1 ≈ 0.069 bonus ≈ 3.5 ranks: c4 climbs over c3, c2, c1 but not c0.
        out = hebb.apply_prior(_chunks(5), {"c4": 1.0}, [], 5)
        assert [c["chunk_id"] for c in out] == ["c0", "c4", "c1", "c2", "c3"]
        assert out[1]["hebb_bonus"] > 0

    def test_cap_cannot_override_a_far_better_hit(self):
        # 20 positions = 0.4 base gap > PRIOR_CAP 0.3: c19 never reaches c0.
        out = hebb.apply_prior(_chunks(20), {"c19": 1e9}, [], 20)
        ids = [c["chunk_id"] for c in out]
        assert ids[0] == "c0"
        # 0.62 + 0.3 = 0.92 ties c4 (0.92); the candidate wins the tie → index 5.
        assert ids.index("c19") == 5

    def test_neighbour_lands_just_below_its_anchor(self):
        nb = [("c0", {"chunk_id": "n1", "text": "n", "score": 0.35}, 1.0)]
        out = hebb.apply_prior(_chunks(6), {}, nb, 6)
        ids = [c["chunk_id"] for c in out]
        # score(n1) = 1.0 - 0.05 = 0.95 → between c2 (0.96) and c3 (0.94)
        assert ids == ["c0", "c1", "c2", "n1", "c3", "c4"]
        n1 = out[3]
        assert n1["via"] == "coactivation" and n1["coactivation_weight"] == 1.0

    def test_weak_neighbour_lands_lower_than_strong_one(self):
        nb = [("c0", {"chunk_id": "n1", "text": "n"}, 1.0),
              ("c0", {"chunk_id": "n2", "text": "n"}, 0.2)]
        out = hebb.apply_prior(_chunks(20), {}, nb, 20)
        ids = [c["chunk_id"] for c in out]
        assert ids.index("n1") < ids.index("n2")
        # weight 0.2 → 1.0 - 0.05 - 0.16 = 0.79 → after c10 (0.80), before c11 (0.78)
        assert ids.index("n2") == ids.index("c10") + 1

    def test_neighbour_budget_is_limit_over_four(self):
        nb = [("c0", {"chunk_id": f"n{i}", "text": "n"}, 0.9) for i in range(10)]
        out = hebb.apply_prior(_chunks(8), {}, nb, 8)
        assert sum(1 for c in out if c.get("via") == "coactivation") == 2
        assert len(out) == 8
        out5 = hebb.apply_prior(_chunks(5), {}, nb, 5)
        assert sum(1 for c in out5 if c.get("via") == "coactivation") == 1

    def test_neighbour_already_present_or_below_min_weight_is_skipped(self):
        nb = [("c0", {"chunk_id": "c1", "text": "dup"}, 1.0),
              ("c0", {"chunk_id": "n1", "text": "weak"}, 0.1),
              ("zz", {"chunk_id": "n2", "text": "orphan"}, 1.0)]
        out = hebb.apply_prior(_chunks(4), {}, nb, 8)
        assert [c["chunk_id"] for c in out] == ["c0", "c1", "c2", "c3"]

    def test_result_is_cut_to_limit_and_input_untouched(self):
        src = _chunks(6)
        out = hebb.apply_prior(src, {"c5": 5.0}, [], 3)
        assert len(out) == 3
        assert "hebb_bonus" not in src[0]

    def test_empty_input(self):
        assert hebb.apply_prior([], {"x": 1.0}, [], 5) == []


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


class TestLoaderAndWrapper:
    def test_loader_reads_heats_and_scoped_neighbours(self):
        conn = _Conn([
            [("c0", 2.0), ("c1", 0.0)],                       # heats
            [("c0", "n1", 0.8), ("n2", "c1", 0.4), ("c0", "c1", 0.9)],  # pairs (c0-c1 is internal)
            [("n1", "text n1", [{"name": "Acme"}], "job", None)],       # scoped neighbour rows
        ])
        heats, nbs = hebb.load_prior_inputs(conn, "u1", _chunks(2), max_rank=2, compilation_id="comp")
        assert heats == {"c0": 2.0, "c1": 0.0}
        assert len(nbs) == 1
        anchor, ch, w = nbs[0]
        assert anchor == "c0" and w == 0.8
        assert ch["chunk_id"] == "n1" and ch["entity_mentions"] == ["Acme"] and ch["score"] == hebb.NEIGHBOUR_CONFIDENCE
        # The neighbour lookup carried owner, archived, clearance and compilation scope.
        sql = conn.cur.calls[2][0]
        for needle in ("user_id = %(uid)s", "archived = false", "min_rank", "compilation_id"):
            assert needle in sql

    def test_loader_without_user_applies_heat_only(self):
        conn = _Conn([[("c0", 1.0)]])
        heats, nbs = hebb.load_prior_inputs(conn, None, _chunks(1), None, None)
        assert heats == {"c0": 1.0} and nbs == []
        assert len(conn.cur.calls) == 1

    def test_wrapper_never_raises(self):
        def boom():
            raise RuntimeError("pg down")
        src = _chunks(4)
        assert hebb.rerank_with_memory(src, user_id="u", limit=3, max_rank=None,
                                       compilation_id=None, conn_factory=boom) == src[:3]
        assert hebb.rerank_with_memory(src, user_id="u", limit=3, max_rank=None,
                                       compilation_id=None, conn_factory=lambda: None) == src[:3]
        assert hebb.rerank_with_memory([], user_id="u", limit=3, max_rank=None,
                                       compilation_id=None, conn_factory=boom) == []

    def test_wrapper_end_to_end(self):
        conn = _Conn([
            [("c0", 0.0), ("c1", 0.0), ("c2", 0.0), ("c3", 3.0)],
            [("c0", "n1", 0.9)],
            [("n1", "pulled", [], None, None)],
        ])
        out = hebb.rerank_with_memory(_chunks(4), user_id="u", limit=4, max_rank=None,
                                      compilation_id=None, conn_factory=lambda: conn)
        ids = [c["chunk_id"] for c in out]
        # heat 3 → bonus 0.139 ≈ 7 ranks: c3 to the top; n1 (0.93) after c2 (0.96).
        assert ids == ["c3", "c0", "c1", "c2"] or ids == ["c3", "c0", "c1", "n1"]
        assert len(out) == 4
