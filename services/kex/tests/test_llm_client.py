"""Tests for llm_client.py — sync (complete) and async (acomplete) branches.

Mocking strategy:
  - sync `complete`: monkeypatch `requests.post`
  - async `acomplete`: patch `httpx.AsyncClient.post` via unittest.mock

Per-caller contract (parity with e71ecaf):
  - options=None  → "options" key ABSENT from body (distiller / auto_classifier parity)
  - options={...} → "options" key present with exactly the provided dict (relex parity)
  - timeout       → forwarded to the underlying HTTP client
"""

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import pytest


# ── helpers ──────────────────────────────────────────────────────────────────

def _make_sync_resp(payload: dict, status: int = 200) -> MagicMock:
    resp = MagicMock()
    resp.status_code = status
    resp.json.return_value = payload
    resp.raise_for_status = MagicMock()
    return resp


def _make_async_resp(payload: dict, status: int = 200) -> MagicMock:
    resp = MagicMock()
    resp.status_code = status
    resp.json.return_value = payload
    resp.raise_for_status = MagicMock()
    return resp


# ── sync: complete ────────────────────────────────────────────────────────────

class TestCompleteOpenAI:
    def test_posts_to_v1_chat_completions(self):
        from src.llm_client import complete
        fake_resp = _make_sync_resp({
            "choices": [{"message": {"content": "hello"}}]
        })
        with patch("requests.post", return_value=fake_resp) as mock_post:
            result = complete("hi", "m", "http://x", "openai")
            url = mock_post.call_args[0][0]
            assert url == "http://x/v1/chat/completions"

    def test_body_shape(self):
        from src.llm_client import complete
        fake_resp = _make_sync_resp({
            "choices": [{"message": {"content": "hello"}}]
        })
        with patch("requests.post", return_value=fake_resp) as mock_post:
            complete("hi", "m", "http://x", "openai")
            body = mock_post.call_args.kwargs.get("json") or mock_post.call_args[1].get("json")
            assert body["model"] == "m"
            assert body["messages"] == [{"role": "user", "content": "hi"}]
            assert body["stream"] is False
            assert body["temperature"] == 0

    def test_returns_choices_content(self):
        from src.llm_client import complete
        fake_resp = _make_sync_resp({
            "choices": [{"message": {"content": "world"}}]
        })
        with patch("requests.post", return_value=fake_resp):
            result = complete("hi", "m", "http://x", "openai")
            assert result == "world"

    def test_bearer_header_present_with_key(self):
        from src.llm_client import complete
        fake_resp = _make_sync_resp({
            "choices": [{"message": {"content": "ok"}}]
        })
        with patch("requests.post", return_value=fake_resp) as mock_post:
            complete("hi", "m", "http://x", "openai", api_key="sk-abc")
            headers = mock_post.call_args.kwargs.get("headers") or mock_post.call_args[1].get("headers", {})
            assert headers.get("Authorization") == "Bearer sk-abc"

    def test_no_bearer_header_without_key(self):
        from src.llm_client import complete
        fake_resp = _make_sync_resp({
            "choices": [{"message": {"content": "ok"}}]
        })
        with patch("requests.post", return_value=fake_resp) as mock_post:
            complete("hi", "m", "http://x", "openai")
            headers = mock_post.call_args.kwargs.get("headers") or mock_post.call_args[1].get("headers", {})
            assert "Authorization" not in (headers or {})

    def test_no_bearer_header_with_empty_key(self):
        from src.llm_client import complete
        fake_resp = _make_sync_resp({
            "choices": [{"message": {"content": "ok"}}]
        })
        with patch("requests.post", return_value=fake_resp) as mock_post:
            complete("hi", "m", "http://x", "openai", api_key="")
            headers = mock_post.call_args.kwargs.get("headers") or mock_post.call_args[1].get("headers", {})
            assert "Authorization" not in (headers or {})

    def test_openai_compatible_alias(self):
        from src.llm_client import complete
        fake_resp = _make_sync_resp({
            "choices": [{"message": {"content": "ok"}}]
        })
        with patch("requests.post", return_value=fake_resp) as mock_post:
            complete("hi", "m", "http://x", "openai_compatible")
            url = mock_post.call_args[0][0]
            assert "/v1/chat/completions" in url

    def test_strips_trailing_slash_from_base(self):
        from src.llm_client import complete
        fake_resp = _make_sync_resp({
            "choices": [{"message": {"content": "ok"}}]
        })
        with patch("requests.post", return_value=fake_resp) as mock_post:
            complete("hi", "m", "http://x/", "openai")
            url = mock_post.call_args[0][0]
            assert url == "http://x/v1/chat/completions"

    def test_openai_timeout_forwarded(self):
        """The timeout arg must be forwarded to requests.post."""
        from src.llm_client import complete
        fake_resp = _make_sync_resp({
            "choices": [{"message": {"content": "ok"}}]
        })
        with patch("requests.post", return_value=fake_resp) as mock_post:
            complete("hi", "m", "http://x", "openai", timeout=45)
            timeout_arg = mock_post.call_args.kwargs.get("timeout") or mock_post.call_args[1].get("timeout")
            assert timeout_arg == 45


class TestCompleteOllama:
    def test_posts_to_api_generate(self):
        from src.llm_client import complete
        fake_resp = _make_sync_resp({"response": "borg"})
        with patch("requests.post", return_value=fake_resp) as mock_post:
            complete("hi", "llama3.2", "http://ollama:11434", "ollama")
            url = mock_post.call_args[0][0]
            assert url == "http://ollama:11434/api/generate"

    def test_body_no_options_key_when_options_none(self):
        """When options=None (default), the body must NOT contain an 'options' key.
        This is the byte-parity requirement for distiller + auto_classifier (e71ecaf)."""
        from src.llm_client import complete
        fake_resp = _make_sync_resp({"response": "borg"})
        with patch("requests.post", return_value=fake_resp) as mock_post:
            complete("hi", "llama3.2", "http://ollama:11434", "ollama")
            body = mock_post.call_args.kwargs.get("json") or mock_post.call_args[1].get("json")
            assert body["model"] == "llama3.2"
            assert body["prompt"] == "hi"
            assert body["stream"] is False
            assert "options" not in body, (
                f"'options' key must be absent when options=None, got body={body}"
            )

    def test_body_with_options_key_when_options_provided(self):
        """When options is provided, the body carries exactly that dict as 'options'.
        This is the byte-parity requirement for relex (e71ecaf)."""
        from src.llm_client import complete
        fake_resp = _make_sync_resp({"response": "borg"})
        with patch("requests.post", return_value=fake_resp) as mock_post:
            complete(
                "hi", "llama3.2", "http://ollama:11434", "ollama",
                options={"temperature": 0.0, "num_predict": 1024},
            )
            body = mock_post.call_args.kwargs.get("json") or mock_post.call_args[1].get("json")
            assert "options" in body
            assert body["options"] == {"temperature": 0.0, "num_predict": 1024}

    def test_options_sent_as_is_no_merge(self):
        """Caller-supplied options are forwarded verbatim — no hidden default merge."""
        from src.llm_client import complete
        fake_resp = _make_sync_resp({"response": "ok"})
        with patch("requests.post", return_value=fake_resp) as mock_post:
            complete("hi", "llama3.2", "http://ollama:11434", "ollama",
                     options={"num_predict": 512, "top_k": 5})
            body = mock_post.call_args.kwargs.get("json") or mock_post.call_args[1].get("json")
            # Exactly the provided dict — no baked-in temperature added
            assert body["options"] == {"num_predict": 512, "top_k": 5}
            assert "temperature" not in body["options"]

    def test_returns_response_field(self):
        from src.llm_client import complete
        fake_resp = _make_sync_resp({"response": "extracted text"})
        with patch("requests.post", return_value=fake_resp):
            result = complete("hi", "llama3.2", "http://ollama:11434", "ollama")
            assert result == "extracted text"

    def test_timeout_default_is_120(self):
        """Default timeout for ollama must be 120 s."""
        from src.llm_client import complete
        fake_resp = _make_sync_resp({"response": "ok"})
        with patch("requests.post", return_value=fake_resp) as mock_post:
            complete("hi", "llama3.2", "http://ollama:11434", "ollama")
            timeout_arg = mock_post.call_args.kwargs.get("timeout") or mock_post.call_args[1].get("timeout")
            assert timeout_arg == 120

    def test_timeout_forwarded_to_requests(self):
        """A caller-supplied timeout must reach requests.post (relex passes 180)."""
        from src.llm_client import complete
        fake_resp = _make_sync_resp({"response": "ok"})
        with patch("requests.post", return_value=fake_resp) as mock_post:
            complete("hi", "llama3.2", "http://ollama:11434", "ollama",
                     options={"temperature": 0.0, "num_predict": 1024}, timeout=180)
            timeout_arg = mock_post.call_args.kwargs.get("timeout") or mock_post.call_args[1].get("timeout")
            assert timeout_arg == 180


# ── async: acomplete ──────────────────────────────────────────────────────────

class TestACompleteOpenAI:
    def test_posts_to_v1_chat_completions(self):
        from src.llm_client import acomplete
        fake_resp = _make_async_resp({
            "choices": [{"message": {"content": "hello"}}]
        })
        async_post = AsyncMock(return_value=fake_resp)
        with patch("httpx.AsyncClient.post", async_post):
            result = asyncio.run(acomplete("hi", "m", "http://x", "openai"))
            url = async_post.call_args[0][0]
            assert url == "http://x/v1/chat/completions"

    def test_returns_choices_content(self):
        from src.llm_client import acomplete
        fake_resp = _make_async_resp({
            "choices": [{"message": {"content": "async world"}}]
        })
        async_post = AsyncMock(return_value=fake_resp)
        with patch("httpx.AsyncClient.post", async_post):
            result = asyncio.run(acomplete("hi", "m", "http://x", "openai"))
            assert result == "async world"

    def test_bearer_header_present_with_key(self):
        from src.llm_client import acomplete
        fake_resp = _make_async_resp({
            "choices": [{"message": {"content": "ok"}}]
        })
        async_post = AsyncMock(return_value=fake_resp)
        with patch("httpx.AsyncClient.post", async_post):
            asyncio.run(acomplete("hi", "m", "http://x", "openai", api_key="sk-abc"))
            headers = async_post.call_args.kwargs.get("headers") or async_post.call_args[1].get("headers", {})
            assert headers.get("Authorization") == "Bearer sk-abc"

    def test_no_bearer_header_without_key(self):
        from src.llm_client import acomplete
        fake_resp = _make_async_resp({
            "choices": [{"message": {"content": "ok"}}]
        })
        async_post = AsyncMock(return_value=fake_resp)
        with patch("httpx.AsyncClient.post", async_post):
            asyncio.run(acomplete("hi", "m", "http://x", "openai"))
            headers = async_post.call_args.kwargs.get("headers") or async_post.call_args[1].get("headers", {})
            assert "Authorization" not in (headers or {})


class TestACompleteOllama:
    def test_posts_to_api_generate(self):
        from src.llm_client import acomplete
        fake_resp = _make_async_resp({"response": "borg"})
        async_post = AsyncMock(return_value=fake_resp)
        with patch("httpx.AsyncClient.post", async_post):
            asyncio.run(acomplete("hi", "llama3.2", "http://ollama:11434", "ollama"))
            url = async_post.call_args[0][0]
            assert url == "http://ollama:11434/api/generate"

    def test_body_no_options_key_when_options_none(self):
        """When options=None (default), body must NOT contain 'options'.
        Parity with original auto_classifier behaviour (e71ecaf)."""
        from src.llm_client import acomplete
        fake_resp = _make_async_resp({"response": "extracted"})
        async_post = AsyncMock(return_value=fake_resp)
        with patch("httpx.AsyncClient.post", async_post):
            asyncio.run(acomplete("hi", "llama3.2", "http://ollama:11434", "ollama"))
            body = async_post.call_args.kwargs.get("json") or async_post.call_args[1].get("json")
            assert "options" not in body, (
                f"'options' key must be absent when options=None, got body={body}"
            )

    def test_body_with_options_key_when_options_provided(self):
        """When options is provided, body carries exactly that dict."""
        from src.llm_client import acomplete
        fake_resp = _make_async_resp({"response": "ok"})
        async_post = AsyncMock(return_value=fake_resp)
        with patch("httpx.AsyncClient.post", async_post):
            asyncio.run(acomplete(
                "hi", "llama3.2", "http://ollama:11434", "ollama",
                options={"temperature": 0.0, "num_predict": 1024},
            ))
            body = async_post.call_args.kwargs.get("json") or async_post.call_args[1].get("json")
            assert "options" in body
            assert body["options"] == {"temperature": 0.0, "num_predict": 1024}

    def test_returns_response_field(self):
        from src.llm_client import acomplete
        fake_resp = _make_async_resp({"response": "extracted"})
        async_post = AsyncMock(return_value=fake_resp)
        with patch("httpx.AsyncClient.post", async_post):
            result = asyncio.run(acomplete("hi", "llama3.2", "http://ollama:11434", "ollama"))
            assert result == "extracted"

    def test_timeout_forwarded_to_httpx(self):
        """A caller-supplied timeout (e.g. 30 for auto_classifier) must reach
        the httpx.AsyncClient constructor."""
        from src.llm_client import acomplete
        fake_resp = _make_async_resp({"response": "ok"})
        async_post = AsyncMock(return_value=fake_resp)

        captured_timeouts = []

        class _FakeClient:
            def __init__(self, timeout=None):
                captured_timeouts.append(timeout)
            async def __aenter__(self):
                return self
            async def __aexit__(self, *a):
                pass
            async def post(self, *a, **kw):
                return fake_resp

        with patch("httpx.AsyncClient", _FakeClient):
            asyncio.run(acomplete(
                "hi", "llama3.2", "http://ollama:11434", "ollama", timeout=30
            ))
        assert captured_timeouts == [30], f"Expected timeout=30, got {captured_timeouts}"
