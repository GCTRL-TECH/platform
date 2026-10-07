"""Merged elements list EVERY job that reached them, so a KEX job stays
revertable from a FUSED graph.

The API's ``purge_jobs`` removes a job from each element's ``_source_jobs`` and
deletes the element only when that list runs empty. Before 2026-10-07 a merged
node listed one job per member (the member's latest contributor) and a merged
edge listed none — so purging a job either deleted a merged node that other jobs
still backed, or left merged edges behind forever. ``_union_source_jobs`` is the
pure helper both the node and the edge writer now go through.
"""

from collections import OrderedDict, defaultdict

from src.merger import _union_source_jobs


def test_union_is_the_union_of_every_member_list():
    members = [
        {"source_job": "B", "source_jobs": ["A", "B"]},
        {"source_job": "C", "source_jobs": ["C"]},
    ]
    assert _union_source_jobs(members) == ["A", "B", "C"]


def test_union_dedups_and_keeps_first_seen_order():
    members = [
        {"source_job": "B", "source_jobs": ["B", "A"]},
        {"source_job": "A", "source_jobs": ["A", "C", "B"]},
    ]
    assert _union_source_jobs(members) == ["B", "A", "C"]


def test_member_without_list_falls_back_to_its_single_job():
    # Elements written before migration 075 carry only `_source_job`.
    members = [
        {"source_job": "A", "source_jobs": None},
        {"source_job": "B"},
    ]
    assert _union_source_jobs(members) == ["A", "B"]


def test_empty_list_falls_back_to_single_job_too():
    members = [{"source_job": "A", "source_jobs": []}]
    assert _union_source_jobs(members) == ["A"]


def test_blank_and_missing_jobs_are_skipped():
    members = [
        {"source_job": "", "source_jobs": None},
        {"source_job": None, "source_jobs": [None, "", "A"]},
        {},
    ]
    assert _union_source_jobs(members) == ["A"]


def test_latest_contributor_is_the_last_of_the_union():
    # The writers set `_source_job = last(_source_jobs)`; the helper's order is
    # what makes that deterministic.
    union = _union_source_jobs([
        {"source_job": "A", "source_jobs": ["A"]},
        {"source_job": "B", "source_jobs": ["B"]},
    ])
    assert union[-1] == "B"
    assert _union_source_jobs([]) == []


def test_accepts_mapping_subclasses_and_any_iterable():
    # The prod image is Cython-compiled: an exact-`dict`/`list` annotation would
    # reject these. The helper must take whatever the Neo4j driver or a grouping
    # step hands it.
    grouped = defaultdict(list)
    grouped["k"].append(OrderedDict(source_job="A", source_jobs=["A", "B"]))
    assert _union_source_jobs(tuple(grouped["k"])) == ["A", "B"]


def test_union_restricted_to_allowed_jobs():
    # A raw node two jobs produced keeps both; after job A left THIS compilation
    # its merged copy must list only what the compilation still draws from.
    members = [{"source_jobs": ["A", "B"]}, {"source_jobs": ["C"], "source_job": "C"}]
    assert _union_source_jobs(members, ["B", "C"]) == ["B", "C"]
    assert _union_source_jobs(members, allowed=set()) == []
    assert _union_source_jobs(members, None) == ["A", "B", "C"]
