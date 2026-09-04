"""Tests for fuse/src/llm_client.py — sync (complete) and async (acomplete).

Mirrors services/kex/tests (same mocking strategy):
  - sync `complete`: monkeypatch `requests.post` / `requests.get`
  - async `acomplete`: patch `httpx.AsyncClient.post` via unittest.mock
  - retry sleeps are injectable (`llm_client._sleep` / `_asleep`) → no waiting

FUSE differences vs KEX: no `think` kwarg — the reasoning switch comes from
`_think_flag()` (env FUSE_THINK, default off) and is ALWAYS sent: Ollama
`think:<bool>`, /v1 `chat_template_kwargs.enable_thinking:<bool>`.

Run from services/fuse:  py -3 -m pytest tests -q
"""

import asyncio
import json
import logging
import threading
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest
import requests


# ── helpers ──────────────────────────────────────────────────────────────────

def _make_sync_resp(payload, status=200):
    resp = MagicMock()
    resp.status_code = status
    resp.json.return_value = payload
    resp.raise_for_status = MagicMock()
    return resp


def _real_resp(status, payload=None, headers=None, url="http://x/v1/chat/completions"):
    resp = requests.Response()
    resp.status_code = status
    resp._content = json.dumps(payload if payload is not None else {}).encode()
    resp.url = url
    resp.reason = "x"
    for k, v in (headers or {}).items():
        resp.headers[k] = v
    return resp


def _ok_openai(text="ok"):
    return _real_resp(200, {"choices": [{"message": {"content": text}}]})


def _ok_ollama(text="ok"):
    return _real_resp(200, {"response": text}, url="http://o/api/generate")


def _hx_resp(status, payload=None, headers=None):
    req = httpx.Request("POST", "http://x/v1/chat/completions")
    return httpx.Response(status, json=payload if payload is not None else {}, headers=headers, request=req)


def _hx_ok(text="ok"):
    return _hx_resp(200, {"choices": [{"message": {"content": text}}]})


def _cred_get(payload, status=200):
    resp = MagicMock()
    resp.status_code = status
    resp.json.return_value = payload
    return resp


def _hdr(call):
    return call.kwargs.get("headers") or call[1].get("headers") or {}


def _body(call):
    return call.kwargs.get("json") or call[1].get("json")


@pytest.fixture(autouse=True)
def sleeps(monkeypatch):
    from src import llm_client
    recorded = []

    def fake_sleep(s):
        recorded.append(s)

    async def fake_asleep(s):
        recorded.append(s)

    monkeypatch.setattr(llm_client, "_sleep", fake_sleep)
    monkeypatch.setattr(llm_client, "_asleep", fake_asleep)
    for var in ("INTERNAL_API_SECRET", "GCTRL_INTERNAL_API_URL", "GCTRL_LLM_RETRY_MAX",
                "GCTRL_LLM_RETRY_BASE_MS", "GENERATION_MAX_CONCURRENCY", "FUSE_THINK"):
        monkeypatch.delenv(var, raising=False)
    llm_client._cred_cache.clear()
    yield recorded
    llm_client._cred_cache.clear()


# ── baseline contract (parity with kex/tests/test_llm_client.py) ─────────────

class TestCompleteOpenAI:
    def test_posts_to_v1_chat_completions(self):
        from src.llm_client import complete
        with patch("requests.post", return_value=_make_sync_resp({"choices": [{"message": {"content": "hello"}}]})) as mock_post:
            assert complete("hi", "m", "http://x", "openai") == "hello"
            assert mock_post.call_args[0][0] == "http://x/v1/chat/completions"

    def test_body_shape(self):
        from src.llm_client import complete
        with patch("requests.post", return_value=_ok_openai()) as mock_post:
            complete("hi", "m", "http://x", "openai")
            body = _body(mock_post.call_args)
            assert body["model"] == "m"
            assert body["messages"] == [{"role": "user", "content": "hi"}]
            assert body["stream"] is False
            assert body["temperature"] == 0

    def test_bearer_header_present_with_key(self):
        from src.llm_client import complete
        with patch("requests.post", return_value=_ok_openai()) as mock_post:
            complete("hi", "m", "http://x", "openai", api_key="sk-abc")
            assert _hdr(mock_post.call_args).get("Authorization") == "Bearer sk-abc"

    def test_no_bearer_header_without_key(self):
        from src.llm_client import complete
        with patch("requests.post", return_value=_ok_openai()) as mock_post:
            complete("hi", "m", "http://x", "openai", api_key="")
            assert "Authorization" not in _hdr(mock_post.call_args)

    def test_openai_compatible_alias_and_trailing_slash(self):
        from src.llm_client import complete
        with patch("requests.post", return_value=_ok_openai()) as mock_post:
            complete("hi", "m", "http://x/", "openai_compatible")
            assert mock_post.call_args[0][0] == "http://x/v1/chat/completions"

    def test_timeout_forwarded(self):
        from src.llm_client import complete
        with patch("requests.post", return_value=_ok_openai()) as mock_post:
            complete("hi", "m", "http://x", "openai", timeout=45)
            assert mock_post.call_args.kwargs["timeout"] == 45

    def test_unsupported_kind(self):
        from src.llm_client import complete
        with pytest.raises(RuntimeError):
            complete("hi", "m", "http://x", "anthropic")


class TestCompleteOllama:
    def test_posts_to_api_generate(self):
        from src.llm_client import complete
        with patch("requests.post", return_value=_ok_ollama("borg")) as mock_post:
            assert complete("hi", "llama3.2", "http://ollama:11434/", "ollama") == "borg"
            assert mock_post.call_args[0][0] == "http://ollama:11434/api/generate"

    def test_body_no_options_key_when_options_none(self):
        from src.llm_client import complete
        with patch("requests.post", return_value=_ok_ollama()) as mock_post:
            complete("hi", "llama3.2", "http://ollama:11434", "ollama")
            body = _body(mock_post.call_args)
            assert body["model"] == "llama3.2" and body["prompt"] == "hi" and body["stream"] is False
            assert "options" not in body

    def test_body_with_options_sent_as_is(self):
        from src.llm_client import complete
        with patch("requests.post", return_value=_ok_ollama()) as mock_post:
            complete("hi", "llama3.2", "http://ollama:11434", "ollama", options={"num_predict": 512, "top_k": 5})
            assert _body(mock_post.call_args)["options"] == {"num_predict": 512, "top_k": 5}

    def test_think_flag_default_false(self):
        from src.llm_client import complete
        with patch("requests.post", return_value=_ok_ollama()) as mock_post:
            complete("hi", "llama3.2", "http://ollama:11434", "ollama")
            assert _body(mock_post.call_args)["think"] is False

    def test_think_flag_env_true(self, monkeypatch):
        from src.llm_client import complete
        monkeypatch.setenv("FUSE_THINK", "true")
        with patch("requests.post", return_value=_ok_ollama()) as mock_post:
            complete("hi", "llama3.2", "http://ollama:11434", "ollama")
            assert _body(mock_post.call_args)["think"] is True

    def test_timeout_default_is_120(self):
        from src.llm_client import complete
        with patch("requests.post", return_value=_ok_ollama()) as mock_post:
            complete("hi", "llama3.2", "http://ollama:11434", "ollama")
            assert mock_post.call_args.kwargs["timeout"] == 120


class TestACompleteBaseline:
    def test_openai_url_and_content(self):
        from src.llm_client import acomplete
        async_post = AsyncMock(return_value=_hx_ok("async world"))
        with patch("httpx.AsyncClient.post", async_post):
            assert asyncio.run(acomplete("hi", "m", "http://x", "openai", api_key="sk")) == "async world"
            assert async_post.call_args[0][0] == "http://x/v1/chat/completions"
            assert _hdr(async_post.call_args)["Authorization"] == "Bearer sk"

    def test_ollama_url_and_body(self):
        from src.llm_client import acomplete
        async_post = AsyncMock(return_value=_hx_resp(200, {"response": "borg"}))
        with patch("httpx.AsyncClient.post", async_post):
            assert asyncio.run(acomplete("hi", "llama3.2", "http://ollama:11434", "ollama")) == "borg"
            assert async_post.call_args[0][0] == "http://ollama:11434/api/generate"
            body = _body(async_post.call_args)
            assert "options" not in body
            assert body["think"] is False

    def test_timeout_forwarded_to_httpx(self):
        from src.llm_client import acomplete
        captured = []

        class _FakeClient:
            def __init__(self, timeout=None):
                captured.append(timeout)

            async def __aenter__(self):
                return self

            async def __aexit__(self, *a):
                pass

            async def post(self, *a, **kw):
                return _hx_resp(200, {"response": "ok"})

        with patch("httpx.AsyncClient", _FakeClient):
            asyncio.run(acomplete("hi", "llama3.2", "http://ollama:11434", "ollama", timeout=30))
        assert captured == [30]


# ── _v1_root ─────────────────────────────────────────────────────────────────

class TestV1Root:
    def test_strips_exactly_one_trailing_v1(self):
        from src.llm_client import _v1_root
        assert _v1_root("http://x") == "http://x"
        assert _v1_root("http://x/") == "http://x"
        assert _v1_root("http://x/v1") == "http://x"
        assert _v1_root("http://x/v1/") == "http://x"
        assert _v1_root("http://x/v1/v1") == "http://x/v1"

    def test_openai_base_with_v1_is_not_doubled(self):
        from src.llm_client import complete
        with patch("requests.post", return_value=_ok_openai()) as mock_post:
            complete("hi", "m", "http://x:8020/v1", "openai_compatible")
            assert mock_post.call_args[0][0] == "http://x:8020/v1/chat/completions"

    def test_async_openai_base_with_v1_is_not_doubled(self):
        from src.llm_client import acomplete
        async_post = AsyncMock(return_value=_hx_ok())
        with patch("httpx.AsyncClient.post", async_post):
            asyncio.run(acomplete("hi", "m", "http://x:8020/v1/", "openai_compatible"))
            assert async_post.call_args[0][0] == "http://x:8020/v1/chat/completions"


# ── /v1 body mapping (options + thinking kwarg from _think_flag) ─────────────

class TestOpenAIBodyMapping:
    def test_options_mapped(self):
        from src.llm_client import complete
        with patch("requests.post", return_value=_ok_openai()) as mock_post:
            complete("hi", "m", "http://x", "openai_compatible",
                     options={"temperature": 0.2, "num_predict": 2048, "top_k": 5})
            body = _body(mock_post.call_args)
            assert body["max_tokens"] == 2048
            assert body["temperature"] == 0.2
            assert "options" not in body and "top_k" not in body and "num_predict" not in body

    def test_enable_thinking_false_by_default(self):
        from src.llm_client import complete
        with patch("requests.post", return_value=_ok_openai()) as mock_post:
            complete("hi", "m", "http://x", "openai_compatible")
            assert _body(mock_post.call_args)["chat_template_kwargs"] == {"enable_thinking": False}

    def test_enable_thinking_true_with_env(self, monkeypatch):
        from src.llm_client import complete
        monkeypatch.setenv("FUSE_THINK", "1")
        with patch("requests.post", return_value=_ok_openai()) as mock_post:
            complete("hi", "m", "http://x", "openai")
            assert _body(mock_post.call_args)["chat_template_kwargs"] == {"enable_thinking": True}

    def test_async_body_mapping(self):
        from src.llm_client import acomplete
        async_post = AsyncMock(return_value=_hx_ok())
        with patch("httpx.AsyncClient.post", async_post):
            asyncio.run(acomplete("hi", "m", "http://x", "openai_compatible", options={"num_predict": 64}))
            body = _body(async_post.call_args)
            assert body["max_tokens"] == 64
            assert body["chat_template_kwargs"] == {"enable_thinking": False}


# ── transient contract helpers ───────────────────────────────────────────────

class TestTransientHelpers:
    def test_transient_statuses(self):
        from src.llm_client import TRANSIENT_STATUSES, _is_transient
        assert TRANSIENT_STATUSES == (408, 409, 425, 429, 502, 503, 504, 507)
        assert all(_is_transient(s) for s in TRANSIENT_STATUSES)
        assert not any(_is_transient(s) for s in (200, 400, 401, 403, 404, 422, 500))

    def test_backoff_ladder_capped_at_30(self):
        from src.llm_client import _backoff_seconds
        assert [_backoff_seconds(i) for i in range(6)] == [1.0, 2.0, 4.0, 8.0, 16.0, 30.0]

    def test_retry_after_wins_when_parseable(self):
        from src.llm_client import _backoff_seconds
        assert _backoff_seconds(0, retry_after="7") == 7.0
        assert _backoff_seconds(0, retry_after="99") == 30.0
        assert _backoff_seconds(0, retry_after="junk") == 1.0

    def test_env_knobs(self, monkeypatch):
        from src.llm_client import _backoff_seconds, _retry_max
        assert _retry_max() == 5
        monkeypatch.setenv("GCTRL_LLM_RETRY_MAX", "2")
        monkeypatch.setenv("GCTRL_LLM_RETRY_BASE_MS", "500")
        assert _retry_max() == 2
        assert _backoff_seconds(0) == 0.5


# ── sync retry ladder ────────────────────────────────────────────────────────

class TestRetrySync:
    def test_503_then_ok_openai(self, sleeps):
        from src.llm_client import complete
        with patch("requests.post", side_effect=[_real_resp(503), _ok_openai("done")]) as mock_post:
            assert complete("hi", "m", "http://x", "openai_compatible") == "done"
            assert mock_post.call_count == 2
        assert sleeps == [1.0]

    def test_507_409_then_ok_backoff_grows(self, sleeps):
        from src.llm_client import complete
        with patch("requests.post", side_effect=[_real_resp(507), _real_resp(409), _ok_openai("done")]) as mock_post:
            assert complete("hi", "m", "http://x", "openai_compatible") == "done"
            assert mock_post.call_count == 3
        assert sleeps == [1.0, 2.0]

    def test_ollama_branch_retries_503(self, sleeps):
        from src.llm_client import complete
        with patch("requests.post", side_effect=[_real_resp(503), _ok_ollama("o")]) as mock_post:
            assert complete("hi", "m", "http://o", "ollama") == "o"
            assert mock_post.call_count == 2
        assert sleeps == [1.0]

    def test_retry_after_header_honoured(self, sleeps):
        from src.llm_client import complete
        with patch("requests.post", side_effect=[_real_resp(429, headers={"Retry-After": "3"}), _ok_openai()]):
            complete("hi", "m", "http://x", "openai")
        assert sleeps == [3.0]

    def test_non_transient_raises_immediately(self, sleeps):
        from src.llm_client import complete
        with patch("requests.post", return_value=_real_resp(400)) as mock_post:
            with pytest.raises(requests.exceptions.HTTPError) as ei:
                complete("hi", "m", "http://x", "openai")
            assert ei.value.response.status_code == 400
            assert mock_post.call_count == 1
        assert sleeps == []

    def test_exhaustion_raises_last_http_error(self, monkeypatch, sleeps):
        from src.llm_client import complete
        monkeypatch.setenv("GCTRL_LLM_RETRY_MAX", "2")
        with patch("requests.post", side_effect=[_real_resp(503), _real_resp(503), _real_resp(507)]) as mock_post:
            with pytest.raises(requests.exceptions.HTTPError) as ei:
                complete("hi", "m", "http://x", "openai_compatible")
            assert ei.value.response.status_code == 507
            assert mock_post.call_count == 3
        assert sleeps == [1.0, 2.0]

    def test_connection_error_retried_then_reraised(self, monkeypatch):
        from src.llm_client import complete
        with patch("requests.post", side_effect=[requests.ConnectionError("reset"), _ok_openai("up")]) as mock_post:
            assert complete("hi", "m", "http://x", "openai") == "up"
            assert mock_post.call_count == 2
        monkeypatch.setenv("GCTRL_LLM_RETRY_MAX", "1")
        with patch("requests.post", side_effect=requests.ConnectionError("down")) as mock_post:
            with pytest.raises(requests.exceptions.ConnectionError):
                complete("hi", "m", "http://x", "openai")
            assert mock_post.call_count == 2

    def test_read_timeout_not_retried(self, sleeps):
        from src.llm_client import complete
        with patch("requests.post", side_effect=requests.exceptions.ReadTimeout("slow")) as mock_post:
            with pytest.raises(requests.exceptions.Timeout):
                complete("hi", "m", "http://x", "openai")
            assert mock_post.call_count == 1
        assert sleeps == []

    def test_retry_logged_at_warning(self, caplog):
        from src.llm_client import complete
        with patch("requests.post", side_effect=[_real_resp(503), _ok_openai()]):
            with caplog.at_level(logging.WARNING, logger="src.llm_client"):
                complete("hi", "m", "http://x", "openai")
        assert any("503" in r.getMessage() for r in caplog.records if r.levelno == logging.WARNING)


# ── async retry ladder ───────────────────────────────────────────────────────

class TestRetryAsync:
    def test_503_then_ok(self, sleeps):
        from src.llm_client import acomplete
        async_post = AsyncMock(side_effect=[_hx_resp(503), _hx_ok("done")])
        with patch("httpx.AsyncClient.post", async_post):
            assert asyncio.run(acomplete("hi", "m", "http://x", "openai_compatible")) == "done"
            assert async_post.call_count == 2
        assert sleeps == [1.0]

    def test_connect_error_retried(self):
        from src.llm_client import acomplete
        async_post = AsyncMock(side_effect=[httpx.ConnectError("refused"), _hx_ok("up")])
        with patch("httpx.AsyncClient.post", async_post):
            assert asyncio.run(acomplete("hi", "m", "http://x", "openai")) == "up"
            assert async_post.call_count == 2

    def test_read_timeout_not_retried(self, sleeps):
        from src.llm_client import acomplete
        async_post = AsyncMock(side_effect=httpx.ReadTimeout("slow"))
        with patch("httpx.AsyncClient.post", async_post):
            with pytest.raises(httpx.ReadTimeout):
                asyncio.run(acomplete("hi", "m", "http://x", "openai"))
            assert async_post.call_count == 1
        assert sleeps == []

    def test_exhaustion_raises_http_status_error(self, monkeypatch):
        from src.llm_client import acomplete
        monkeypatch.setenv("GCTRL_LLM_RETRY_MAX", "1")
        async_post = AsyncMock(side_effect=[_hx_resp(503), _hx_resp(503)])
        with patch("httpx.AsyncClient.post", async_post):
            with pytest.raises(httpx.HTTPStatusError) as ei:
                asyncio.run(acomplete("hi", "m", "http://x", "openai"))
            assert ei.value.response.status_code == 503
            assert async_post.call_count == 2


# ── per-base concurrency gate ────────────────────────────────────────────────

class _Counter:
    def __init__(self):
        self.lock = threading.Lock()
        self.now = 0
        self.max_seen = 0

    def enter(self):
        with self.lock:
            self.now += 1
            self.max_seen = max(self.max_seen, self.now)

    def leave(self):
        with self.lock:
            self.now -= 1


def _run_threads(fn, n):
    threads = [threading.Thread(target=fn) for _ in range(n)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=10)


class TestConcurrencyGate:
    @staticmethod
    def _sync_fake(counter, resp, hold=0.15):
        import time as _t

        def fake_post(*a, **kw):
            counter.enter()
            _t.sleep(hold)
            counter.leave()
            return resp
        return fake_post

    def test_sync_gate_limits_openai_compatible(self):
        from src.llm_client import complete
        counter = _Counter()
        with patch("requests.post", side_effect=self._sync_fake(counter, _ok_openai())):
            _run_threads(
                lambda: complete("hi", "m", "http://gate-sync-a:1/v1", "openai_compatible", max_concurrency=2), 5,
            )
        assert counter.max_seen == 2, counter.max_seen

    def test_sync_gate_env_default(self, monkeypatch):
        from src.llm_client import complete
        monkeypatch.setenv("GENERATION_MAX_CONCURRENCY", "1")
        counter = _Counter()
        with patch("requests.post", side_effect=self._sync_fake(counter, _ok_openai())):
            _run_threads(lambda: complete("hi", "m", "http://gate-sync-b:1", "openai_compatible"), 3)
        assert counter.max_seen == 1

    def test_gate_keyed_by_v1_root(self):
        from src.llm_client import _gate
        assert _gate("http://same:1/v1", 3) is _gate("http://same:1", 3)
        assert _gate("http://same:1", 3) is not _gate("http://other:1", 3)

    def test_ollama_not_gated(self):
        from src.llm_client import complete
        barrier = threading.Barrier(3, timeout=3)
        errors = []

        def fake_post(*a, **kw):
            try:
                barrier.wait()
            except threading.BrokenBarrierError as exc:
                errors.append(exc)
            return _ok_ollama()

        with patch("requests.post", side_effect=fake_post):
            _run_threads(lambda: complete("hi", "m", "http://gate-ollama:1", "ollama", max_concurrency=1), 3)
        assert not errors

    def test_async_gate_limits(self):
        from src.llm_client import acomplete
        counter = _Counter()

        async def fake_post(*a, **kw):
            counter.enter()
            await asyncio.sleep(0.15)
            counter.leave()
            return _hx_ok()

        async def run():
            await asyncio.gather(*[
                acomplete("hi", "m", "http://gate-async:1", "openai_compatible", max_concurrency=2)
                for _ in range(5)
            ])

        with patch("httpx.AsyncClient.post", side_effect=fake_post):
            asyncio.run(run())
        assert counter.max_seen == 2, counter.max_seen


# ── worker credential fetch (D7) ─────────────────────────────────────────────

class TestCredentialFetch:
    def test_fetched_once_and_cached(self, monkeypatch):
        from src.llm_client import complete
        monkeypatch.setenv("INTERNAL_API_SECRET", "s3cret")
        monkeypatch.setenv("GCTRL_INTERNAL_API_URL", "http://api:4000/")
        with patch("requests.get", return_value=_cred_get({"api_key": "k-1"})) as mock_get, \
             patch("requests.post", return_value=_ok_openai()) as mock_post:
            complete("hi", "m", "http://mlx:8020/v1", "openai_compatible")
            complete("hi", "m", "http://mlx:8020", "openai_compatible")
            assert mock_get.call_count == 1
            assert mock_get.call_args[0][0] == "http://api:4000/api/internal/generation-credential"
            assert mock_get.call_args.kwargs["params"] == {"base": "http://mlx:8020"}
            assert mock_get.call_args.kwargs["headers"] == {"X-Internal-Secret": "s3cret"}
            assert mock_get.call_args.kwargs["timeout"] == 3
            for c in mock_post.call_args_list:
                assert _hdr(c).get("Authorization") == "Bearer k-1"

    def test_default_internal_url(self, monkeypatch):
        from src.llm_client import complete
        monkeypatch.setenv("INTERNAL_API_SECRET", "s3cret")
        with patch("requests.get", return_value=_cred_get({"api_key": "k"})) as mock_get, \
             patch("requests.post", return_value=_ok_openai()):
            complete("hi", "m", "http://mlx:1", "openai_compatible")
            assert mock_get.call_args[0][0] == "http://gctrl-api:4000/api/internal/generation-credential"

    def test_no_fetch_when_secret_unset(self):
        from src.llm_client import complete
        with patch("requests.get") as mock_get, patch("requests.post", return_value=_ok_openai()) as mock_post:
            complete("hi", "m", "http://mlx:1", "openai_compatible")
            assert mock_get.call_count == 0
            assert "Authorization" not in _hdr(mock_post.call_args)

    def test_no_fetch_when_api_key_given_or_ollama(self, monkeypatch):
        from src.llm_client import complete
        monkeypatch.setenv("INTERNAL_API_SECRET", "s3cret")
        with patch("requests.get") as mock_get, patch("requests.post", return_value=_ok_openai()) as mock_post:
            complete("hi", "m", "http://mlx:1", "openai_compatible", api_key="given")
            assert _hdr(mock_post.call_args)["Authorization"] == "Bearer given"
        with patch("requests.get") as mock_get2, patch("requests.post", return_value=_ok_ollama()):
            complete("hi", "m", "http://o:1", "ollama")
        assert mock_get.call_count == 0 and mock_get2.call_count == 0

    def test_401_invalidates_refetches_and_resends_once(self, monkeypatch):
        from src.llm_client import complete
        monkeypatch.setenv("INTERNAL_API_SECRET", "s3cret")
        gets = [_cred_get({"api_key": "old"}), _cred_get({"api_key": "new"})]
        with patch("requests.get", side_effect=gets) as mock_get, \
             patch("requests.post", side_effect=[_real_resp(401), _ok_openai("fresh")]) as mock_post:
            assert complete("hi", "m", "http://mlx:2", "openai_compatible") == "fresh"
            assert mock_get.call_count == 2
            assert mock_post.call_count == 2
            assert _hdr(mock_post.call_args_list[0])["Authorization"] == "Bearer old"
            assert _hdr(mock_post.call_args_list[1])["Authorization"] == "Bearer new"

    def test_401_twice_raises_http_error(self, monkeypatch):
        from src.llm_client import complete
        monkeypatch.setenv("INTERNAL_API_SECRET", "s3cret")
        with patch("requests.get", return_value=_cred_get({"api_key": "k"})) as mock_get, \
             patch("requests.post", side_effect=[_real_resp(401), _real_resp(401)]) as mock_post:
            with pytest.raises(requests.exceptions.HTTPError) as ei:
                complete("hi", "m", "http://mlx:3", "openai_compatible")
            assert ei.value.response.status_code == 401
            assert mock_get.call_count == 2
            assert mock_post.call_count == 2

    def test_fetch_failure_or_404_proceeds_without_key(self, monkeypatch):
        from src.llm_client import complete
        monkeypatch.setenv("INTERNAL_API_SECRET", "s3cret")
        with patch("requests.get", side_effect=requests.ConnectionError("api down")), \
             patch("requests.post", return_value=_ok_openai("ok")) as mock_post:
            assert complete("hi", "m", "http://mlx:5", "openai_compatible") == "ok"
            assert "Authorization" not in _hdr(mock_post.call_args)
        with patch("requests.get", return_value=_cred_get({"error": "no key"}, status=404)), \
             patch("requests.post", return_value=_ok_openai("ok")) as mock_post:
            assert complete("hi", "m", "http://mlx:6", "openai_compatible") == "ok"
            assert "Authorization" not in _hdr(mock_post.call_args)

    def test_key_never_logged(self, monkeypatch, caplog):
        from src.llm_client import complete
        monkeypatch.setenv("INTERNAL_API_SECRET", "s3cret")
        with caplog.at_level(logging.DEBUG):
            with patch("requests.get", return_value=_cred_get({"api_key": "TOPSECRET-KEY"})), \
                 patch("requests.post", side_effect=[_real_resp(401), _ok_openai()]):
                complete("hi", "m", "http://mlx:7", "openai_compatible")
        assert "TOPSECRET-KEY" not in caplog.text
        assert "s3cret" not in caplog.text

    def test_async_fetch_and_401_refetch(self, monkeypatch):
        from src.llm_client import acomplete
        monkeypatch.setenv("INTERNAL_API_SECRET", "s3cret")
        async_post = AsyncMock(side_effect=[_hx_resp(401), _hx_ok("fresh")])
        gets = [_cred_get({"api_key": "old"}), _cred_get({"api_key": "new"})]
        with patch("requests.get", side_effect=gets) as mock_get, patch("httpx.AsyncClient.post", async_post):
            assert asyncio.run(acomplete("hi", "m", "http://mlx:9/v1", "openai_compatible")) == "fresh"
            assert mock_get.call_count == 2
            assert _hdr(async_post.call_args_list[0])["Authorization"] == "Bearer old"
            assert _hdr(async_post.call_args_list[1])["Authorization"] == "Bearer new"
