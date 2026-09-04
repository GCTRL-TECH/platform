"""llm_client hardening (2026-09-04 MLX/backpressure spec) — sync + async.

Covers:
  - `_v1_root` URL canonicalisation (strip ONE trailing /v1 → no /v1/v1)
  - /v1 body mapping: Ollama `options` → max_tokens/temperature; tri-state
    `think` → chat_template_kwargs.enable_thinking (None omits)
  - transient retry ladder (TRANSIENT_STATUSES, backoff, Retry-After, env knobs,
    connection errors retried, read timeouts NOT retried, exhaustion re-raises the
    same exception types callers already handle)
  - per-base concurrency gate (openai kinds only)
  - worker credential fetch (D7): cached per base, invalidated on 401, never logged

Mocking strategy mirrors test_llm_client.py: monkeypatch `requests.post` /
`requests.get`, patch `httpx.AsyncClient.post`; the retry sleeps are injectable
(`llm_client._sleep` / `llm_client._asleep`) so no test ever waits.
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

def _real_resp(status, payload=None, headers=None, url="http://x/v1/chat/completions"):
    """A real requests.Response so raise_for_status() behaves like production."""
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
    """Never really sleep in the retry ladder; isolate env + credential cache per test."""
    from src import llm_client
    recorded = []

    def fake_sleep(s):
        recorded.append(s)

    async def fake_asleep(s):
        recorded.append(s)

    monkeypatch.setattr(llm_client, "_sleep", fake_sleep)
    monkeypatch.setattr(llm_client, "_asleep", fake_asleep)
    for var in ("INTERNAL_API_SECRET", "GCTRL_INTERNAL_API_URL", "GCTRL_LLM_RETRY_MAX",
                "GCTRL_LLM_RETRY_BASE_MS", "GENERATION_MAX_CONCURRENCY"):
        monkeypatch.delenv(var, raising=False)
    llm_client._cred_cache.clear()
    yield recorded
    llm_client._cred_cache.clear()


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

    def test_ollama_branch_unchanged(self):
        from src.llm_client import complete
        with patch("requests.post", return_value=_ok_ollama()) as mock_post:
            complete("hi", "m", "http://o:11434/", "ollama")
            assert mock_post.call_args[0][0] == "http://o:11434/api/generate"


# ── /v1 body mapping (options + thinking kwarg) ──────────────────────────────

class TestOpenAIBodyMapping:
    def test_options_num_predict_maps_to_max_tokens(self):
        from src.llm_client import complete
        with patch("requests.post", return_value=_ok_openai()) as mock_post:
            complete("hi", "m", "http://x", "openai_compatible",
                     options={"temperature": 0.0, "num_predict": 2048})
            body = _body(mock_post.call_args)
            assert body["max_tokens"] == 2048
            assert body["temperature"] == 0.0
            assert "options" not in body
            assert "num_predict" not in body

    def test_options_temperature_overrides_default(self):
        from src.llm_client import complete
        with patch("requests.post", return_value=_ok_openai()) as mock_post:
            complete("hi", "m", "http://x", "openai", options={"temperature": 0.1})
            body = _body(mock_post.call_args)
            assert body["temperature"] == 0.1
            assert "max_tokens" not in body

    def test_unknown_option_keys_ignored(self):
        from src.llm_client import complete
        with patch("requests.post", return_value=_ok_openai()) as mock_post:
            complete("hi", "m", "http://x", "openai", options={"top_k": 5, "num_ctx": 8192})
            body = _body(mock_post.call_args)
            assert "top_k" not in body and "num_ctx" not in body
            assert body["temperature"] == 0

    def test_think_none_omits_chat_template_kwargs(self):
        from src.llm_client import complete
        with patch("requests.post", return_value=_ok_openai()) as mock_post:
            complete("hi", "m", "http://x", "openai")
            assert "chat_template_kwargs" not in _body(mock_post.call_args)

    def test_think_false_sets_enable_thinking_false(self):
        from src.llm_client import complete
        with patch("requests.post", return_value=_ok_openai()) as mock_post:
            complete("hi", "m", "http://x", "openai_compatible", think=False)
            assert _body(mock_post.call_args)["chat_template_kwargs"] == {"enable_thinking": False}

    def test_think_true_sets_enable_thinking_true(self):
        from src.llm_client import complete
        with patch("requests.post", return_value=_ok_openai()) as mock_post:
            complete("hi", "m", "http://x", "openai_compatible", think=True)
            assert _body(mock_post.call_args)["chat_template_kwargs"] == {"enable_thinking": True}

    def test_async_body_mapping(self):
        from src.llm_client import acomplete
        async_post = AsyncMock(return_value=_hx_ok())
        with patch("httpx.AsyncClient.post", async_post):
            asyncio.run(acomplete("hi", "m", "http://x", "openai_compatible",
                                  options={"num_predict": 64}, think=False))
            body = _body(async_post.call_args)
            assert body["max_tokens"] == 64
            assert body["chat_template_kwargs"] == {"enable_thinking": False}

    def test_async_think_none_omits_kwarg(self):
        from src.llm_client import acomplete
        async_post = AsyncMock(return_value=_hx_ok())
        with patch("httpx.AsyncClient.post", async_post):
            asyncio.run(acomplete("hi", "m", "http://x", "openai"))
            assert "chat_template_kwargs" not in _body(async_post.call_args)


# ── transient contract helpers ───────────────────────────────────────────────

class TestTransientHelpers:
    def test_transient_statuses(self):
        from src.llm_client import TRANSIENT_STATUSES, _is_transient
        assert TRANSIENT_STATUSES == (408, 409, 425, 429, 502, 503, 504, 507)
        for s in TRANSIENT_STATUSES:
            assert _is_transient(s)
        for s in (200, 400, 401, 403, 404, 422, 500):
            assert not _is_transient(s)

    def test_backoff_ladder_capped_at_30(self):
        from src.llm_client import _backoff_seconds
        assert [_backoff_seconds(i) for i in range(6)] == [1.0, 2.0, 4.0, 8.0, 16.0, 30.0]

    def test_retry_after_wins_when_parseable(self):
        from src.llm_client import _backoff_seconds
        assert _backoff_seconds(0, retry_after="7") == 7.0
        assert _backoff_seconds(3, retry_after="2.5") == 2.5
        assert _backoff_seconds(0, retry_after="99") == 30.0
        assert _backoff_seconds(0, retry_after="junk") == 1.0
        assert _backoff_seconds(0, retry_after=None) == 1.0

    def test_env_base_ms(self, monkeypatch):
        from src.llm_client import _backoff_seconds
        monkeypatch.setenv("GCTRL_LLM_RETRY_BASE_MS", "500")
        assert _backoff_seconds(0) == 0.5
        assert _backoff_seconds(1) == 1.0

    def test_env_retry_max_default_5(self, monkeypatch):
        from src.llm_client import _retry_max
        assert _retry_max() == 5
        monkeypatch.setenv("GCTRL_LLM_RETRY_MAX", "2")
        assert _retry_max() == 2


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
        seq = [_real_resp(507), _real_resp(409), _ok_openai("done")]
        with patch("requests.post", side_effect=seq) as mock_post:
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
        seq = [_real_resp(429, headers={"Retry-After": "3"}), _ok_openai()]
        with patch("requests.post", side_effect=seq):
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

    def test_404_on_ollama_raises_http_error_unchanged(self):
        """relex/fact_log rely on HTTPError(404) for the auto-pull / not-installed paths."""
        from src.llm_client import complete
        with patch("requests.post", return_value=_real_resp(404)):
            with pytest.raises(requests.exceptions.HTTPError) as ei:
                complete("hi", "m", "http://o", "ollama")
            assert ei.value.response.status_code == 404

    def test_exhaustion_raises_last_http_error(self, monkeypatch, sleeps):
        from src.llm_client import complete
        monkeypatch.setenv("GCTRL_LLM_RETRY_MAX", "2")
        seq = [_real_resp(503), _real_resp(503), _real_resp(507)]
        with patch("requests.post", side_effect=seq) as mock_post:
            with pytest.raises(requests.exceptions.HTTPError) as ei:
                complete("hi", "m", "http://x", "openai_compatible")
            assert ei.value.response.status_code == 507
            assert mock_post.call_count == 3
        assert sleeps == [1.0, 2.0]

    def test_connection_error_retried(self):
        from src.llm_client import complete
        seq = [requests.ConnectionError("reset"), _ok_openai("up")]
        with patch("requests.post", side_effect=seq) as mock_post:
            assert complete("hi", "m", "http://x", "openai") == "up"
            assert mock_post.call_count == 2

    def test_connection_error_exhaustion_reraises_connection_error(self, monkeypatch):
        from src.llm_client import complete
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
        msgs = [r.getMessage() for r in caplog.records if r.levelno == logging.WARNING]
        assert any("503" in m for m in msgs), msgs


# ── async retry ladder ───────────────────────────────────────────────────────

class TestRetryAsync:
    def test_503_then_ok(self, sleeps):
        from src.llm_client import acomplete
        async_post = AsyncMock(side_effect=[_hx_resp(503), _hx_ok("done")])
        with patch("httpx.AsyncClient.post", async_post):
            assert asyncio.run(acomplete("hi", "m", "http://x", "openai_compatible")) == "done"
            assert async_post.call_count == 2
        assert sleeps == [1.0]

    def test_ollama_async_retries(self):
        from src.llm_client import acomplete
        async_post = AsyncMock(side_effect=[_hx_resp(503), _hx_resp(200, {"response": "o"})])
        with patch("httpx.AsyncClient.post", async_post):
            assert asyncio.run(acomplete("hi", "m", "http://o", "ollama")) == "o"
            assert async_post.call_count == 2

    def test_retry_after_honoured(self, sleeps):
        from src.llm_client import acomplete
        async_post = AsyncMock(side_effect=[_hx_resp(429, headers={"Retry-After": "4"}), _hx_ok()])
        with patch("httpx.AsyncClient.post", async_post):
            asyncio.run(acomplete("hi", "m", "http://x", "openai"))
        assert sleeps == [4.0]

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

    def test_non_transient_raises_immediately(self):
        from src.llm_client import acomplete
        async_post = AsyncMock(return_value=_hx_resp(401))
        with patch("httpx.AsyncClient.post", async_post):
            with pytest.raises(httpx.HTTPStatusError):
                asyncio.run(acomplete("hi", "m", "http://x", "openai"))
            assert async_post.call_count == 1


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
                lambda: complete("hi", "m", "http://gate-sync-a:1/v1", "openai_compatible", max_concurrency=2),
                5,
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
        """'…/v1' and '…' are the same server → one shared gate."""
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
        assert not errors, "ollama calls must not be serialised by the gate"

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

    def test_no_fetch_when_api_key_given(self, monkeypatch):
        from src.llm_client import complete
        monkeypatch.setenv("INTERNAL_API_SECRET", "s3cret")
        with patch("requests.get") as mock_get, patch("requests.post", return_value=_ok_openai()) as mock_post:
            complete("hi", "m", "http://mlx:1", "openai_compatible", api_key="given")
            assert mock_get.call_count == 0
            assert _hdr(mock_post.call_args)["Authorization"] == "Bearer given"

    def test_no_fetch_for_ollama(self, monkeypatch):
        from src.llm_client import complete
        monkeypatch.setenv("INTERNAL_API_SECRET", "s3cret")
        with patch("requests.get") as mock_get, patch("requests.post", return_value=_ok_ollama()):
            complete("hi", "m", "http://o:1", "ollama")
            assert mock_get.call_count == 0

    def test_401_invalidates_refetches_and_resends_once(self, monkeypatch):
        from src.llm_client import complete
        monkeypatch.setenv("INTERNAL_API_SECRET", "s3cret")
        gets = [_cred_get({"api_key": "old"}), _cred_get({"api_key": "new"})]
        posts = [_real_resp(401), _ok_openai("fresh")]
        with patch("requests.get", side_effect=gets) as mock_get, \
             patch("requests.post", side_effect=posts) as mock_post:
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

    def test_401_with_caller_key_not_refetched(self, monkeypatch):
        from src.llm_client import complete
        monkeypatch.setenv("INTERNAL_API_SECRET", "s3cret")
        with patch("requests.get") as mock_get, patch("requests.post", return_value=_real_resp(401)) as mock_post:
            with pytest.raises(requests.exceptions.HTTPError):
                complete("hi", "m", "http://mlx:4", "openai_compatible", api_key="given")
            assert mock_get.call_count == 0
            assert mock_post.call_count == 1

    def test_fetch_failure_proceeds_without_key(self, monkeypatch):
        from src.llm_client import complete
        monkeypatch.setenv("INTERNAL_API_SECRET", "s3cret")
        with patch("requests.get", side_effect=requests.ConnectionError("api down")), \
             patch("requests.post", return_value=_ok_openai("ok")) as mock_post:
            assert complete("hi", "m", "http://mlx:5", "openai_compatible") == "ok"
            assert "Authorization" not in _hdr(mock_post.call_args)

    def test_fetch_404_proceeds_without_key(self, monkeypatch):
        from src.llm_client import complete
        monkeypatch.setenv("INTERNAL_API_SECRET", "s3cret")
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

    def test_async_fetches_credential(self, monkeypatch):
        from src.llm_client import acomplete
        monkeypatch.setenv("INTERNAL_API_SECRET", "s3cret")
        async_post = AsyncMock(return_value=_hx_ok())
        with patch("requests.get", return_value=_cred_get({"api_key": "k-a"})) as mock_get, \
             patch("httpx.AsyncClient.post", async_post):
            asyncio.run(acomplete("hi", "m", "http://mlx:8/v1", "openai_compatible"))
            assert mock_get.call_count == 1
            assert _hdr(async_post.call_args)["Authorization"] == "Bearer k-a"

    def test_async_401_refetch(self, monkeypatch):
        from src.llm_client import acomplete
        monkeypatch.setenv("INTERNAL_API_SECRET", "s3cret")
        async_post = AsyncMock(side_effect=[_hx_resp(401), _hx_ok("fresh")])
        gets = [_cred_get({"api_key": "old"}), _cred_get({"api_key": "new"})]
        with patch("requests.get", side_effect=gets) as mock_get, patch("httpx.AsyncClient.post", async_post):
            assert asyncio.run(acomplete("hi", "m", "http://mlx:9", "openai_compatible")) == "fresh"
            assert mock_get.call_count == 2
            assert _hdr(async_post.call_args_list[1])["Authorization"] == "Bearer new"
