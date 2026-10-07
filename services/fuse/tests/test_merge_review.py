"""Merge review: only doubtful merges reach the queue, and human decisions bind
later merges (a confirmed pair joins, a split pair never shares a cluster)."""

from src.merger import (
    REVIEW_MAX_OPEN, _fold_allowed, _pair_key, _review_candidates,
)


def _rec(a, b, score, methods, bridge=True):
    return {"source_uri": a, "target_uri": b, "score": score, "methods": methods,
            "bridge": bridge, "cluster_size": 2}


def test_only_single_method_bridges_below_acceptance_are_candidates():
    records = [
        _rec("u/a", "u/b", 0.62, ["resolver_review"]),           # doubtful → candidate
        _rec("u/c", "u/d", 0.62, ["resolver_review", "smart"]),  # an independent matcher agrees
        _rec("u/k", "u/l", 0.70, ["resolver_fallback", "resolver_review"]),  # same signal twice → candidate
        {**_rec("u/m", "u/n", 0.86, ["resolver_fallback", "resolver_review"]), "limes_score": 0.68},  # LIMES doubted it
        _rec("u/e", "u/f", 0.95, ["smart"]),                      # above acceptance
        _rec("u/g", "u/h", 0.60, ["resolver_review"], bridge=False),  # other links hold the cluster
        _rec("u/i", "u/j", 0.50, ["human"]),                      # a human already said so
    ]
    picked = _review_candidates(records, threshold_accept=0.85)
    assert [(r["source_uri"], r["target_uri"]) for r in picked] == [("u/a", "u/b"), ("u/m", "u/n"), ("u/k", "u/l")]


def test_least_certain_first_and_capped():
    records = [_rec(f"u/{i:03}", f"v/{i:03}", 0.40 + i / 100, ["resolver_review"]) for i in range(40)]
    picked = _review_candidates(records, threshold_accept=0.85)
    assert len(picked) == REVIEW_MAX_OPEN
    assert [r["score"] for r in picked] == sorted(r["score"] for r in picked)
    assert picked[0]["source_uri"] == "u/000"


def test_pair_key_is_order_free():
    assert _pair_key("u/b", "u/a") == _pair_key("u/a", "u/b") == ("u/a", "u/b")


def test_forbidden_pair_blocks_the_fold_even_through_a_chain():
    cannot = {_pair_key("u/a", "u/c")}
    # a~b already clustered; a link b~c would pull c next to a → refused
    assert not _fold_allowed(["u/a", "u/b"], ["u/c"], cannot)
    assert not _fold_allowed(["u/c"], ["u/a", "u/b"], cannot)
    # unrelated clusters still fold
    assert _fold_allowed(["u/a", "u/b"], ["u/d"], cannot)
    assert _fold_allowed(["u/a"], ["u/b"], set())
