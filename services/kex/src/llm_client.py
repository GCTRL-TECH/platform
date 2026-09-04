"""Runtime-aware generation client for KEX.

Supports two backends, selected by `kind`:
  - "ollama"            → POST {base}/api/generate   (local Ollama)
  - "openai" | "openai_compatible" → POST {_v1_root(base)}/v1/chat/completions
    (`_v1_root` strips ONE trailing "/v1" so a base of "…:8020/v1" never posts to
    "/v1/v1/chat/completions"; mirrors api-rs `llm::openai_compat_root`).

Both a sync variant (`complete`, uses `requests`) and an async variant
(`acomplete`, uses `httpx`) are provided:
  - `complete`  is used by relex.py / entity_verify.py / fact_log.py (sync pipeline)
  - `acomplete` is used by auto_classifier.py (async FastAPI handler)

Cython-safety note: NO local variable is annotated as dict/list/set.
Request bodies are built as inline literals / plain dicts passed directly to `.json=`.

Per-caller timeout and options contract:
  - `timeout` defaults to 120 s; callers override to match their original posture
    (relex: 180 s, auto_classifier: 30 s, fact_log: 90 s).
  - `options` for the Ollama branch: when None (the default) the key is OMITTED
    from the request body entirely (distiller / auto_classifier parity with
    e71ecaf).  When provided, it is sent as-is — no baked-in defaults, no merge.
  - `options` on the /v1 branch is MAPPED, not forwarded: `num_predict` →
    `max_tokens`, `temperature` → `temperature` (default 0); other Ollama keys
    (num_ctx, top_k, …) are dropped. `keep_alive` is Ollama-only.

Thinking switch (`think`, tri-state):
  - Ollama: `think: <bool>` per-request field; None → omitted.
  - /v1:    `chat_template_kwargs: {"enable_thinking": <bool>}` (qwen3/oMLX/vLLM
            honour it; others ignore the unknown key); None → omitted.

Transient-error contract (shared with api-rs and the FUSE client):
  - `TRANSIENT_STATUSES` = 408/409/425/429/502/503/504/507 plus connection errors
    (`requests.ConnectionError` incl. connect-timeout / `httpx.ConnectError`) are
    retried with exponential backoff 1, 2, 4, 8, 16 s (capped at 30 s), honouring
    `Retry-After` when parseable. Env knobs: GCTRL_LLM_RETRY_MAX (default 5),
    GCTRL_LLM_RETRY_BASE_MS (default 1000).
  - Non-transient statuses (400/401/403/404/422/500…) raise immediately; a READ
    timeout on a started request is NOT retried (the model is genuinely slow).
  - After exhaustion the LAST error is raised unchanged (`requests.HTTPError`
    with `.response`, `requests.ConnectionError`, `httpx.HTTPStatusError`, …) so
    callers' degradation logic (relex ladder, fact_log 404 → None) is untouched.
  - Applies to BOTH branches (Ollama can 503 under load too).

Per-base concurrency gate (openai kinds only):
  - One process-local `threading.Semaphore` per `_v1_root(base)`, sized by the
    `max_concurrency` kwarg (payload `generation_max_concurrency`) with env
    fallback GENERATION_MAX_CONCURRENCY (default 4). Stops ONE worker fanning N
    windows at once into a memory-tight local server (oMLX/vLLM/llama.cpp).
    Ollama and cloud providers are not gated. The async variant shares the same
    semaphore (acquired off-loop via asyncio.to_thread) so sync + async callers in
    one process count against one budget.

Worker credential fetch (design D7 — no secrets in Redis):
  - On the /v1 branch, when `api_key` is falsy and INTERNAL_API_SECRET is set, the
    key is fetched from GET {GCTRL_INTERNAL_API_URL|http://gctrl-api:4000}
    /api/internal/generation-credential?base=<root> (header X-Internal-Secret,
    3 s timeout), cached in-process per base for 300 s. On an upstream 401 the
    cache entry is invalidated, refetched once and the request re-sent once.
    Any fetch failure → proceed without a key (as before). The key is never logged.
"""

import asyncio
import logging
import os
import threading
import time

import httpx
import requests

from . import telemetry

logger = logging.getLogger(__name__)

# ── transient-error contract ─────────────────────────────────────────────────

TRANSIENT_STATUSES = (408, 409, 425, 429, 502, 503, 504, 507)
_BACKOFF_CAP_S = 30.0
_OPENAI_KINDS = ("openai", "openai_compatible")

# Injectable sleepers so tests never wait on the retry ladder.
_sleep = time.sleep
_asleep = asyncio.sleep


def _v1_root(base) -> str:
    """Canonical server root for OpenAI-compatible URLs: trailing '/' removed and
    ONE trailing '/v1' stripped (mirrors api-rs `llm::openai_compat_root`)."""
    root = (base or "").rstrip("/")
    if root.endswith("/v1"):
        root = root[:-3]
    return root


def _is_transient(status) -> bool:
    return status in TRANSIENT_STATUSES


def _retry_max() -> int:
    try:
        return max(0, int(os.environ.get("GCTRL_LLM_RETRY_MAX", "5")))
    except ValueError:
        return 5


def _backoff_seconds(attempt, retry_after=None) -> float:
    """Sleep before retry number `attempt` (0-based): base_ms * 2**attempt, capped
    at 30 s. A parseable `Retry-After` (seconds) wins, capped the same way."""
    if retry_after is not None:
        try:
            ra = float(str(retry_after).strip())
            if ra >= 0:
                return min(ra, _BACKOFF_CAP_S)
        except ValueError:
            pass
    try:
        base_ms = int(os.environ.get("GCTRL_LLM_RETRY_BASE_MS", "1000"))
    except ValueError:
        base_ms = 1000
    return min(base_ms / 1000.0 * (2 ** attempt), _BACKOFF_CAP_S)


# ── per-base concurrency gate ────────────────────────────────────────────────

_gates = {}
_gates_lock = threading.Lock()


def _resolve_concurrency(max_concurrency) -> int:
    n = max_concurrency
    if not n:
        try:
            n = int(os.environ.get("GENERATION_MAX_CONCURRENCY", "4"))
        except ValueError:
            n = 4
    return max(1, int(n))


def _gate(base, max_concurrency) -> threading.Semaphore:
    """Process-local semaphore for `base`, keyed by its canonical root and size
    (a changed size simply starts a fresh gate; old holders drain on the old one)."""
    key = (_v1_root(base), _resolve_concurrency(max_concurrency))
    with _gates_lock:
        sem = _gates.get(key)
        if sem is None:
            sem = threading.Semaphore(key[1])
            _gates[key] = sem
        return sem


# ── worker credential fetch (D7) ─────────────────────────────────────────────

_CRED_TTL_S = 300.0
_cred_cache = {}
_cred_lock = threading.Lock()


def _internal_api_url() -> str:
    return (os.environ.get("GCTRL_INTERNAL_API_URL") or "http://gctrl-api:4000").rstrip("/")


def _credential_fetch_enabled(api_key, kind) -> bool:
    return (not api_key) and kind in _OPENAI_KINDS and bool(os.environ.get("INTERNAL_API_SECRET"))


def _invalidate_credential(root) -> None:
    with _cred_lock:
        _cred_cache.pop(root, None)


def _fetch_generation_credential(root):
    """Return the runtime API key for `root` from the api-rs internal endpoint, or
    None when unavailable. Results (incl. "no key") are cached for 300 s; the key
    itself is never logged."""
    secret = os.environ.get("INTERNAL_API_SECRET")
    if not secret:
        return None
    now = time.monotonic()
    with _cred_lock:
        hit = _cred_cache.get(root)
        if hit is not None and now - hit[1] < _CRED_TTL_S:
            return hit[0]
    key = None
    try:
        resp = requests.get(
            f"{_internal_api_url()}/api/internal/generation-credential",
            params={"base": root},
            headers={"X-Internal-Secret": secret},
            timeout=3,
            allow_redirects=False,
        )
        if resp.status_code == 200:
            key = (resp.json() or {}).get("api_key") or None
        else:
            logger.info(f"llm_client: no generation credential for {root} (HTTP {resp.status_code})")
    except Exception as exc:  # noqa: BLE001 — any failure → proceed without a key
        logger.info(f"llm_client: generation credential fetch failed for {root}: {type(exc).__name__}")
    with _cred_lock:
        _cred_cache[root] = (key, now)
    return key


def _auth_headers(api_key):
    headers = {}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    return headers if headers else None


def _v1_body(prompt, model, options, think):
    body = {
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "stream": False,
        "temperature": 0,
    }
    if options:
        if "temperature" in options:
            body["temperature"] = options["temperature"]
        if "num_predict" in options:
            body["max_tokens"] = options["num_predict"]
    if think is not None:
        body["chat_template_kwargs"] = {"enable_thinking": bool(think)}
    return body


def _ollama_body(prompt, model, options, think):
    if options is not None:
        body = {"model": model, "prompt": prompt, "stream": False, "options": options}
    else:
        body = {"model": model, "prompt": prompt, "stream": False}
    # Keep the generation model resident between jobs. Ollama's default keep_alive
    # is 5 min; after any longer idle the NEXT extraction pays the full model load
    # (measured via Phoenix: 9.3 s of a 10.2 s relex on the first call, ~1 s warm).
    # Env-tunable for RAM-tight boxes; "0" unloads immediately, "5m" = Ollama default.
    body["keep_alive"] = os.environ.get("OLLAMA_KEEP_ALIVE", "30m")
    # Reasoning models spend most of their tokens on a chain-of-thought the
    # extraction parsers discard; `think: false` skips it (big speed-up, same
    # structured output). Models without a thinking capability ignore the
    # field, and older Ollama ignores the unknown key. None => omit entirely.
    if think is not None:
        body["think"] = bool(think)
    return body


# ── retrying transports ──────────────────────────────────────────────────────

def _post_with_retry(url, body, headers, timeout):
    """requests.post with the transient ladder. Returns the 2xx response; raises
    the last `requests.HTTPError` / `requests.ConnectionError` after exhaustion."""
    retries = _retry_max()
    attempt = 0
    while True:
        try:
            resp = requests.post(url, json=body, headers=headers, timeout=timeout, allow_redirects=False)
        except requests.exceptions.ConnectionError as exc:
            # Covers connection reset/refused AND connect-timeout (ConnectTimeout
            # subclasses ConnectionError); ReadTimeout is a plain Timeout → not caught.
            if attempt >= retries:
                raise
            delay = _backoff_seconds(attempt)
            logger.warning(f"llm_client: connection error on {url} ({type(exc).__name__}); retry {attempt + 1}/{retries} in {delay:.1f}s")
            _sleep(delay)
            attempt += 1
            continue
        if _is_transient(resp.status_code) and attempt < retries:
            delay = _backoff_seconds(attempt, resp.headers.get("Retry-After"))
            logger.warning(f"llm_client: HTTP {resp.status_code} from {url}; retry {attempt + 1}/{retries} in {delay:.1f}s")
            _sleep(delay)
            attempt += 1
            continue
        resp.raise_for_status()
        return resp


async def _apost_with_retry(url, body, headers, timeout):
    """httpx variant of `_post_with_retry` (raises `httpx.HTTPStatusError` /
    `httpx.ConnectError` after exhaustion)."""
    retries = _retry_max()
    attempt = 0
    while True:
        try:
            async with httpx.AsyncClient(timeout=timeout) as client:
                resp = await client.post(url, json=body, headers=headers)
        except httpx.ConnectError as exc:
            if attempt >= retries:
                raise
            delay = _backoff_seconds(attempt)
            logger.warning(f"llm_client: connection error on {url} ({type(exc).__name__}); retry {attempt + 1}/{retries} in {delay:.1f}s")
            await _asleep(delay)
            attempt += 1
            continue
        if _is_transient(resp.status_code) and attempt < retries:
            delay = _backoff_seconds(attempt, resp.headers.get("Retry-After"))
            logger.warning(f"llm_client: HTTP {resp.status_code} from {url}; retry {attempt + 1}/{retries} in {delay:.1f}s")
            await _asleep(delay)
            attempt += 1
            continue
        resp.raise_for_status()
        return resp


def _status_of(exc):
    resp = getattr(exc, "response", None)
    return getattr(resp, "status_code", None) if resp is not None else None


# ── public API ───────────────────────────────────────────────────────────────

def complete(
    prompt: str,
    model: str,
    base: str,
    kind: str,
    api_key=None,
    options=None,
    think=None,
    timeout=120,
    max_concurrency=None,
) -> str:
    """Traced wrapper around ``_complete_impl`` — one OpenInference LLM span per
    generation call (no-op unless PHOENIX_OTLP_URL is set). Exceptions propagate
    unchanged so callers' degradation handling behaves exactly as before."""
    with telemetry.span(
        "llm.complete",
        "LLM",
        {"llm.model_name": model, "llm.provider": kind, "input.value": telemetry.trunc(prompt)},
    ) as sp:
        out = _complete_impl(
            prompt, model, base, kind, api_key=api_key, options=options, think=think,
            timeout=timeout, max_concurrency=max_concurrency,
        )
        try:
            sp.set_attribute("output.value", telemetry.trunc(out, 4000))
        except Exception:
            pass
        return out


def _complete_impl(
    prompt: str,
    model: str,
    base: str,
    kind: str,
    api_key=None,
    options=None,
    think=None,
    timeout=120,
    max_concurrency=None,
) -> str:
    """Synchronous LLM completion.  Uses `requests`.

    Args:
        prompt:  The user prompt.
        model:   Model identifier (e.g. "llama3.2", "gpt-4o-mini").
        base:    Base URL of the inference server (trailing slash stripped; a
                 trailing "/v1" is folded on the openai branches).
        kind:    "ollama" | "openai" | "openai_compatible"
        api_key: Bearer token; omitted from headers when None or empty string.
                 Empty on an openai kind + INTERNAL_API_SECRET set → fetched from
                 the api-rs internal credential endpoint (see module docstring).
        options: Ollama options dict sent as-is on the Ollama branch (None → key
                 omitted, byte-parity with e71ecaf); mapped to max_tokens /
                 temperature on the /v1 branch.
        think:   tri-state reasoning switch (None → omit; True/False → set).
        timeout: Request timeout in seconds (default 120).  Pass 180 for relex.
        max_concurrency: per-base parallel-request budget for openai kinds
                 (None → env GENERATION_MAX_CONCURRENCY, default 4).

    Returns:
        The generated text as a string.

    Raises:
        requests.HTTPError: on non-2xx response (after the transient ladder).
        requests.ConnectionError / requests.Timeout: as raised by `requests`.
        RuntimeError: on unsupported `kind`.
    """
    base = base.rstrip("/")

    if kind == "ollama":
        resp = _post_with_retry(f"{base}/api/generate", _ollama_body(prompt, model, options, think), None, timeout)
        return resp.json()["response"]

    if kind in _OPENAI_KINDS:
        root = _v1_root(base)
        url = f"{root}/v1/chat/completions"
        body = _v1_body(prompt, model, options, think)
        fetch = _credential_fetch_enabled(api_key, kind)
        key = _fetch_generation_credential(root) if fetch else api_key
        with _gate(root, max_concurrency):
            try:
                resp = _post_with_retry(url, body, _auth_headers(key), timeout)
            except requests.exceptions.HTTPError as exc:
                if not (fetch and _status_of(exc) == 401):
                    raise
                # Stale/rotated key: invalidate, refetch once, re-send once.
                _invalidate_credential(root)
                key = _fetch_generation_credential(root)
                if not key:
                    raise
                resp = _post_with_retry(url, body, _auth_headers(key), timeout)
        return resp.json()["choices"][0]["message"]["content"]

    raise RuntimeError(f"llm_client: unsupported kind '{kind}'")


async def acomplete(
    prompt: str,
    model: str,
    base: str,
    kind: str,
    api_key=None,
    options=None,
    think=None,
    timeout=120,
    max_concurrency=None,
) -> str:
    """Async LLM completion.  Uses `httpx`.

    Same semantics as `complete` (URL folding, body mapping, retry ladder, gate,
    credential fetch); use this from async code paths (auto_classifier.py).
    Raises `httpx.HTTPStatusError` / `httpx.ConnectError` / `httpx.ReadTimeout`.

    Args:
        options: Ollama options dict sent as-is.  When None the "options" key is
                 omitted from the body (byte-parity with original auto_classifier).
        timeout: Request timeout in seconds (default 120).  Pass 30 for
                 auto_classifier.
    """
    base = base.rstrip("/")

    if kind == "ollama":
        resp = await _apost_with_retry(f"{base}/api/generate", _ollama_body(prompt, model, options, think), None, timeout)
        return resp.json()["response"]

    if kind in _OPENAI_KINDS:
        root = _v1_root(base)
        url = f"{root}/v1/chat/completions"
        body = _v1_body(prompt, model, options, think)
        fetch = _credential_fetch_enabled(api_key, kind)
        key = (await asyncio.to_thread(_fetch_generation_credential, root)) if fetch else api_key
        sem = _gate(root, max_concurrency)
        await asyncio.to_thread(sem.acquire)
        try:
            try:
                resp = await _apost_with_retry(url, body, _auth_headers(key), timeout)
            except httpx.HTTPStatusError as exc:
                if not (fetch and _status_of(exc) == 401):
                    raise
                _invalidate_credential(root)
                key = await asyncio.to_thread(_fetch_generation_credential, root)
                if not key:
                    raise
                resp = await _apost_with_retry(url, body, _auth_headers(key), timeout)
        finally:
            sem.release()
        return resp.json()["choices"][0]["message"]["content"]

    raise RuntimeError(f"llm_client: unsupported kind '{kind}'")
