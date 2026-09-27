"""A 2xx with a BLANK completion must degrade, not pass as success.

Reasoning models reached over an OpenAI-compatible endpoint can spend the whole
`max_tokens` budget on hidden thinking and return empty `content` (measured on
Ollama Cloud, 2026-09-25: deepseek-v4.1-flash at num_predict=2048 -> 1 char, 0
relations). Reported as "ok" that produced a graph with entities and no edges,
with no warning anywhere. These tests pin the visible failure instead.
"""

from unittest.mock import patch


def _entities():
    return [
        {"text": "Alice", "label": "person", "coarse_type": "person"},
        {"text": "Acme", "label": "organization", "coarse_type": "organization"},
    ]


def _text():
    return "Alice is the CEO of Acme."


class TestEmptyCompletionDegrades:
    def test_blank_answer_on_v1_runtime_degrades_with_token_budget_reason(self):
        from src.relex import RelationExtractor

        for blank in ("", "   ", "\n\n"):
            with patch("src.relex.llm_client") as mock_client:
                mock_client.complete.return_value = blank

                ext = RelationExtractor()
                result = ext.extract_relations(
                    _text(), _entities(),
                    ollama_base="https://ollama.com",
                    model="deepseek-v4.1-flash",
                    kind="openai_compatible",
                    api_key="sk-test",
                )
                relations = result[0] if isinstance(result, tuple) else result

                assert relations == [], f"blank {blank!r} must yield no relations"
                assert ext.last_degraded is True, f"blank {blank!r} must set last_degraded"
                reason = (ext.last_degraded_reason or "").lower()
                assert "nothing" in reason and "relex_num_predict" in reason, reason

    def test_blank_answer_on_ollama_tries_the_fallback_model(self):
        """On Ollama a blank answer behaves like a model that could not run: the
        lighter fallback model gets its turn instead of silently returning 0."""
        from src.relex import RelationExtractor, _relex_dead_primaries

        _relex_dead_primaries.clear()
        good = '[{"head": "Alice", "relation": "ceo_of", "tail": "Acme"}]'

        with patch("src.relex.llm_client") as mock_client:
            mock_client.complete.side_effect = lambda *a, **k: (
                "" if (k.get("model") or a[1]) == "primary-model" else good
            )
            from src import config
            with patch.object(RelationExtractor, "_model_installed", return_value=True), \
                 patch.object(config, "RELEX_MODEL", "primary-model"), \
                 patch.object(config, "RELEX_FALLBACK_MODEL", "fallback-model"), \
                 patch.object(config, "RELEX_GAPFILL_ENABLED", False):
                ext = RelationExtractor()
                result = ext.extract_relations(
                    _text(), _entities(),
                    ollama_base="http://ollama:11434",
                    model="primary-model",
                    kind="ollama",
                )
                relations = result[0] if isinstance(result, tuple) else result

        models_tried = [
            (k.get("model") or a[1]) for a, k in mock_client.complete.call_args_list
        ]
        assert "fallback-model" in models_tried, models_tried
        assert relations, "the fallback model's relations must survive"
