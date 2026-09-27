"""Merged relations follow the entity clusters onto the canonical node.

Regression (2026-09-28, Bifroest demo): a 2-document merge linked "Maren Thiele" /
"Dr. Maren Thiele" and "Nordlicht Robotics" / "Nordlicht Robotics GmbH" correctly,
but _merge_relations looked the merged endpoints up by the RAW name. Merged nodes
exist only under the canonical member's name, so 4 of 5 relations were dropped.
Data below is the real raw graph from that run.
"""

from src.merger import _canonical_by_uri, _group_relations_onto_canonical


def _e(uri, name, typ):
    return {"uri": uri, "name": name, "type": typ}


ENTITIES = {
    "u/nr":   _e("u/nr", "Nordlicht Robotics", "organization"),
    "u/nrg":  _e("u/nrg", "Nordlicht Robotics GmbH", "organization"),
    "u/dmt":  _e("u/dmt", "Dr. Maren Thiele", "person"),
    "u/mt":   _e("u/mt", "Maren Thiele", "person"),
    "u/kiel": _e("u/kiel", "Kiel", "location"),
    "u/ors":  _e("u/ors", "Orsted A/S", "organization"),
    "u/uk":   _e("u/uk", "Universitaet Kiel", "organization"),
}
# members[0] is the canonical pick, exactly as in _write_merged_graph.
CLUSTERS = {0: ["u/nr", "u/nrg"], 1: ["u/dmt", "u/mt"], 2: ["u/kiel"], 3: ["u/ors"], 4: ["u/uk"]}


def _rel(h, t, typ):
    a, b = ENTITIES[h], ENTITIES[t]
    return {"head_uri": h, "tail_uri": t, "head_name": a["name"], "head_type": a["type"],
            "rel_type": typ, "tail_name": b["name"], "tail_type": b["type"]}


RAW = [
    _rel("u/nrg", "u/kiel", "LOCATED_IN"),
    _rel("u/dmt", "u/nrg", "FOUNDED"),
    _rel("u/nrg", "u/ors", "RELATED_TO"),
    _rel("u/mt", "u/nr", "FOUNDED"),
    _rel("u/nr", "u/uk", "RELATED_TO"),
]


def test_every_member_maps_to_its_canonical_node():
    m = _canonical_by_uri(CLUSTERS, ENTITIES)
    assert m["u/nrg"] == ("Nordlicht Robotics", "organization")
    assert m["u/mt"] == ("Dr. Maren Thiele", "person")
    assert m["u/kiel"] == ("Kiel", "location")


def test_no_relation_is_lost_and_aliases_collapse():
    grouped = _group_relations_onto_canonical(RAW, _canonical_by_uri(CLUSTERS, ENTITIES))
    keys = set(grouped)
    assert keys == {
        ("Nordlicht Robotics", "organization", "LOCATED_IN", "Kiel", "location"),
        ("Dr. Maren Thiele", "person", "FOUNDED", "Nordlicht Robotics", "organization"),
        ("Nordlicht Robotics", "organization", "RELATED_TO", "Orsted A/S", "organization"),
        ("Nordlicht Robotics", "organization", "RELATED_TO", "Universitaet Kiel", "organization"),
    }
    # The two FOUNDED readings (one per document) become ONE merged edge with both sources.
    assert len(grouped[("Dr. Maren Thiele", "person", "FOUNDED",
                        "Nordlicht Robotics", "organization")]) == 2


def test_edge_inside_one_cluster_is_dropped_not_self_looped():
    rel = _rel("u/nrg", "u/nr", "RELATED_TO")
    assert _group_relations_onto_canonical([rel], _canonical_by_uri(CLUSTERS, ENTITIES)) == {}


def test_without_mapping_raw_names_are_kept():
    grouped = _group_relations_onto_canonical(RAW[:1], {})
    assert list(grouped) == [("Nordlicht Robotics GmbH", "organization", "LOCATED_IN", "Kiel", "location")]
