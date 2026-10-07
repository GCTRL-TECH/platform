"""The matcher learns from confirmed merges: which pairs count as evidence, what
LIMES is asked, how its answer is read, and when a learned rule may go live."""

from src.learn import (
    MAX_LEAVES, decide, default_name_metric, ls_to_rule, method_family,
    ml_config_xml, parse_learned, pick_positives, preview, prf, rule_supported,
    training_csv,
)


# ── Evidence selection ───────────────────────────────────────────────────────

def test_human_links_and_two_independent_matchers_count_resolver_alone_does_not():
    links = [
        ("u/a", "u/b", "person", ["human"], 1.0),
        ("u/c", "u/d", "person", ["resolver", "smart"], 0.9),
        ("u/e", "u/f", "person", ["resolver", "resolver_review"], 0.95),   # one opinion twice
        ("u/g", "u/h", "person", ["embedding-name", "embedding-desc"], 0.99),  # one family
        ("u/i", "u/j", "person", ["resolver", "apoc"], 0.5),              # agreed but weak
        ("u/k", "u/k", "person", ["human"], 1.0),                         # self pair
    ]
    positives, cannot = pick_positives(links, [], 0.85)
    assert positives == {"person": {("u/a", "u/b"), ("u/c", "u/d")}}
    assert cannot == {}


def test_review_decisions_add_and_forbid_pairs_per_type():
    links = [("u/x", "u/y", "Organization", ["resolver", "smart"], 0.9)]
    reviews = [
        ("u/y", "u/x", "organization", "not_same"),   # reversed order, same pair
        ("u/p", "u/q", "organization", "same"),
        ("u/r", "u/s", "organization", None),          # undecided
    ]
    positives, cannot = pick_positives(links, reviews, 0.85)
    assert positives == {"organization": {("u/p", "u/q")}}
    assert cannot == {"organization": {("u/x", "u/y")}}


def test_method_families_fold_variants():
    assert method_family("resolver_fallback") == "resolver"
    assert method_family("embedding-model") == "embedding"
    assert method_family("apoc") == "apoc"


# ── What LIMES is asked ──────────────────────────────────────────────────────

def test_training_csv_is_two_columns_with_an_id_header():
    text = training_csv({("u/b", "u/a,x")})
    assert text.splitlines() == ["id_source,id_target", "u/b,u/a x"]


def test_ml_config_learns_instead_of_running_a_metric():
    xml = ml_config_xml("src-id", "tgt-id", "/.server-storage/files/t.csv",
                        ["name", "type", "label"], 0.85, 0.55)
    assert "<METRIC>" not in xml
    assert "<NAME>wombat simple</NAME>" in xml
    assert "<TYPE>supervised batch</TYPE>" in xml
    assert "<TRAINING>/.server-storage/files/t.csv</TRAINING>" in xml
    assert '<!DOCTYPE LIMES SYSTEM "limes.dtd">' in xml
    assert xml.index("<TARGET>") < xml.index("<MLALGORITHM>") < xml.index("<ACCEPTANCE>")
    assert xml.count("<PROPERTY>label AS lowercase</PROPERTY>") == 2


def test_default_metric_mirrors_the_length_adaptive_floor():
    assert "|0.4," in default_name_metric(["Acme", "Volkswagen"])
    assert "|0.55," in default_name_metric(["A very long composite publication title | authors | venue 2021"])


# ── Reading the answer ───────────────────────────────────────────────────────

LOG = """12:00:01 [t] [abc] INFO  o.a.l.c.m.a.WombatSimple:120 - Learned: jaccard(x.name,y.name)|0.6 with threshold: 0.6
12:00:02 [t] [abc] INFO  o.a.l.c.c.MLPipeline:79 - Learned: AND(jaccard(x.name,y.name)|0.57, cosine(x.label,y.label)|0.4) with threshold: 0.57
12:00:02 [t] [abc] INFO  Mapping task finished in 812 ms
"""


def test_last_learned_line_wins_and_becomes_a_structured_rule():
    ls, threshold = parse_learned(LOG)
    assert ls == "AND(jaccard(x.name,y.name)|0.57, cosine(x.label,y.label)|0.4)"
    assert threshold == 0.57
    rule = ls_to_rule(ls, threshold)
    assert rule == {
        "operator": "AND",
        "leaves": [
            {"measure": "jaccard", "property": "name", "threshold": 0.57},
            {"measure": "cosine", "property": "label", "threshold": 0.4},
        ],
        "threshold": 0.57,
    }


def test_no_learned_line_means_none_and_an_atom_has_no_operator():
    assert parse_learned("nothing here") is None
    assert ls_to_rule("trigrams(x.name,y.name)|0.5", 0.5)["operator"] == "ATOM"


def test_prf_is_order_insensitive():
    p, r, f = prf({("b", "a"), ("c", "d")}, {("a", "b"), ("e", "f")})
    assert (p, r) == (0.5, 0.5) and abs(f - 0.5) < 1e-9
    assert prf(set(), {("a", "b")}) == (0.0, 0.0, 0.0)


# ── The gate ─────────────────────────────────────────────────────────────────

def test_a_better_rule_goes_live_a_worse_one_is_only_proposed():
    assert decide(0.95, 0.80, 0, 2, 0.8, True)[0] == "active"
    assert decide(0.80, 0.80, 0, 2, 0.8, True)[0] == "proposed"
    assert decide(0.95, 0.80, 0, 2, 0.8, False)[0] == "proposed"


def test_only_rules_the_merge_can_run_are_supported():
    ok = ls_to_rule("AND(jaccard(x.name,y.name)|0.57, cosine(x.label,y.label)|0.4)", 0.57)
    assert rule_supported(ok)
    assert not rule_supported(ls_to_rule("mongeelkan(x.name,y.name)|0.5", 0.5))       # unknown measure
    assert not rule_supported(ls_to_rule("jaccard(x.title,y.title)|0.5", 0.5))         # not exported
    assert not rule_supported({"operator": "AND", "leaves": [], "threshold": 0.5})
    assert preview(ok, 0.96, 0.7, 12) == (
        "jaccard(name) ≥ 0.57 AND cosine(label) ≥ 0.40 · learned from 12 confirmed pairs · "
        "F1 0.96 vs 0.70 for the default rule"
    )


def test_violations_weak_fit_and_too_many_leaves_drop_the_rule():
    assert decide(0.99, 0.5, 1, 2, 0.8, True)[0] is None
    assert decide(0.70, 0.5, 0, 2, 0.8, True)[0] is None
    assert decide(0.99, 0.5, 0, MAX_LEAVES + 1, 0.8, True)[0] is None
    assert decide(0.99, 0.5, 0, 0, 0.8, True)[0] is None
