"""The merge keeps what it decided: real LIMES scores, every matcher per pair,
a canonical member that does not change between runs, and one trail record per
link."""

from src.limes_client import ResolverClient
from src.merger import (
    _canonical_by_uri, _dedup_links, _link_records, _link_score, _order_members,
)


def _e(uri, name, typ):
    return {"uri": uri, "name": name, "type": typ}


ENTITIES = {
    "u/nr":  _e("u/nr", "Nordlicht Robotics", "organization"),
    "u/nrg": _e("u/nrg", "Nordlicht Robotics GmbH", "organization"),
    "u/dmt": _e("u/dmt", "Dr. Maren Thiele", "person"),
    "u/mt":  _e("u/mt", "Maren Thiele", "person"),
}


# ── LIMES result parsing ─────────────────────────────────────────────

def test_tab_output_carries_the_real_score_and_band():
    client = ResolverClient("http://unused")
    text = "<u/mt>\t<u/dmt>\t0.6190476190476191\n<u/nr>\t<u/nrg>\t0.7\n"
    links = client._parse_links(text, method="resolver_review")
    assert [(l["source"], l["target"]) for l in links] == [("u/mt", "u/dmt"), ("u/nr", "u/nrg")]
    assert links[0]["confidence"] == links[0]["limes_score"] == 0.6190476190476191
    assert {l["band"] for l in links} == {"review"}
    assert {l["method"] for l in links} == {"resolver_review"}


def test_accepted_file_is_the_accepted_band():
    links = ResolverClient("http://unused")._parse_links("<a>\t<b>\t1.0", method="resolver")
    assert links[0]["band"] == "accepted" and links[0]["confidence"] == 1.0


def test_n3_lines_still_parse_instead_of_yielding_nothing():
    text = "<a> <http://www.w3.org/2002/07/owl#sameAs> <b> ."
    links = ResolverClient("http://unused")._parse_links(text, method="resolver")
    assert len(links) == 1 and (links[0]["source"], links[0]["target"]) == ("a", "b")
    assert "limes_score" not in links[0]


def test_garbage_lines_are_ignored():
    assert ResolverClient("http://unused")._parse_links("# c\n\nnot a link\n<a>\t<b>\tx") == []


# ── dedup ────────────────────────────────────────────────────────────

def test_dedup_keeps_best_score_and_every_method():
    links = [
        {"source": "u/mt", "target": "u/dmt", "confidence": 0.62, "limes_score": 0.62,
         "band": "review", "method": "resolver_review"},
        {"source": "u/dmt", "target": "u/mt", "confidence": 0.81, "method": "resolver_fallback"},
        {"source": "u/mt", "target": "u/dmt", "confidence": 0.9, "method": "smart"},
    ]
    (link,) = _dedup_links(links)
    assert link["confidence"] == 0.9
    assert link["methods"] == ["resolver_fallback", "resolver_review", "smart"]
    # what LIMES itself said survives another matcher winning the pair
    assert link["band"] == "review" and link["limes_score"] == 0.62


def test_dedup_accepts_conex_links_without_confidence():
    links = [
        {"source": "a", "target": "b", "score": 0.7, "method": "conex"},
        {"source": "b", "target": "a", "confidence": 0.5, "method": "resolver_fallback"},
    ]
    (link,) = _dedup_links(links)
    assert _link_score(link) == 0.7 and link["methods"] == ["conex", "resolver_fallback"]


def test_dedup_is_idempotent():
    once = _dedup_links([{"source": "a", "target": "b", "confidence": 0.5, "method": "smart"}])
    assert _dedup_links(once) == once


# ── canonical member ─────────────────────────────────────────────────

def test_canonical_member_does_not_depend_on_input_order():
    links = [{"source": "u/mt", "target": "u/dmt", "confidence": 0.6, "method": "resolver"}]
    for members in (["u/mt", "u/dmt"], ["u/dmt", "u/mt"]):
        clusters = {0: list(members)}
        _order_members(clusters, ENTITIES, links)
        # equal link degree → the fullest written form names the merged node
        assert clusters[0][0] == "u/dmt"


def test_most_linked_member_wins_over_the_longest_name():
    entities = dict(ENTITIES, **{"u/x": _e("u/x", "M. Thiele", "person")})
    links = [
        {"source": "u/mt", "target": "u/dmt", "confidence": 0.6, "method": "resolver"},
        {"source": "u/mt", "target": "u/x", "confidence": 0.9, "method": "smart"},
    ]
    clusters = {0: ["u/x", "u/dmt", "u/mt"]}
    _order_members(clusters, entities, links)
    assert clusters[0][0] == "u/mt"


# ── trail records ────────────────────────────────────────────────────

def test_one_record_per_link_with_the_merged_node_it_ended_in():
    links = _dedup_links([
        {"source": "u/nrg", "target": "u/nr", "confidence": 0.7, "limes_score": 0.7,
         "band": "review", "method": "resolver_review"},
        {"source": "u/mt", "target": "u/gone", "confidence": 0.9, "method": "smart"},
    ])
    clusters = {0: ["u/nr", "u/nrg"], 1: ["u/dmt", "u/mt"]}
    records = _link_records(links, ENTITIES, _canonical_by_uri(clusters, ENTITIES), "cid")
    assert records == [{
        "source_uri": "u/nr", "target_uri": "u/nrg",
        "source_name": "Nordlicht Robotics", "target_name": "Nordlicht Robotics GmbH",
        "entity_type": "organization",
        "methods": ["resolver_review"], "score": 0.7, "limes_score": 0.7, "band": "review",
        "merged_uri": "Nordlicht Robotics_organization_cid",
    }]
