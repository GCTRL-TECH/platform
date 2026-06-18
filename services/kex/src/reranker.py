"""Cross-encoder reranker — re-scores the RRF candidate set by true query×passage
relevance, the precision step that dense+lexical fusion alone lacks.

Lightweight by design: a small cross-encoder (ms-marco-MiniLM-L-6-v2, ~22M params,
~90 MB) loaded via the torch+transformers runtime ALREADY present for GLiNER — no new
dependency. Lazy-loaded on first use and guarded so ANY load/inference failure degrades
to a no-op that preserves the incoming RRF order: retrieval must never break because the
reranker is slow/unavailable. Model is env-swappable (RERANK_MODEL) so prod can use a
multilingual reranker (e.g. BAAI/bge-reranker-v2-m3) for German/EU corpora.
"""
import logging
import os
import threading

logger = logging.getLogger(__name__)

RERANK_MODEL = os.environ.get("RERANK_MODEL", "cross-encoder/ms-marco-MiniLM-L-6-v2")
# OFF by default: the small English ms-marco MiniLM REGRESSED the memory benchmark
# (12.5/6.2 % vs ~25 % baseline) — wrong training distribution for conversational/EU
# corpora, and it overrode the existing lexical re-rank. Keep the module for a future
# multilingual reranker (set RERANK_MODEL=BAAI/bge-reranker-v2-m3 + RERANK_ENABLED=true
# and re-measure before trusting it).
RERANK_ENABLED = os.environ.get("RERANK_ENABLED", "false").lower() in ("1", "true", "yes")
RERANK_MAX_LEN = int(os.environ.get("RERANK_MAX_LEN", "512"))

_MODEL = None
_TOKENIZER = None
_LOCK = threading.Lock()  # serialise inference (CPU, shared with GLiNER pattern)
_FAILED = False


def _load() -> None:
    global _MODEL, _TOKENIZER, _FAILED
    if _MODEL is not None or _FAILED:
        return
    with _LOCK:
        if _MODEL is not None or _FAILED:
            return
        try:
            import torch  # noqa: F401  (ensure runtime present)
            from transformers import (AutoModelForSequenceClassification,
                                      AutoTokenizer)
            _TOKENIZER = AutoTokenizer.from_pretrained(RERANK_MODEL)
            _MODEL = AutoModelForSequenceClassification.from_pretrained(RERANK_MODEL)
            _MODEL.eval()
            logger.info("Reranker loaded: %s", RERANK_MODEL)
        except Exception as e:  # noqa: BLE001 — never let the reranker break search
            _FAILED = True
            logger.warning("Reranker load failed (%s) — keeping RRF order", e)


def rerank(query: str, chunks: list, top_k: int | None = None) -> list:
    """Reorder `chunks` (list of dicts with a 'text' field) by cross-encoder
    relevance to `query`, most-relevant first; return the top_k (or all). No-op that
    returns the input order if disabled, empty, or on any failure."""
    if not RERANK_ENABLED or not chunks:
        return chunks[:top_k] if top_k else chunks
    _load()
    if _MODEL is None:
        return chunks[:top_k] if top_k else chunks
    try:
        import torch
        pairs = [[query, str(c.get("text") or "")] for c in chunks]
        with _LOCK:
            with torch.no_grad():
                enc = _TOKENIZER(pairs, padding=True, truncation=True,
                                 max_length=RERANK_MAX_LEN, return_tensors="pt")
                logits = _MODEL(**enc).logits.squeeze(-1)
                scores = logits.tolist()
        if not isinstance(scores, list):
            scores = [scores]
        for c, s in zip(chunks, scores):
            c["_rerank"] = float(s)
        ranked = sorted(chunks, key=lambda c: c.get("_rerank", -1e9), reverse=True)
        return ranked[:top_k] if top_k else ranked
    except Exception as e:  # noqa: BLE001
        logger.warning("Rerank failed (%s) — keeping RRF order", e)
        return chunks[:top_k] if top_k else chunks
