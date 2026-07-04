"""Tests for the extraction-loop round-1 EXTRACTOR-SIDE fixes (see
bench/analysis-round1.md, proposals R2/R3/R5/R6).

  R2 — configurable RELEX_NUM_PREDICT (default 2048, was a hardcoded 1024) +
       truncated-JSON salvage in _parse_json_array (recovers complete triple
       objects from a cut-off response instead of returning []).
  R3 — tense contract in relvocab descs (works_at=present, worked_at=past)
       + a most-specific-relation prompt rule.
  R5 — two located_in few-shots (address block / letterhead, parenthetical).
  R6 — anti-variant / anti-generic-linking / speaks-humans-only prompt rules.
"""

import json
from unittest.mock import patch

import pytest


def _make_entity(text, label="person", coarse="person", start=None, end=None):
    e = {"text": text, "label": label, "coarse_type": coarse}
    if start is not None:
        e["start"] = start
    if end is not None:
        e["end"] = end
    return e


# ── R2: num_predict is now configurable ───────────────────────────────────────

class TestR2NumPredictConfigurable:
    def test_default_num_predict_is_2048(self):
        from src import config
        assert config.RELEX_NUM_PREDICT == 2048

    def test_num_predict_threaded_from_config_to_llm_client(self):
        """A non-default RELEX_NUM_PREDICT must reach llm_client.complete's options."""
        from src.relex import RelationExtractor
        from src import config

        with patch("src.relex.llm_client") as mock_client, \
             patch.object(config, "RELEX_NUM_PREDICT", 3000), \
             patch.object(config, "RELEX_GAPFILL_ENABLED", False):
            mock_client.complete.return_value = "[]"

            ext = RelationExtractor()
            ext.extract_relations(
                "Alice is the CEO of Acme.",
                [_make_entity("Alice"), _make_entity("Acme", "organization", "organization")],
                kind="ollama", ollama_base="http://ollama:11434", model="qwen2.5:7b",
            )

            assert mock_client.complete.called
            _args, kwargs = mock_client.complete.call_args
            assert kwargs.get("options", {}).get("num_predict") == 3000


# ── R2: truncated-JSON salvage ─────────────────────────────────────────────────

class TestR2TruncatedSalvage:
    def test_salvage_recovers_complete_objects_from_truncated_array(self):
        """A response cut off mid-second-object must still yield the first,
        complete triple instead of the parser returning []."""
        from src.relex import RelationExtractor

        ext = RelationExtractor()
        truncated = (
            '[{"head": "Alice", "relation": "ceo_of", "tail": "Acme"}, '
            '{"head": "Bob", "relation": "works_at", "tail": "Acme'
        )
        result = ext._parse_json_array(truncated)

        assert result == [{"head": "Alice", "relation": "ceo_of", "tail": "Acme"}]
        assert ext.last_salvaged_count == 1

    def test_salvage_recovers_multiple_complete_objects(self):
        from src.relex import RelationExtractor

        ext = RelationExtractor()
        truncated = (
            '[{"head": "Alice", "relation": "ceo_of", "tail": "Acme"}, '
            '{"head": "Bob", "relation": "founded", "tail": "BetaCorp"}, '
            '{"head": "Carol", "relation": "works_at", "tail": "Gam'
        )
        result = ext._parse_json_array(truncated)

        assert result == [
            {"head": "Alice", "relation": "ceo_of", "tail": "Acme"},
            {"head": "Bob", "relation": "founded", "tail": "BetaCorp"},
        ]
        assert ext.last_salvaged_count == 2

    def test_clean_array_does_not_trigger_salvage(self):
        """A well-formed array must parse normally with last_salvaged_count == 0."""
        from src.relex import RelationExtractor

        ext = RelationExtractor()
        clean = json.dumps([{"head": "Alice", "relation": "ceo_of", "tail": "Acme"}])
        result = ext._parse_json_array(clean)

        assert result == [{"head": "Alice", "relation": "ceo_of", "tail": "Acme"}]
        assert ext.last_salvaged_count == 0

    def test_unparseable_garbage_returns_empty_and_zero_salvage(self):
        from src.relex import RelationExtractor

        ext = RelationExtractor()
        result = ext._parse_json_array("not json at all, no braces here")
        assert result == []
        assert ext.last_salvaged_count == 0

    def test_salvage_count_surfaces_in_extraction_report(self):
        """End-to-end: a truncated single-window response still produces a
        recovered relation, and the report counts the salvage (never silent)."""
        from src.relex import RelationExtractor
        from src import config

        entities = [
            _make_entity("Alice", "person", "person", 0, 5),
            _make_entity("Acme", "organization", "organization", 19, 23),
        ]
        # Second object is deliberately cut off mid-string to simulate num_predict truncation.
        truncated = (
            '[{"head": "Alice", "relation": "ceo_of", "tail": "Acme"}, '
            '{"head": "Alice", "relation": "works_at", "tail": "Acm'
        )

        with patch("src.relex.llm_client") as mock_client, \
             patch.object(config, "RELEX_WINDOW_CHARS", 6000), \
             patch.object(config, "RELEX_MAX_WINDOWS", 8), \
             patch.object(config, "RELEX_MIN_CONFIDENCE", 0.0), \
             patch.object(config, "RELEX_GAPFILL_ENABLED", False):
            mock_client.complete.return_value = truncated

            ext = RelationExtractor()
            relations, report = ext.extract_relations(
                "Alice is the CEO of Acme.", entities,
                kind="ollama", ollama_base="http://ollama:11434", model="qwen2.5:7b",
            )

        assert report["salvaged_truncated"] == 1
        assert any(r["type"] == "ceo_of" for r in relations)

    def test_report_has_salvaged_truncated_key_even_when_zero(self):
        """The report always exposes salvaged_truncated, defaulting to 0."""
        from src.relex import RelationExtractor
        from src import config

        entities = [
            _make_entity("Alice", "person", "person", 0, 5),
            _make_entity("Acme", "organization", "organization", 15, 19),
        ]
        with patch("src.relex.llm_client") as mock_client, \
             patch.object(config, "RELEX_GAPFILL_ENABLED", False), \
             patch.object(config, "RELEX_WINDOW_CHARS", 6000), \
             patch.object(config, "RELEX_MIN_CONFIDENCE", 0.0):
            mock_client.complete.return_value = "[]"
            ext = RelationExtractor()
            _, report = ext.extract_relations("Alice works at Acme.", entities, kind="ollama")

        assert report["salvaged_truncated"] == 0


# ── R3: tense contract (relvocab descs) + most-specific-relation prompt rule ──

class TestR3TenseContract:
    def test_works_at_desc_is_present_tense_only(self):
        from src import relvocab
        desc = relvocab.RELATIONS["works_at"]["desc"]
        assert "CURRENTLY works at organization Y" in desc
        assert "present tense" in desc

    def test_worked_at_desc_is_past_tense_only(self):
        from src import relvocab
        desc = relvocab.RELATIONS["worked_at"]["desc"]
        assert "PREVIOUSLY worked at organization Y" in desc
        assert "PAST employment only" in desc
        assert "if current, use works_at" in desc

    def test_prompt_renders_tense_contract(self):
        """The rendered vocab block (embedded in _build_prompt) must carry the
        new tense-disambiguated descriptions, not the old ambiguous one."""
        from src.relex import _build_prompt

        prompt = _build_prompt("some text", "  - Alice (person)")
        assert "CURRENTLY works at organization Y" in prompt
        assert "PREVIOUSLY worked at organization Y" in prompt
        # The old ambiguous phrasing must be gone.
        assert "(employment, current or past)" not in prompt

    def test_prompt_contains_most_specific_relation_rule(self):
        from src.relex import _build_prompt

        prompt = _build_prompt("some text", "  - Alice (person)")
        assert "MOST SPECIFIC relation only" in prompt
        assert "ceo_of, heads, or founded" in prompt
        assert "works_at(X,Y)" in prompt


# ── R5: located_in few-shots ───────────────────────────────────────────────────

class TestR5LocatedInFewShots:
    def test_prompt_contains_address_block_example(self):
        from src.relex import _build_prompt

        prompt = _build_prompt("some text", "  - Alice (person)")
        assert "Kaiserstrasse 12" in prompt
        assert '"head":"Acme GmbH","relation":"located_in","tail":"Frankfurt"' in prompt

    def test_prompt_contains_parenthetical_location_example(self):
        from src.relex import _build_prompt

        prompt = _build_prompt("some text", "  - Alice (person)")
        assert "Austin, TX" in prompt
        assert '"head":"Acme Inc.","relation":"located_in","tail":"Austin, TX"' in prompt


# ── R6: anti-variant / anti-generic-linking / speaks-humans-only rules ────────

class TestR6AntiVariantRules:
    def test_prompt_contains_anti_variant_rule(self):
        from src.relex import _build_prompt

        prompt = _build_prompt("some text", "  - Alice (person)")
        assert "refer to the SAME thing" in prompt
        assert "VaultSync-Modul" in prompt

    def test_prompt_contains_product_maker_rule(self):
        from src.relex import _build_prompt

        prompt = _build_prompt("some text", "  - Alice (person)")
        assert "develops(maker, product)" in prompt
        assert "do NOT use part_of between a product and its company" in prompt

    def test_prompt_contains_requirement_list_rule(self):
        from src.relex import _build_prompt

        prompt = _build_prompt("some text", "  - Alice (person)")
        assert "requirements/tooling list" in prompt

    def test_prompt_contains_speaks_human_only_rule(self):
        from src.relex import _build_prompt

        prompt = _build_prompt("some text", "  - Alice (person)")
        assert "speaks is ONLY for a human speaking a natural language" in prompt
        assert "Programming languages are has_skill, never speaks" in prompt
