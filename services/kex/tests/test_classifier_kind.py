"""Tests for auto_classify runtime-base threading (Task 1.3, Fix 1).

Verifies:
  (a) auto_classify(..., base="http://x:9/v1", kind="openai_compatible") calls
      llm_client.acomplete with base="http://x:9/v1" and kind="openai_compatible".
  (b) auto_classify(..., kind="ollama") with no base falls back to the module
      OLLAMA_BASE constant.
"""

import asyncio
from unittest.mock import AsyncMock, patch, call

import pytest


# ── helpers ──────────────────────────────────────────────────────────────────

def _run(coro):
    return asyncio.run(coro)


# ── (a) openai_compatible base is threaded through ────────────────────────────

class TestClassifierBaseThreading:
    def test_custom_base_forwarded_to_acomplete(self):
        """With base='http://x:9/v1' and kind='openai_compatible', llm_client.acomplete
        must receive exactly those values."""
        from src import auto_classifier

        mock_acomplete = AsyncMock(return_value="INTERNAL")

        with patch.object(auto_classifier.llm_client, "acomplete", mock_acomplete):
            _run(auto_classifier.auto_classify(
                "This is a secret project.",
                base="http://x:9/v1",
                kind="openai_compatible",
            ))

        assert mock_acomplete.called, "llm_client.acomplete was not called"
        args, kwargs = mock_acomplete.call_args
        # Signature: acomplete(prompt, model, base, kind, ...)
        # base is the 3rd positional arg (index 2)
        passed_base = kwargs.get("base") if "base" in kwargs else (args[2] if len(args) > 2 else None)
        passed_kind = kwargs.get("kind") if "kind" in kwargs else (args[3] if len(args) > 3 else None)
        assert passed_base == "http://x:9/v1", (
            f"Expected base='http://x:9/v1', got {passed_base!r}"
        )
        assert passed_kind == "openai_compatible", (
            f"Expected kind='openai_compatible', got {passed_kind!r}"
        )

    def test_api_key_forwarded(self):
        """api_key is passed through to llm_client.acomplete."""
        from src import auto_classifier

        mock_acomplete = AsyncMock(return_value="PUBLIC")

        with patch.object(auto_classifier.llm_client, "acomplete", mock_acomplete):
            _run(auto_classifier.auto_classify(
                "Public announcement text.",
                base="http://x:9/v1",
                kind="openai_compatible",
                api_key="sk-test-key",
            ))

        assert mock_acomplete.called
        args, kwargs = mock_acomplete.call_args
        passed_api_key = kwargs.get("api_key")
        assert passed_api_key == "sk-test-key", (
            f"Expected api_key='sk-test-key', got {passed_api_key!r}"
        )


# ── (b) ollama default: no base → falls back to OLLAMA_BASE ──────────────────

class TestClassifierOllamaFallback:
    def test_no_base_falls_back_to_ollama_base(self):
        """With kind='ollama' and no base, llm_client.acomplete must receive the
        module-level OLLAMA_BASE constant (not None, not empty string)."""
        from src import auto_classifier

        mock_acomplete = AsyncMock(return_value="INTERNAL")

        with patch.object(auto_classifier.llm_client, "acomplete", mock_acomplete):
            _run(auto_classifier.auto_classify(
                "Internal memo text.",
                kind="ollama",
                # no base kwarg
            ))

        assert mock_acomplete.called
        args, kwargs = mock_acomplete.call_args
        passed_base = kwargs.get("base") if "base" in kwargs else (args[2] if len(args) > 2 else None)
        passed_kind = kwargs.get("kind") if "kind" in kwargs else (args[3] if len(args) > 3 else None)

        # Must be the module constant, not None/empty
        assert passed_base == auto_classifier.OLLAMA_BASE, (
            f"Expected OLLAMA_BASE={auto_classifier.OLLAMA_BASE!r}, got {passed_base!r}"
        )
        assert passed_kind == "ollama", (
            f"Expected kind='ollama', got {passed_kind!r}"
        )

    def test_empty_base_falls_back_to_ollama_base(self):
        """Explicitly passing base='' (empty) must also fall back to OLLAMA_BASE."""
        from src import auto_classifier

        mock_acomplete = AsyncMock(return_value="INTERNAL")

        with patch.object(auto_classifier.llm_client, "acomplete", mock_acomplete):
            _run(auto_classifier.auto_classify(
                "Internal memo text.",
                kind="ollama",
                base="",
            ))

        assert mock_acomplete.called
        args, kwargs = mock_acomplete.call_args
        passed_base = kwargs.get("base") if "base" in kwargs else (args[2] if len(args) > 2 else None)
        assert passed_base == auto_classifier.OLLAMA_BASE, (
            f"Expected OLLAMA_BASE on empty base, got {passed_base!r}"
        )

    def test_none_base_falls_back_to_ollama_base(self):
        """Explicitly passing base=None must also fall back to OLLAMA_BASE."""
        from src import auto_classifier

        mock_acomplete = AsyncMock(return_value="INTERNAL")

        with patch.object(auto_classifier.llm_client, "acomplete", mock_acomplete):
            _run(auto_classifier.auto_classify(
                "Internal memo text.",
                kind="ollama",
                base=None,
            ))

        assert mock_acomplete.called
        args, kwargs = mock_acomplete.call_args
        passed_base = kwargs.get("base") if "base" in kwargs else (args[2] if len(args) > 2 else None)
        assert passed_base == auto_classifier.OLLAMA_BASE, (
            f"Expected OLLAMA_BASE on None base, got {passed_base!r}"
        )
