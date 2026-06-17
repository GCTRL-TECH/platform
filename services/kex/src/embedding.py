"""
Embedding client for KEX pipeline.

Supports multiple providers:
  - ollama: local Ollama instance (default, /api/embed endpoint)
  - nim:    NVIDIA NIM inference microservice (OpenAI-compatible /v1/embeddings)
  - openai: OpenAI or any OpenAI-compatible endpoint (/v1/embeddings)

Failure policy: individual chunk embedding failures are caught and logged.
The caller receives None in place of failed vectors so it can skip storage
for that chunk while allowing the rest of the pipeline to continue.
"""

import logging
from typing import Optional

import requests

from . import config

logger = logging.getLogger(__name__)

_EMBED_TIMEOUT = 30


class EmbeddingClient:
    def __init__(
        self,
        provider: str = "ollama",
        base_url: str = "http://ollama:11434",
        model: str = "nomic-embed-text",
        api_key: str = "",
    ):
        self.provider = provider
        self.model = model
        self.api_key = api_key

        if provider == "ollama":
            self.base_url = base_url.rstrip("/")
            self._embed_url = f"{self.base_url}/api/embed"
        else:
            # nim / openai — OpenAI-compatible
            if base_url:
                self.base_url = base_url.rstrip("/")
            elif provider == "nim":
                self.base_url = "https://integrate.api.nvidia.com/v1"
            else:
                self.base_url = "https://api.openai.com/v1"
            self._embed_url = f"{self.base_url}/embeddings"

    def embed(self, text: str) -> Optional[list[float]]:
        if not text or not text.strip():
            return None
        try:
            if self.provider == "ollama":
                return self._embed_ollama(text)
            else:
                return self._embed_openai_compat([text])[0]
        except Exception as exc:
            logger.warning(f"EmbeddingClient: embed failed: {exc}")
            return None

    def embed_batch(self, texts: list[str]) -> list[Optional[list[float]]]:
        if not texts:
            return []
        try:
            if self.provider == "ollama":
                return self._embed_ollama_batch(texts)
            else:
                return self._embed_openai_compat(texts)
        except Exception as exc:
            logger.warning(f"EmbeddingClient: batch embed failed ({exc}), falling back to sequential")
            return [self.embed(t) for t in texts]

    def _embed_ollama(self, text: str) -> Optional[list[float]]:
        resp = requests.post(
            self._embed_url,
            json={"model": self.model, "input": text},
            timeout=_EMBED_TIMEOUT,
            # SSRF hardening: never follow a redirect — a validated base must not be
            # able to 302 the request onward to e.g. a cloud-metadata endpoint.
            allow_redirects=False,
        )
        resp.raise_for_status()
        data = resp.json()
        embeddings = data.get("embeddings")
        if not embeddings or not isinstance(embeddings, list):
            logger.warning(f"EmbeddingClient: unexpected response shape: {list(data.keys())}")
            return None
        vector = embeddings[0]
        if not isinstance(vector, list) or len(vector) == 0:
            logger.warning(f"EmbeddingClient: empty vector for model={self.model}")
            return None
        return vector

    def _embed_ollama_batch(self, texts: list[str]) -> list[Optional[list[float]]]:
        clean = [t.strip() if t else "" for t in texts]
        try:
            resp = requests.post(
                self._embed_url,
                json={"model": self.model, "input": clean},
                timeout=_EMBED_TIMEOUT * 2,
                allow_redirects=False,
            )
            resp.raise_for_status()
            data = resp.json()
            embeddings = data.get("embeddings", [])
            if isinstance(embeddings, list) and len(embeddings) == len(texts):
                results: list[Optional[list[float]]] = []
                for vec in embeddings:
                    results.append(vec if isinstance(vec, list) and len(vec) > 0 else None)
                logger.info(f"EmbeddingClient: batch embedded {len(texts)} texts")
                return results
        except Exception as exc:
            logger.warning(f"EmbeddingClient: Ollama batch failed ({exc}), falling back")
        return [self._embed_ollama(t) for t in texts]

    def _embed_openai_compat(self, texts: list[str]) -> list[Optional[list[float]]]:
        headers: dict[str, str] = {"Content-Type": "application/json"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"

        body: dict = {"model": self.model, "input": texts}
        if self.provider == "nim":
            body["input_type"] = "query"
            body["encoding_format"] = "float"
            body["truncate"] = "NONE"

        resp = requests.post(
            self._embed_url,
            json=body,
            headers=headers,
            timeout=_EMBED_TIMEOUT * 2,
            allow_redirects=False,
        )
        resp.raise_for_status()
        data = resp.json()

        results: list[Optional[list[float]]] = [None] * len(texts)
        for item in data.get("data", []):
            idx = item.get("index", 0)
            vec = item.get("embedding")
            if isinstance(vec, list) and len(vec) > 0 and idx < len(results):
                results[idx] = vec

        logger.info(f"EmbeddingClient [{self.provider}]: embedded {len(texts)} texts")
        return results


# ── Module-level singleton ────────────────────────────────────────────

_client: Optional[EmbeddingClient] = None


def get_embedding_client() -> EmbeddingClient:
    global _client
    if _client is None:
        _client = EmbeddingClient(
            provider=config.EMBEDDING_PROVIDER,
            base_url=config.EMBEDDING_BASE_URL or config.OLLAMA_BASE,
            model=config.EMBEDDING_MODEL,
            api_key=config.EMBEDDING_API_KEY,
        )
    return _client


def build_embedding_client(
    embedding_base_url: Optional[str] = None,
    embedding_provider: Optional[str] = None,
    ollama_base: Optional[str] = None,
    embedding_model: Optional[str] = None,
) -> EmbeddingClient:
    """Build an EmbeddingClient honoring optional per-job overrides.

    Used by the extraction pipeline so a job can target the owner's runtime
    Ollama endpoint (Settings → Infrastructure) instead of the container's env
    defaults. Any override left None/empty falls back to the env-based config,
    so with no overrides this is equivalent to `get_embedding_client()` — keeping
    the default install unchanged.

    Resolution mirrors the singleton: an Ollama embedding client's base comes from
    `embedding_base_url` → `ollama_base` → `config.EMBEDDING_BASE_URL` →
    `config.OLLAMA_BASE`, so passing just `ollama_base` (the common case) redirects
    embeddings to the same Ollama the relation extractor uses.
    """
    base_override = (embedding_base_url or "").strip() or (ollama_base or "").strip()
    provider = (embedding_provider or "").strip() or config.EMBEDDING_PROVIDER
    model = (embedding_model or "").strip() or config.EMBEDDING_MODEL
    # No override at all → reuse the cached singleton (identical behaviour to today).
    if not base_override and not (embedding_provider or "").strip() and not (embedding_model or "").strip():
        return get_embedding_client()
    base_url = base_override or config.EMBEDDING_BASE_URL or config.OLLAMA_BASE
    return EmbeddingClient(
        provider=provider,
        base_url=base_url,
        model=model,
        api_key=config.EMBEDDING_API_KEY,
    )
