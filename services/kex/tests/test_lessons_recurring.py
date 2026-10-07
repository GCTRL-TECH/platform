"""A lesson becomes team knowledge when it is proven in enough projects."""

from src.lessons_recurring import group_recurring


INFO = {
    "a": {"heat": 8.0, "compilations": {"p1"}, "promoted": False},
    "b": {"heat": 2.0, "compilations": {"p2"}, "promoted": False},
    "c": {"heat": 1.5, "compilations": {"p3"}, "promoted": False},
    "cold": {"heat": 0.2, "compilations": {"p4"}, "promoted": False},
    "team": {"heat": 9.0, "compilations": {"team"}, "promoted": True},
}


def test_three_projects_with_warm_peers_form_one_group():
    groups = group_recurring(["a"], {"a": [("b", 0.95), ("c", 0.93), ("cold", 0.97), ("team", 0.99)]}, INFO)
    assert groups == [{"representative": "a", "lessonIds": ["a", "b", "c"], "compilationIds": ["p1", "p2", "p3"]}]


def test_cold_peers_and_promoted_copies_do_not_count():
    groups = group_recurring(["a"], {"a": [("cold", 0.97), ("team", 0.99), ("b", 0.95)]}, INFO)
    assert groups == []


def test_a_member_does_not_start_a_second_group():
    neigh = {"a": [("b", 0.95), ("c", 0.93)], "b": [("a", 0.95), ("c", 0.92)]}
    groups = group_recurring(["a", "b"], neigh, INFO)
    assert [g["representative"] for g in groups] == ["a"]
