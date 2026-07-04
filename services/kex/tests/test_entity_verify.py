"""Tests for the opt-in LLM entity verify/retype precision tier (entity_verify.py).

Panel-endorsed architecture: GLiNER stays the only span producer. This module
only VERIFIES (keep/drop) or RETYPES a GLiNER candidate via the configured
generation LLM — it never invents a span. These tests mock the LLM client
(src.entity_verify.llm_client) so no real network/model is needed.
"""

import json

import pytest
from unittest.mock import patch


def _entity(text, start, end, etype, score=0.8):
    return {
        "start": start,
        "end": end,
        "text": text,
        "type": etype,
        "coarse_type": etype,
        "score": score,
        "gliner_label": etype,
        "label": etype,
    }


# ── (a) junk dropped, real entity kept ──────────────────────────────────────

class TestJunkDropped:
    def test_junk_dropped_person_kept(self):
        from src.entity_verify import verify_entities

        text = "async wrapper built by Dr. Sarah Chen for the project."
        entities = [
            _entity("async wrapper", 0, 13, "technology"),
            _entity("Dr. Sarah Chen", 24, 38, "person"),
        ]
        llm_response = json.dumps([
            {"id": 0, "keep": False, "corrected_type": "technology"},
            {"id": 1, "keep": True, "corrected_type": "person"},
        ])

        with patch("src.entity_verify.llm_client") as mock_client:
            mock_client.complete.return_value = llm_response

            kept, report = verify_entities(
                entities, text,
                model="qwen2.5:7b", base="http://ollama:11434", kind="ollama",
            )

        assert len(kept) == 1
        assert kept[0]["text"] == "Dr. Sarah Chen"
        assert report["dropped_junk"] == 1
        assert report["verified"] == 2
        assert report["llm_calls"] == 1

    def test_none_base_falls_back_to_config_ollama_base(self):
        """Regression: the default install passes no per-job ollama_base, so
        `base` arrives None. Without the config fallback, base=None hits
        llm_client.complete's `base.rstrip("/")` and the whole verify pass
        errors out (dropping nothing). Verify it resolves to config.OLLAMA_BASE
        and the LLM is actually called."""
        from src import config
        from src.entity_verify import verify_entities

        text = "async wrapper built by Dr. Sarah Chen for the project."
        entities = [
            _entity("async wrapper", 0, 13, "technology"),
            _entity("Dr. Sarah Chen", 24, 38, "person"),
        ]
        llm_response = json.dumps([
            {"id": 0, "keep": False, "corrected_type": "technology"},
            {"id": 1, "keep": True, "corrected_type": "person"},
        ])

        with patch("src.entity_verify.llm_client") as mock_client:
            mock_client.complete.return_value = llm_response

            kept, report = verify_entities(
                entities, text,
                model="qwen2.5:7b", base=None, kind="ollama",
            )

        assert report.get("error") is None
        assert report["llm_calls"] == 1
        assert report["dropped_junk"] == 1
        # base kwarg the client was actually called with is config.OLLAMA_BASE
        _, kwargs = mock_client.complete.call_args
        called_base = kwargs.get("base") if "base" in kwargs else mock_client.complete.call_args[0][2]
        assert called_base == config.OLLAMA_BASE


# ── (b) retype ───────────────────────────────────────────────────────────────

class TestRetype:
    def test_berlin_person_retyped_to_location(self):
        from src.entity_verify import verify_entities

        text = "Founded by our team in Berlin, the company grew fast."
        entities = [
            _entity("Berlin", 23, 29, "person"),
        ]
        llm_response = json.dumps([
            {"id": 0, "keep": True, "corrected_type": "location"},
        ])

        with patch("src.entity_verify.llm_client") as mock_client:
            mock_client.complete.return_value = llm_response

            kept, report = verify_entities(
                entities, text,
                model="qwen2.5:7b", base="http://ollama:11434", kind="ollama",
            )

        assert len(kept) == 1
        assert kept[0]["type"] == "location"
        assert kept[0]["coarse_type"] == "location"
        assert report["retyped"] == 1
        assert report["dropped_junk"] == 0


# ── (c) offsets/scores preserved on kept entities ───────────────────────────

class TestOffsetsPreserved:
    def test_offsets_and_score_preserved(self):
        from src.entity_verify import verify_entities

        text = "Dr. Sarah Chen works at Acme Corp in Berlin."
        entities = [
            _entity("Dr. Sarah Chen", 0, 14, "person", score=0.87),
        ]
        llm_response = json.dumps([
            {"id": 0, "keep": True, "corrected_type": "person"},
        ])

        with patch("src.entity_verify.llm_client") as mock_client:
            mock_client.complete.return_value = llm_response

            kept, _report = verify_entities(
                entities, text,
                model="qwen2.5:7b", base="http://ollama:11434", kind="ollama",
            )

        assert len(kept) == 1
        assert kept[0]["start"] == 0
        assert kept[0]["end"] == 14
        assert kept[0]["score"] == 0.87
        assert kept[0]["text"] == "Dr. Sarah Chen"


# ── (d) LLM error → original entities returned unchanged (recall safety) ───

class TestLLMErrorFailsSafe:
    def test_llm_error_returns_original_entities_unchanged(self):
        from src.entity_verify import verify_entities

        text = "Dr. Sarah Chen works at Acme Corp."
        entities = [
            _entity("Dr. Sarah Chen", 0, 14, "person"),
            _entity("Acme Corp", 24, 33, "organization"),
        ]

        with patch("src.entity_verify.llm_client") as mock_client:
            mock_client.complete.side_effect = RuntimeError("connection refused")

            kept, report = verify_entities(
                entities, text,
                model="qwen2.5:7b", base="http://ollama:11434", kind="ollama",
            )

        assert kept == entities
        assert len(kept) == 2
        assert "error" in report

    def test_unparseable_response_does_not_lose_entities(self):
        """A response the parser can't recover ANY objects from must still
        leave every candidate in the output (recall-safe default: keep as-is
        when no decision came back for it)."""
        from src.entity_verify import verify_entities

        text = "Dr. Sarah Chen works at Acme Corp."
        entities = [
            _entity("Dr. Sarah Chen", 0, 14, "person"),
            _entity("Acme Corp", 24, 33, "organization"),
        ]

        with patch("src.entity_verify.llm_client") as mock_client:
            mock_client.complete.return_value = "not json at all, sorry"

            kept, report = verify_entities(
                entities, text,
                model="qwen2.5:7b", base="http://ollama:11434", kind="ollama",
            )

        assert len(kept) == 2
        assert report["verified"] == 0


# ── (e) disabled flag → run_pipeline path unchanged (gate unit test) ───────

class TestGateDisabledByDefault:
    """main.py has heavy top-level imports (fastapi/redis/qdrant) not present
    in this unit-test environment (see test_relex_kind.py's
    TestRelexGenerationBase docstring for the same constraint), so — like
    that class does for the relex_base routing expression — we verify the
    gate expression `if config.ENTITY_VERIFY_ENABLED: verify_entities(...)`
    directly rather than importing src.main.
    """

    def test_default_config_is_disabled(self):
        from src import config

        assert config.ENTITY_VERIFY_ENABLED is False

    def test_gate_skips_verify_call_when_disabled(self):
        from src import config
        import src.entity_verify as entity_verify

        with patch.object(config, "ENTITY_VERIFY_ENABLED", False), \
             patch.object(entity_verify, "verify_entities") as mock_verify:

            entities = [_entity("Acme", 0, 4, "organization")]
            # Reproduce run_pipeline's gate exactly.
            if config.ENTITY_VERIFY_ENABLED:
                entities, _report = entity_verify.verify_entities(
                    entities, "Acme", model="m", base="b", kind="ollama",
                )

            mock_verify.assert_not_called()

    def test_gate_calls_verify_when_enabled(self):
        from src import config
        import src.entity_verify as entity_verify

        with patch.object(config, "ENTITY_VERIFY_ENABLED", True), \
             patch.object(entity_verify, "verify_entities") as mock_verify:

            mock_verify.return_value = ([_entity("Acme", 0, 4, "organization")], {})

            entities = [_entity("Acme", 0, 4, "organization")]
            if config.ENTITY_VERIFY_ENABLED:
                entities, _report = entity_verify.verify_entities(
                    entities, "Acme", model="m", base="b", kind="ollama",
                )

            mock_verify.assert_called_once()


# ── batching (bonus: keep the LLM-call count sane on large candidate sets) ─

class TestBatching:
    def test_more_than_batch_size_triggers_multiple_llm_calls(self):
        from src.entity_verify import verify_entities, _BATCH_SIZE

        text = "word " * 4000
        entities = [
            _entity(f"Name{i}", i * 5, i * 5 + 4, "person")
            for i in range(_BATCH_SIZE + 5)
        ]

        def fake_complete(prompt, model, base, kind, **kwargs):
            # Return keep=true for every id mentioned in this batch's prompt.
            import re
            ids = [int(m) for m in re.findall(r'"id":\s*(\d+)', prompt)]
            return json.dumps([{"id": i, "keep": True, "corrected_type": "person"} for i in ids])

        with patch("src.entity_verify.llm_client") as mock_client:
            mock_client.complete.side_effect = fake_complete

            kept, report = verify_entities(
                entities, text,
                model="qwen2.5:7b", base="http://ollama:11434", kind="ollama",
            )

        assert report["llm_calls"] == 2
        assert len(kept) == len(entities)


# ── min_score pre-filter ────────────────────────────────────────────────────

class TestMinScorePassthrough:
    def test_below_min_score_never_sent_to_llm(self):
        from src.entity_verify import verify_entities

        text = "Low confidence thing and Dr. Sarah Chen."
        entities = [
            _entity("Low confidence thing", 0, 20, "other", score=0.1),
            _entity("Dr. Sarah Chen", 25, 39, "person", score=0.9),
        ]
        llm_response = json.dumps([{"id": 1, "keep": True, "corrected_type": "person"}])

        with patch("src.entity_verify.llm_client") as mock_client:
            mock_client.complete.return_value = llm_response

            kept, report = verify_entities(
                entities, text,
                model="qwen2.5:7b", base="http://ollama:11434", kind="ollama",
                min_score=0.5,
            )

        # The low-score entity passes through untouched; only the high-score
        # one was sent to (and returned by) the LLM.
        assert len(kept) == 2
        assert report["verified"] == 1
