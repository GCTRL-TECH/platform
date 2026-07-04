"""P3 — fact-conflict detection + recency authority (src/conflicts.py).

Mocking strategy (no DB/Neo4j needed, mirrors test_source_doc_provenance.py):
  - the Neo4j session is a MagicMock whose .run() returns scripted sibling-edge
    records; the Cypher text + params of every call are captured for asserting
    the authority SETs.
  - Postgres is bypassed by patching load_functional_relations (the registry)
    and _upsert_conflict / _dossier_trust (the fact_conflicts write + trust
    tiebreak), so the detection logic is exercised end-to-end in memory.

Precision-critical invariants pinned here:
  - a functional relation with 2 different values -> exactly one conflict,
    ranked  _source_doc_modified_at DESC -> asserted_at DESC -> trust DESC
    -> confidence DESC;
  - non-functional relations NEVER fire (false conflicts destroy trust);
  - any detection failure logs and never fails the extraction job.
"""

from unittest.mock import MagicMock, patch

import pytest

from src import conflicts


CEO_SPEC = {
    "relation": "ceo_of",
    "rel_type": "CEO_OF",
    "key_side": "tail",
    "key_type": "organization",
}


def _edge(value_uri, value_name, mtime=None, asserted=None, confidence=None,
          source_doc=None):
    return {
        "value_uri": value_uri,
        "value_name": value_name,
        "source_doc_modified_at": mtime,
        "asserted_at": asserted,
        "confidence": confidence,
        "source_doc": source_doc,
    }


def _session_returning(sibling_edges):
    """A fake Neo4j session: the FIRST .run() (the sibling query) yields the
    scripted edge records; subsequent .run() calls (authority SETs) yield []."""
    session = MagicMock()
    calls = {"n": 0}

    def run(cypher, **params):
        calls["n"] += 1
        result = MagicMock()
        rows = sibling_edges if calls["n"] == 1 else []
        result.__iter__ = lambda self: iter([_FakeRecord(r) for r in rows])
        return result

    session.run.side_effect = run
    return session


class _FakeRecord(dict):
    """dict(rec) must work like a neo4j Record."""


# ── authority ranking ────────────────────────────────────────────────────────

class TestAuthorityRanking:
    def test_source_doc_mtime_wins_over_everything(self):
        older_doc_high_conf = _edge("u:karl", "Karl", mtime=100, asserted=999,
                                    confidence=1.0)
        newer_doc_low_conf = _edge("u:petra", "Petra", mtime=200, asserted=1,
                                   confidence=0.1)
        ranked = conflicts.rank_edges([older_doc_high_conf, newer_doc_low_conf])
        assert ranked[0]["value_name"] == "Petra"

    def test_asserted_at_breaks_ties_when_mtime_equal_or_absent(self):
        a = _edge("u:karl", "Karl", mtime=None, asserted=100)
        b = _edge("u:petra", "Petra", mtime=None, asserted=200)
        ranked = conflicts.rank_edges([a, b])
        assert ranked[0]["value_name"] == "Petra"

    def test_edge_with_known_mtime_beats_edge_without(self):
        unknown = _edge("u:karl", "Karl", mtime=None, asserted=999)
        known = _edge("u:petra", "Petra", mtime=1, asserted=1)
        ranked = conflicts.rank_edges([unknown, known])
        assert ranked[0]["value_name"] == "Petra"

    def test_trust_then_confidence_as_final_tiebreaks(self):
        low_trust = dict(_edge("u:a", "A"), trust=0.1, confidence=0.9)
        high_trust = dict(_edge("u:b", "B"), trust=0.8, confidence=0.2)
        assert conflicts.rank_edges([low_trust, high_trust])[0]["value_name"] == "B"

        low_conf = dict(_edge("u:a", "A"), confidence=0.5)
        high_conf = dict(_edge("u:b", "B"), confidence=0.9)
        assert conflicts.rank_edges([low_conf, high_conf])[0]["value_name"] == "B"

    def test_garbage_values_never_raise(self):
        weird = _edge("u:x", "X", mtime="not-a-number", asserted=None)
        ok = _edge("u:y", "Y", mtime=5)
        assert conflicts.rank_edges([weird, ok])[0]["value_name"] == "Y"


# ── rel-type sanitiser parity ────────────────────────────────────────────────

class TestSafeRelType:
    def test_mirrors_kg_builder(self):
        from src.kg_builder import _safe_rel_type
        for raw in ("ceo_of", "located_in", "some-rel type!", "9lives", ""):
            assert conflicts.safe_rel_type(raw) == _safe_rel_type(raw)


# ── write-time detection (detect_for_job) ────────────────────────────────────

def _run_detection(relations, siblings, registry=None):
    """detect_for_job with a scripted registry + sibling edges. Returns
    (found, session, upserts) where upserts collects _upsert_conflict calls."""
    session = _session_returning(siblings)
    upserts = []

    def fake_upsert(conn, user_id, compilation_id, spec, key_uri, key_name,
                    tails, authority_winner):
        upserts.append({
            "spec": spec, "key_uri": key_uri, "key_name": key_name,
            "tails": tails, "winner": authority_winner,
            "compilation_id": compilation_id,
        })

    name_to_uri = {
        "synthetron gmbh": "databorg:u/organization/synthetron_gmbh",
        "karl mehner": "databorg:u/person/karl_mehner",
        "petra lausberg": "databorg:u/person/petra_lausberg",
    }
    with patch.object(conflicts, "load_functional_relations",
                      return_value=registry if registry is not None else [CEO_SPEC]), \
         patch.object(conflicts, "_upsert_conflict", side_effect=fake_upsert), \
         patch.object(conflicts, "_dossier_trust", return_value=0.0), \
         patch("psycopg2.connect", return_value=MagicMock()):
        found = conflicts.detect_for_job(
            session, "postgresql://fake/db", "user-1", relations, name_to_uri,
        )
    return found, session, upserts


CEO_RELATIONS = [
    {"head": "Petra Lausberg", "tail": "Synthetron GmbH", "type": "ceo_of"},
]

TWO_CEO_SIBLINGS = [
    _edge("databorg:u/person/karl_mehner", "Karl Mehner",
          mtime=None, asserted=100, confidence=0.9, source_doc="doc-old"),
    _edge("databorg:u/person/petra_lausberg", "Petra Lausberg",
          mtime=None, asserted=200, confidence=0.9, source_doc="doc-new"),
]


class TestDetectForJob:
    def test_conflict_created_with_recency_winner(self):
        found, session, upserts = _run_detection(CEO_RELATIONS, TWO_CEO_SIBLINGS)

        assert found == 1
        assert len(upserts) == 1
        up = upserts[0]
        assert up["spec"]["relation"] == "ceo_of"
        assert up["key_name"] == "Synthetron GmbH"
        assert up["winner"] == "Petra Lausberg"          # newer asserted_at
        assert up["compilation_id"] is None              # write-time, no comp
        # tails rebuilt from ALL siblings, winner first.
        assert [t["value"] for t in up["tails"]] == ["Petra Lausberg", "Karl Mehner"]
        assert up["tails"][0]["authority"] == "current"
        assert up["tails"][1]["authority"] == "superseded"

    def test_doc_mtime_outranks_asserted_at(self):
        siblings = [
            _edge("databorg:u/person/karl_mehner", "Karl Mehner",
                  mtime=2_000, asserted=100, source_doc="doc-karl"),
            _edge("databorg:u/person/petra_lausberg", "Petra Lausberg",
                  mtime=1_000, asserted=999, source_doc="doc-petra"),
        ]
        _found, _session, upserts = _run_detection(CEO_RELATIONS, siblings)
        assert upserts[0]["winner"] == "Karl Mehner"

    def test_authority_props_set_on_all_sibling_edges(self):
        _found, session, _up = _run_detection(CEO_RELATIONS, TWO_CEO_SIBLINGS)

        set_calls = [c for c in session.run.call_args_list
                     if "_authority" in str(c.args[0])]
        assert len(set_calls) == 2
        by_value = {c.kwargs["value_uri"]: c.kwargs for c in set_calls}
        winner = by_value["databorg:u/person/petra_lausberg"]
        loser = by_value["databorg:u/person/karl_mehner"]
        assert winner["authority"] == "current"
        assert winner["superseded_by"] is None
        assert loser["authority"] == "superseded"
        assert loser["superseded_by"] == "doc-new"       # the winner's doc

    def test_tail_keyed_relation_queries_by_tail_org(self):
        """ceo_of is keyed by the TAIL org: the sibling query must anchor on
        Synthetron's uri with the org as the arrow target."""
        _found, session, _up = _run_detection(CEO_RELATIONS, TWO_CEO_SIBLINGS)
        sibling_cypher = str(session.run.call_args_list[0].args[0])
        sibling_params = session.run.call_args_list[0].kwargs
        assert "-[r:`CEO_OF`]->(k:Entity {uri: $key_uri})" in sibling_cypher
        assert sibling_params["key_uri"] == "databorg:u/organization/synthetron_gmbh"
        assert sibling_params["key_type"] == "organization"

    def test_single_value_is_not_a_conflict(self):
        one = [TWO_CEO_SIBLINGS[0]]
        found, _session, upserts = _run_detection(CEO_RELATIONS, one)
        assert found == 0
        assert upserts == []

    def test_non_functional_relation_is_ignored(self):
        relations = [{"head": "Petra", "tail": "Synthetron GmbH", "type": "works_at"}]
        found, session, upserts = _run_detection(relations, TWO_CEO_SIBLINGS)
        assert found == 0
        assert upserts == []
        assert session.run.call_count == 0               # no queries at all

    def test_empty_registry_short_circuits(self):
        found, session, _up = _run_detection(CEO_RELATIONS, TWO_CEO_SIBLINGS,
                                             registry=[])
        assert found == 0
        assert session.run.call_count == 0

    def test_detection_never_raises(self):
        """Fail-safe contract: even an exploding session must not propagate."""
        session = MagicMock()
        session.run.side_effect = RuntimeError("neo4j down")
        with patch.object(conflicts, "load_functional_relations",
                          return_value=[CEO_SPEC]), \
             patch("psycopg2.connect", return_value=MagicMock()):
            found = conflicts.detect_for_job(
                session, "postgresql://fake/db", "user-1", CEO_RELATIONS,
                {"synthetron gmbh": "databorg:u/organization/synthetron_gmbh"},
            )
        assert found == 0


# ── kg_builder integration: failure can never fail the job ───────────────────

class TestBuildGraphFailureIsolation:
    def _builder_with_fake_driver(self):
        from src.kg_builder import KGBuilder
        builder = KGBuilder()
        builder._driver = MagicMock()
        fake_session = MagicMock()
        builder._driver.session.return_value.__enter__.return_value = fake_session
        fake_session.execute_write.return_value = 1
        fake_session.execute_read.return_value = 0
        return builder

    def test_conflict_detection_error_does_not_fail_extraction(self):
        from src.kg_builder import KGBuilder
        builder = self._builder_with_fake_driver()
        with patch.object(KGBuilder, "_load_corrected_triples", return_value=set()), \
             patch("src.conflicts.detect_for_job",
                   side_effect=RuntimeError("detection exploded")):
            stats = builder.build_graph(
                "job-1", "user-1", [],
                [{"head": "A", "tail": "B", "type": "ceo_of"}],
            )
        assert stats["relations_created"] == 1           # job still succeeded

    def test_build_graph_invokes_detection_with_written_relations(self):
        from src.kg_builder import KGBuilder
        builder = self._builder_with_fake_driver()
        relations = [{"head": "Petra", "tail": "Synthetron", "type": "ceo_of"}]
        with patch.object(KGBuilder, "_load_corrected_triples", return_value=set()), \
             patch("src.conflicts.detect_for_job", return_value=1) as mock_detect:
            builder.build_graph("job-1", "user-1", [], relations)
        assert mock_detect.called
        args = mock_detect.call_args.args
        assert args[2] == "user-1"
        assert args[3] == relations
