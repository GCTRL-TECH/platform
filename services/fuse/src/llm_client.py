"""Runtime-aware generation client for FUSE.

Supports two backends, selected by `kind`:
  - "ollama"            → POST {base}/api/generate   (local Ollama)
  - "openai" | "openai_compatible" → POST {base}/v1/chat/completions

Both a sync variant (`complete`, uses `requests`) and an async variant
(`acomplete`, uses `httpx`) are provided.  FUSE currently only needs `complete`
(distiller.py is synchronous), but both are included for consistency so the
two modules (kex/fuse) can evolve in lockstep — they are separate deployables
and cannot share code.

Cython-safety note: NO local variable is annotated as dict/list/set.
Request bodies are built as inline literals passed directly to `.json=`.

Per-caller timeout and options contract:
  - `timeout` defaults to 120 s; callers override to match their original posture.
  - `options` for the Ollama branch: when None (the default) the key is OMITTED
    from the request body entirely (distiller parity with e71ecaf).
    When provided, it is sent as-is — no baked-in defaults, no merge.
"""

import httpx
import requests

_TIMEOUT = 120  # seconds — matches distiller.py's _LLM_TIMEOUT


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
                 body — preserving byte-parity with the original distiller
                 behaviour (e71ecaf).
        timeout: Request timeout in seconds (default 120).

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

    Same semantics as `complete`; included for consistency with the KEX module
    (both deployables expose identical interfaces).

    Args:
        options: Ollama options dict sent as-is.  When None the "options" key is
                 omitted from the body.
        timeout: Request timeout in seconds (default 120).
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
