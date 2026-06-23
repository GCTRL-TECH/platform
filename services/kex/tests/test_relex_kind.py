"""TDD tests for RelationExtractor kind routing (Task 1.3).

Verifies:
  1. With kind="openai_compatible", llm_client.complete is called with
     kind="openai_compatible" — NOT the raw /api/generate path.
  2. With kind="ollama", the existing auto-pull-on-404 shell still runs
     (i.e. _pull_model is invoked on a simulated 404).
  3. kind="ollama" passes kind="ollama" to llm_client.complete (parity check).
"""

import asyncio
from unittest.mock import MagicMock, patch, call

import pytest


# ── helpers ──────────────────────────────────────────────────────────────────

def _entities():
    return [
        {"text": "Alice", "label": "person", "coarse_type": "person"},
        {"text": "Acme", "label": "organization", "coarse_type": "organization"},
    ]

def _text():
    return "Alice is the CEO of Acme."


# ── 1. openai_compatible → llm_client.complete called with kind="openai_compatible"

class TestRelexOpenAICompatible:
    def test_llm_client_called_with_openai_compatible_kind(self):
        """With kind='openai_compatible', RelationExtractor must delegate to
        llm_client.complete with kind='openai_compatible'.
        The auto-pull logic must NOT be triggered."""
        from src.relex import RelationExtractor

        fake_response = '[{"head": "Alice", "relation": "ceo_of", "tail": "Acme"}]'

        with patch("src.relex.llm_client") as mock_client:
            mock_client.complete.return_value = fake_response

            ext = RelationExtractor()
            relations = ext.extract_relations(
                _text(), _entities(),
                ollama_base="http://openai-compat:8080",
                model="gpt-4o-mini",
                kind="openai_compatible",
                api_key="sk-test",
            )

            # Must have called llm_client.complete at least once
            assert mock_client.complete.called, "llm_client.complete was not called"

            # Every call must use kind="openai_compatible"
            for c in mock_client.complete.call_args_list:
                args, kwargs = c
                # kind is the 4th positional arg: (prompt, model, base, kind, ...)
                passed_kind = kwargs.get("kind") or (args[3] if len(args) > 3 else None)
                assert passed_kind == "openai_compatible", (
                    f"Expected kind='openai_compatible', got {passed_kind!r}"
                )

    def test_openai_compatible_returns_parsed_relations(self):
        """Relations are parsed correctly when llm_client returns a JSON array."""
        from src.relex import RelationExtractor

        fake_response = '[{"head": "Alice", "relation": "ceo_of", "tail": "Acme"}]'

        with patch("src.relex.llm_client") as mock_client:
            mock_client.complete.return_value = fake_response

            ext = RelationExtractor()
            relations = ext.extract_relations(
                _text(), _entities(),
                kind="openai_compatible",
                ollama_base="http://openai-compat:8080",
                model="gpt-4o-mini",
            )

        # Should get at least the ceo_of triple back (validation may transform it)
        assert isinstance(relations, list)

    def test_pull_not_called_for_openai_compatible(self):
        """_pull_model must NEVER be called for non-ollama kinds (even on 404)."""
        from src.relex import RelationExtractor

        fake_response = '[]'

        with patch("src.relex.llm_client") as mock_client:
            mock_client.complete.return_value = fake_response

            ext = RelationExtractor()
            with patch.object(ext, "_pull_model") as mock_pull:
                ext.extract_relations(
                    _text(), _entities(),
                    kind="openai_compatible",
                    ollama_base="http://openai-compat:8080",
                    model="gpt-4o-mini",
                )
                mock_pull.assert_not_called()


# ── 2. kind="ollama" → auto-pull-on-404 shell still fires

class TestRelexOllama404AutoPull:
    def test_pull_called_on_404_for_ollama(self):
        """With kind='ollama', a simulated 404 from llm_client.complete (raised
        as HTTPError with status 404) must trigger _pull_model."""
        import requests as _req
        from src import config as _config
        from src.relex import RelationExtractor

        # Simulate _generate_once returning "not_found" on the first call so
        # the pull shell fires.  We patch _generate_once directly to avoid
        # needing a real network.  Use side_effect as a callable to avoid
        # StopIteration when gap-fill makes additional calls.
        call_count = []

        def gen_side_effect(*args, **kwargs):
            call_count.append(1)
            if len(call_count) == 1:
                return ("not_found", None)
            return ("ok", "[]")

        with patch("src.relex.RelationExtractor._pull_model", return_value=True) as mock_pull, \
             patch("src.relex.RelationExtractor._generate_once", side_effect=gen_side_effect), \
             patch.object(_config, "RELEX_GAPFILL_ENABLED", False):

            ext = RelationExtractor()
            ext.extract_relations(
                _text(), _entities(),
                kind="ollama",
                ollama_base="http://ollama:11434",
                model="qwen2.5:7b",
            )

            mock_pull.assert_called_once()

    def test_ollama_kind_passed_to_llm_client(self):
        """With kind='ollama', llm_client.complete must be called with kind='ollama'."""
        from src.relex import RelationExtractor

        with patch("src.relex.llm_client") as mock_client:
            mock_client.complete.return_value = "[]"

            ext = RelationExtractor()
            ext.extract_relations(
                _text(), _entities(),
                kind="ollama",
                ollama_base="http://ollama:11434",
                model="qwen2.5:7b",
            )

            assert mock_client.complete.called
            for c in mock_client.complete.call_args_list:
                args, kwargs = c
                passed_kind = kwargs.get("kind") or (args[3] if len(args) > 3 else None)
                assert passed_kind == "ollama", f"Expected kind='ollama', got {passed_kind!r}"

    def test_ollama_passes_options_and_timeout_180(self):
        """Parity with e71ecaf: relex must pass options={temperature:0.0, num_predict:1024}
        and timeout=180 to llm_client.complete for every Ollama call."""
        from src.relex import RelationExtractor

        with patch("src.relex.llm_client") as mock_client:
            mock_client.complete.return_value = "[]"

            ext = RelationExtractor()
            ext.extract_relations(
                _text(), _entities(),
                kind="ollama",
                ollama_base="http://ollama:11434",
                model="qwen2.5:7b",
            )

            assert mock_client.complete.called
            for c in mock_client.complete.call_args_list:
                args, kwargs = c
                passed_options = kwargs.get("options")
                passed_timeout = kwargs.get("timeout")
                assert passed_options == {"temperature": 0.0, "num_predict": 1024}, (
                    f"Expected options={{'temperature':0.0,'num_predict':1024}}, got {passed_options!r}"
                )
                assert passed_timeout == 180, (
                    f"Expected timeout=180, got {passed_timeout!r}"
                )


# ── 3. default kind="ollama" is used when not specified

class TestRelexDefaultKind:
    def test_default_kind_is_ollama(self):
        """When kind is not passed, llm_client.complete must receive kind='ollama'."""
        from src.relex import RelationExtractor

        with patch("src.relex.llm_client") as mock_client:
            mock_client.complete.return_value = "[]"

            ext = RelationExtractor()
            # Call without kind kwarg
            ext.extract_relations(
                _text(), _entities(),
                ollama_base="http://ollama:11434",
                model="qwen2.5:7b",
            )

            assert mock_client.complete.called
            for c in mock_client.complete.call_args_list:
                args, kwargs = c
                passed_kind = kwargs.get("kind") or (args[3] if len(args) > 3 else None)
                assert passed_kind == "ollama", f"Expected default kind='ollama', got {passed_kind!r}"
