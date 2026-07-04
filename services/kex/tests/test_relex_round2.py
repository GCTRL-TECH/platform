"""Tests for the extraction-loop round-2 EXTRACTOR-SIDE fixes (see
bench/analysis-round2.md, proposals P1-P4; P5 is a gold-only fix, no test here).

  P1 — gap-fill prompt rule-sync: the main prompt and the gap-fill second-pass
       prompt now render the SAME shared rules block (single source of truth),
       plus a softened non-coercion line in the gap-fill FOCUS paragraph.
  P2 — deterministic post-validation pruning: self-link/variant filter,
       duplicate-variant dedup, specificity enforcement — all in code, no LLM.
  P3 — deterministic letterhead/address-block located_in pre-pass.
  P4 — tense contract v2 (reported-speech guard on worked_at) + reworked CV
       few-shot contrast pair, generic examples removed to bound prompt length.
"""

from unittest.mock import patch

import pytest


def _make_entity(text, label="person", coarse="person", start=None, end=None):
    e = {"text": text, "label": label, "coarse_type": coarse}
    if start is not None:
        e["start"] = start
    if end is not None:
        e["end"] = end
    return e


def _make_relation(head, rel_type, tail, confidence=0.9):
    return {"head": head, "type": rel_type, "tail": tail, "confidence": confidence}


# ── P1: gap-fill prompt rule-sync (single source of truth) ────────────────

class TestP1GapfillRuleSync:
    def test_shared_rules_constant_exists_and_is_nonempty(self):
        from src.relex import _SHARED_RELATION_RULES

        assert isinstance(_SHARED_RELATION_RULES, str)
        assert "MOST SPECIFIC relation only" in _SHARED_RELATION_RULES
        assert "refer to the SAME thing" in _SHARED_RELATION_RULES
        assert "develops(maker, product)" in _SHARED_RELATION_RULES
        assert "requirements/tooling list" in _SHARED_RELATION_RULES
        assert "speaks is ONLY for a human speaking a natural language" in _SHARED_RELATION_RULES

    def test_gapfill_prompt_contains_every_round1_rule_line(self):
        """The five round-1 rules (most-specific, anti-variant, product-maker,
        requirement-list exclusion, speaks-humans-only) must now appear in the
        gap-fill prompt too — round 1 only put them in the main prompt."""
        from src.relex import _build_gapfill_prompt

        prompt = _build_gapfill_prompt("some text", "  - Alice (person)", ["Alice"])

        assert "MOST SPECIFIC relation only" in prompt
        assert "ceo_of, heads, or founded" in prompt
        assert "refer to the SAME thing" in prompt
        assert "VaultSync-Modul" in prompt
        assert "develops(maker, product)" in prompt
        assert "do NOT use part_of between a product and its company" in prompt
        assert "requirements/tooling list" in prompt
        assert "speaks is ONLY for a human speaking a natural language" in prompt
        assert "Programming languages are has_skill, never speaks" in prompt

    def test_main_and_gapfill_prompts_render_the_identical_rules_block(self):
        """Single-source-of-truth assertion: both prompts must embed the exact
        same shared-rules text, not two independently-maintained copies that
        can drift out of sync (the round-2 bug being fixed)."""
        from src.relex import _build_prompt, _build_gapfill_prompt, _SHARED_RELATION_RULES

        main_prompt = _build_prompt("some text", "  - Alice (person)")
        gapfill_prompt = _build_gapfill_prompt("some text", "  - Alice (person)", ["Alice"])

        assert _SHARED_RELATION_RULES in main_prompt
        assert _SHARED_RELATION_RULES in gapfill_prompt

    def test_gapfill_prompt_softens_coercion_with_do_not_invent_line(self):
        from src.relex import _build_gapfill_prompt

        prompt = _build_gapfill_prompt("some text", "  - Alice (person)", ["Alice"])
        assert "leave it unconnected" in prompt
        assert "do NOT invent one" in prompt


# ── P2: deterministic post-validation pruning ──────────────────────────────

class TestP2SelfLinkFilter:
    def test_drops_exact_variant_self_link(self):
        """'NeuroGraph 5.0' PART_OF 'NeuroGraph' is a version-variant self-link."""
        from src.relex import RelationExtractor

        ext = RelationExtractor()
        relations = [_make_relation("NeuroGraph 5.0", "part_of", "NeuroGraph")]
        pruned, counts = ext._prune_relations(relations)

        assert pruned == []
        assert counts["pruned_self_link"] == 1

    def test_drops_compound_variant_self_link(self):
        """German Kompositum variant: 'ScanModule-Dienstes' vs 'ScanModule'."""
        from src.relex import RelationExtractor

        ext = RelationExtractor()
        relations = [_make_relation("ScanModule-Dienstes", "part_of", "ScanModule")]
        pruned, counts = ext._prune_relations(relations)

        assert pruned == []
        assert counts["pruned_self_link"] == 1

    def test_keeps_real_distinct_component_relation(self):
        """A genuine component relation between two DIFFERENT products must
        survive — distinct roots, no false positive."""
        from src.relex import RelationExtractor

        ext = RelationExtractor()
        relations = [_make_relation("VaultSync", "part_of", "NeuroGraph")]
        pruned, counts = ext._prune_relations(relations)

        assert pruned == relations
        assert counts["pruned_self_link"] == 0


class TestP2DuplicateVariantDedup:
    def test_collapses_variant_duplicate_keeping_max_confidence(self):
        """Two triples that are the SAME fact under root-normalization (product
        variant tail) collapse to one, keeping the higher-confidence row."""
        from src.relex import RelationExtractor

        ext = RelationExtractor()
        relations = [
            _make_relation("Nexovar", "develops", "NeuroGraph", confidence=0.9),
            _make_relation("Nexovar", "develops", "NeuroGraph Enterprise SaaS", confidence=0.7),
        ]
        pruned, counts = ext._prune_relations(relations)

        assert len(pruned) == 1
        assert pruned[0]["tail"] == "NeuroGraph"
        assert counts["pruned_dup_variant"] == 1

    def test_distinct_facts_are_not_collapsed(self):
        """Two unrelated facts (different roots) must both survive untouched."""
        from src.relex import RelationExtractor

        ext = RelationExtractor()
        relations = [
            _make_relation("Nexovar", "develops", "NeuroGraph", confidence=0.9),
            _make_relation("Nexovar", "develops", "VaultSync", confidence=0.9),
        ]
        pruned, counts = ext._prune_relations(relations)

        assert len(pruned) == 2
        assert counts["pruned_dup_variant"] == 0


class TestP2SpecificityEnforcement:
    def test_drops_works_at_when_ceo_of_exists_for_same_pair(self):
        from src.relex import RelationExtractor

        ext = RelationExtractor()
        relations = [
            _make_relation("Alice", "ceo_of", "Acme"),
            _make_relation("Alice", "works_at", "Acme"),
        ]
        pruned, counts = ext._prune_relations(relations)

        assert len(pruned) == 1
        assert pruned[0]["type"] == "ceo_of"
        assert counts["pruned_specificity"] == 1

    def test_works_at_survives_for_a_different_pair(self):
        """Specificity enforcement must be scoped to the EXACT same pair — a
        works_at fact for a different person/org combination is untouched."""
        from src.relex import RelationExtractor

        ext = RelationExtractor()
        relations = [
            _make_relation("Alice", "ceo_of", "Acme"),
            _make_relation("Bob", "works_at", "Acme"),
        ]
        pruned, counts = ext._prune_relations(relations)

        assert len(pruned) == 2
        assert counts["pruned_specificity"] == 0


class TestP2PruneIntegratedIntoExtractionReport:
    def test_report_exposes_all_three_prune_counters(self):
        from src.relex import RelationExtractor
        from src import config

        entities = [
            _make_entity("Alice", "person", "person", 0, 5),
            _make_entity("Acme", "organization", "organization", 20, 24),
        ]
        with patch("src.relex.llm_client") as mock_client, \
             patch.object(config, "RELEX_GAPFILL_ENABLED", False), \
             patch.object(config, "RELEX_WINDOW_CHARS", 6000), \
             patch.object(config, "RELEX_MIN_CONFIDENCE", 0.0):
            mock_client.complete.return_value = "[]"
            ext = RelationExtractor()
            _, report = ext.extract_relations("Alice works at Acme.", entities, kind="ollama")

        assert "pruned_self_link" in report
        assert "pruned_dup_variant" in report
        assert "pruned_specificity" in report


# ── P3: letterhead / address-block located_in pre-pass ─────────────────────

class TestP3LetterheadPrePass:
    def test_extracts_located_in_from_german_address_block(self):
        from src.relex import _letterhead_located_in_pairs

        text = (
            "Nexovar GmbH\n"
            "Kaiserstrasse 47\n"
            "60329 Frankfurt\n"
            "\n"
            "Sehr geehrte Damen und Herren, ...\n"
        )
        entities = [
            _make_entity("Nexovar GmbH", "organization", "organization"),
            _make_entity("Frankfurt", "location", "location"),
        ]
        pairs = _letterhead_located_in_pairs(text, entities)

        assert {"head": "Nexovar GmbH", "type": "located_in", "tail": "Frankfurt", "confidence": 0.85} in pairs

    def test_extracts_located_in_from_us_address_block(self):
        from src.relex import _letterhead_located_in_pairs

        text = (
            "Nexovar Inc.\n"
            "850 Congress Avenue, Suite 1100\n"
            "Austin, TX 78701\n"
        )
        entities = [
            _make_entity("Nexovar Inc.", "organization", "organization"),
            _make_entity("Austin", "location", "location"),
        ]
        pairs = _letterhead_located_in_pairs(text, entities)

        assert any(
            r["head"] == "Nexovar Inc." and r["tail"] == "Austin" and r["type"] == "located_in"
            for r in pairs
        )

    def test_skips_when_city_not_in_entity_list(self):
        """No invented tails: if the city isn't a known NER entity, emit nothing."""
        from src.relex import _letterhead_located_in_pairs

        text = (
            "Nexovar GmbH\n"
            "Kaiserstrasse 47\n"
            "60329 Frankfurt\n"
        )
        entities = [
            _make_entity("Nexovar GmbH", "organization", "organization"),
            # Frankfurt is deliberately NOT in the entity list.
        ]
        pairs = _letterhead_located_in_pairs(text, entities)

        assert pairs == []

    def test_skips_when_org_not_mentioned_nearby(self):
        """A postal-code+city line with no org mention within the lookback
        window must not fabricate a head."""
        from src.relex import _letterhead_located_in_pairs

        text = (
            "Some unrelated heading\n"
            "Another line\n"
            "Yet another line\n"
            "60329 Frankfurt\n"
        )
        entities = [
            _make_entity("Nexovar GmbH", "organization", "organization"),
            _make_entity("Frankfurt", "location", "location"),
        ]
        pairs = _letterhead_located_in_pairs(text, entities)

        assert pairs == []

    def test_letterhead_pairs_merged_into_extraction_report(self):
        from src.relex import RelationExtractor
        from src import config

        text = (
            "Nexovar GmbH\n"
            "Kaiserstrasse 47\n"
            "60329 Frankfurt\n"
            "\n"
            "Alice arbeitet bei Nexovar GmbH.\n"
        )
        entities = [
            _make_entity("Nexovar GmbH", "organization", "organization", start=0, end=12),
            _make_entity("Frankfurt", "location", "location", start=30, end=39),
            _make_entity("Alice", "person", "person", start=41, end=46),
        ]
        with patch("src.relex.llm_client") as mock_client, \
             patch.object(config, "RELEX_GAPFILL_ENABLED", False), \
             patch.object(config, "RELEX_WINDOW_CHARS", 6000), \
             patch.object(config, "RELEX_MIN_CONFIDENCE", 0.0):
            mock_client.complete.return_value = "[]"
            ext = RelationExtractor()
            relations, report = ext.extract_relations(text, entities, kind="ollama")

        assert report["letterhead_added"] == 1
        assert any(
            r["head"] == "Nexovar GmbH" and r["tail"] == "Frankfurt" and r["type"] == "located_in"
            for r in relations
        )


# ── P4: tense contract v2 + reworked CV few-shot ────────────────────────────

class TestP4TenseContractV2:
    def test_worked_at_desc_has_reported_speech_negative_cue(self):
        from src import relvocab

        desc = relvocab.RELATIONS["worked_at"]["desc"]
        assert "NOT for current employees mentioned in past-tense narration" in desc
        assert "berichtete" in desc
        assert "presented" in desc
        # The round-1 wording must still be present (this is additive, not a rewrite).
        assert "PREVIOUSLY worked at organization Y" in desc
        assert "PAST employment only" in desc
        assert "if current, use works_at" in desc

    def test_prompt_renders_reported_speech_guard(self):
        from src.relex import _build_prompt

        prompt = _build_prompt("some text", "  - Alice (person)")
        assert "NOT for current employees mentioned in past-tense narration" in prompt

    def test_prompt_contains_tense_contrast_pair_in_one_line(self):
        from src.relex import _build_prompt

        prompt = _build_prompt("some text", "  - Alice (person)")
        assert '"Acme (June 2023 - present)" -> works_at' in prompt
        assert '"Beta Corp (2019 - 2023)" -> worked_at' in prompt

    def test_generic_direction_examples_removed(self):
        """Carol/Delta examples were low-value; removed to pay for the new
        contrast-pair line so net prompt length stays ~0."""
        from src.relex import _build_prompt

        prompt = _build_prompt("some text", "  - Alice (person)")
        assert "Carol uses a tool" not in prompt
        assert "Delta calls a service" not in prompt
