"""
Embedding client for KEX pipeline.

Calls the Ollama /api/embed endpoint to produce dense vector embeddings
for text chunks. Uses nomic-embed-text (768-dim) by default.

Failure policy: individual chunk embedding failures are caught and logged.
The caller receives None in place of failed vectors so it can skip storage
for that chunk while allowing the rest of the pipeline to continue.
"""

import logging
from typing import Optional

import requests

from . import config

logger = logging.getLogger(__name__)

# Ollama /api/embed request timeout in seconds.
# Embedding a single ~800-char chunk typically takes < 1s on CPU.
_EMBED_TIMEOUT = 30


class EmbeddingClient:
    """
    Thin wrapper around Ollama's embedding endpoint.

    Parameters
    ----------
    base_url : str
        Base URL of the Ollama instance (no trailing slash).
    model : str
        Ollama model name that supports embedding (e.g. nomic-embed-text).
    """

    def __init__(
        self,
        base_url: str = "http://ollama:11434",
        model: str = "nomic-embed-text",
    ):
        self.base_url = base_url.rstrip("/")
        self.model = model
        self._embed_url = f"{self.base_url}/api/embed"

    def embed(self, text: str) -> Optional[list[float]]:
        """
        Embed a single text string.

        Returns the embedding vector on success, None on any failure.
        Never raises — callers should check for None.
        """
        if not text or not text.strip():
            return None

        try:
            resp = requests.post(
                self._embed_url,
                json={"model": self.model, "input": text},
                timeout=_EMBED_TIMEOUT,
            )
            resp.raise_for_status()
            data = resp.json()

            # Ollama /api/embed returns {"embeddings": [[...], ...]}
            embeddings = data.get("embeddings")
            if not embeddings or not isinstance(embeddings, list):
                logger.warning(f"EmbeddingClient: unexpected response shape: {list(data.keys())}")
                return None

            vector = embeddings[0]
            if not isinstance(vector, list) or len(vector) == 0:
                logger.warning(f"EmbeddingClient: empty vector returned for model={self.model}")
                return None

            return vector

        except requests.exceptions.Timeout:
            logger.warning(f"EmbeddingClient: timeout embedding text (len={len(text)})")
            return None
        except requests.exceptions.ConnectionError as exc:
            logger.warning(f"EmbeddingClient: connection error to {self._embed_url}: {exc}")
            return None
        except Exception as exc:
            logger.warning(f"EmbeddingClient: embed failed: {exc}")
            return None

    def embed_batch(self, texts: list[str]) -> list[Optional[list[float]]]:
        """
        Embed a list of texts using Ollama's batch API.
        Sends all texts in a single request for efficiency.
        Falls back to one-by-one on failure.
        """
        if not texts:
            return []

        # Try batch first (Ollama supports list input)
        clean_texts = [t.strip() if t else "" for t in texts]
        try:
            resp = requests.post(
                self._embed_url,
                json={"model": self.model, "input": clean_texts},
                timeout=_EMBED_TIMEOUT * 2,  # longer timeout for batch
            )
            resp.raise_for_status()
            data = resp.json()
            embeddings = data.get("embeddings", [])
            if isinstance(embeddings, list) and len(embeddings) == len(texts):
                results: list[Optional[list[float]]] = []
                for vec in embeddings:
                    if isinstance(vec, list) and len(vec) > 0:
                        results.append(vec)
                    else:
                        results.append(None)
                logger.info(f"EmbeddingClient: batch embedded {len(texts)} texts in single request")
                return results
        except Exception as exc:
            logger.warning(f"EmbeddingClient: batch embed failed ({exc}), falling back to sequential")

        # Fallback: one by one
        results = []
        for text in texts:
            results.append(self.embed(text))
        return results


# ── Module-level singleton ────────────────────────────────────────────

_client: Optional[EmbeddingClient] = None


def get_embedding_client() -> EmbeddingClient:
    """Return (and cache) an EmbeddingClient using settings from config."""
    global _client
    if _client is None:
        _client = EmbeddingClient(
            base_url=config.OLLAMA_BASE,
            model=config.EMBEDDING_MODEL,
        )
    return _client
