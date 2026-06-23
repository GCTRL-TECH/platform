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
) -> str:
    """Synchronous LLM completion.  Uses `requests`.

    Args:
        prompt:  The user prompt.
        model:   Model identifier (e.g. "llama3.2", "gpt-4o-mini").
        base:    Base URL of the inference server (trailing slash stripped).
        kind:    "ollama" | "openai" | "openai_compatible"
        api_key: Bearer token; omitted from headers when None or empty string.
        options: Extra Ollama options dict merged into defaults (ollama only).

    Returns:
        The generated text as a string.

    Raises:
        requests.HTTPError: on non-2xx response.
        RuntimeError: on unsupported `kind`.
    """
    base = base.rstrip("/")

    if kind == "ollama":
        merged_options = {"temperature": 0.0, "num_predict": 1024}
        if options:
            merged_options.update(options)
        resp = requests.post(
            f"{base}/api/generate",
            json={"model": model, "prompt": prompt, "stream": False, "options": merged_options},
            timeout=_TIMEOUT,
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
            timeout=_TIMEOUT,
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
) -> str:
    """Async LLM completion.  Uses `httpx`.

    Same semantics as `complete`; included for consistency with the KEX module
    (both deployables expose identical interfaces).
    """
    base = base.rstrip("/")

    if kind == "ollama":
        merged_options = {"temperature": 0.0, "num_predict": 1024}
        if options:
            merged_options.update(options)
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            resp = await client.post(
                f"{base}/api/generate",
                json={"model": model, "prompt": prompt, "stream": False, "options": merged_options},
            )
            resp.raise_for_status()
            return resp.json()["response"]

    if kind in ("openai", "openai_compatible"):
        headers = {}
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
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
