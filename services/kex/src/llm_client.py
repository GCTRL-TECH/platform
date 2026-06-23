"""Runtime-aware generation client for KEX.

Supports two backends, selected by `kind`:
  - "ollama"            → POST {base}/api/generate   (local Ollama)
  - "openai" | "openai_compatible" → POST {base}/v1/chat/completions

Both a sync variant (`complete`, uses `requests`) and an async variant
(`acomplete`, uses `httpx`) are provided:
  - `complete`  is used by relex.py (sync pipeline)
  - `acomplete` is used by auto_classifier.py (async FastAPI handler)

Cython-safety note: NO local variable is annotated as dict/list/set.
Request bodies are built as inline literals passed directly to `.json=`.

Per-caller timeout and options contract:
  - `timeout` defaults to 120 s; callers override to match their original posture
    (relex: 180 s, auto_classifier: 30 s).
  - `options` for the Ollama branch: when None (the default) the key is OMITTED
    from the request body entirely (distiller / auto_classifier parity with
    e71ecaf).  When provided, it is sent as-is — no baked-in defaults, no merge.
"""

import httpx
import requests


def complete(
    prompt: str,
    model: str,
    base: str,
    kind: str,
    api_key=None,
    options=None,
    timeout=120,
) -> str:
    """Synchronous LLM completion.  Uses `requests`.

    Args:
        prompt:  The user prompt.
        model:   Model identifier (e.g. "llama3.2", "gpt-4o-mini").
        base:    Base URL of the inference server (trailing slash stripped).
        kind:    "ollama" | "openai" | "openai_compatible"
        api_key: Bearer token; omitted from headers when None or empty string.
        options: Ollama options dict sent as-is in the request body.  When None
                 (the default) the "options" key is omitted entirely from the
                 body — preserving byte-parity with the original distiller and
                 auto_classifier behaviour.
        timeout: Request timeout in seconds (default 120).  Pass 180 for relex.

    Returns:
        The generated text as a string.

    Raises:
        requests.HTTPError: on non-2xx response.
        RuntimeError: on unsupported `kind`.
    """
    base = base.rstrip("/")

    if kind == "ollama":
        if options is not None:
            body = {"model": model, "prompt": prompt, "stream": False, "options": options}
        else:
            body = {"model": model, "prompt": prompt, "stream": False}
        resp = requests.post(
            f"{base}/api/generate",
            json=body,
            timeout=timeout,
            allow_redirects=False,
        )
        resp.raise_for_status()
        return resp.json()["response"]

    if kind in ("openai", "openai_compatible"):
        headers = {}
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"
        resp = requests.post(
            f"{base}/v1/chat/completions",
            json={
                "model": model,
                "messages": [{"role": "user", "content": prompt}],
                "stream": False,
                "temperature": 0,
            },
            headers=headers if headers else None,
            timeout=timeout,
            allow_redirects=False,
        )
        resp.raise_for_status()
        return resp.json()["choices"][0]["message"]["content"]

    raise RuntimeError(f"llm_client: unsupported kind '{kind}'")


async def acomplete(
    prompt: str,
    model: str,
    base: str,
    kind: str,
    api_key=None,
    options=None,
    timeout=120,
) -> str:
    """Async LLM completion.  Uses `httpx`.

    Same semantics as `complete`; use this from async code paths (e.g.
    auto_classifier.py FastAPI handlers).

    Args:
        options: Ollama options dict sent as-is.  When None the "options" key is
                 omitted from the body (byte-parity with original auto_classifier).
        timeout: Request timeout in seconds (default 120).  Pass 30 for
                 auto_classifier.
    """
    base = base.rstrip("/")

    if kind == "ollama":
        if options is not None:
            body = {"model": model, "prompt": prompt, "stream": False, "options": options}
        else:
            body = {"model": model, "prompt": prompt, "stream": False}
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.post(
                f"{base}/api/generate",
                json=body,
            )
            resp.raise_for_status()
            return resp.json()["response"]

    if kind in ("openai", "openai_compatible"):
        headers = {}
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.post(
                f"{base}/v1/chat/completions",
                json={
                    "model": model,
                    "messages": [{"role": "user", "content": prompt}],
                    "stream": False,
                    "temperature": 0,
                },
                headers=headers if headers else None,
            )
            resp.raise_for_status()
            return resp.json()["choices"][0]["message"]["content"]

    raise RuntimeError(f"llm_client: unsupported kind '{kind}'")
