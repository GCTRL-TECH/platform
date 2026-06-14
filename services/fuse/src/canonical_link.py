"""
Canonical Entity-Linking by CONTEXT (embeddings) for GCTRL FUSE.
────────────────────────────────────────────────────────────────

The deep cure for CROSS-COARSE-BUCKET entity fragmentation. The coarse-blocked
stages (APOC / resolver / smart-match) only ever compare entities in the SAME
coarse bucket, so a real-world entity tagged `organization` in one document and
`technology` in another stays split into two nodes. This pass closes that gap:

  1. Candidate generation (cheap, no embeddings): across DIFFERENT source jobs,
     pair entities whose NAMES are strong matches IGNORING coarse type, keeping
     only pairs whose coarse buckets DIFFER (same-bucket is already handled).
  2. Context confirmation (the disambiguator): embed a short CONTEXT string per
     entity (name + 1-hop neighbours + an optional grounding chunk snippet) via
     Ollama `nomic-embed-text`. MERGE only when cosine ≥ threshold. This lets
     "Ground Control"(org) + "Ground Control"(tech) collapse (both contexts are
     about the platform) while "Apple"(company) vs "Apple"(fruit) stay apart.

DSGVO/local by design: embeddings come from the in-container Ollama; nothing
leaves the host. Fail-open: if Ollama is unreachable the pass is skipped with a
logged warning and the merge proceeds unchanged.

The name-matching helpers (`_is_acronym_match`, `_smart_token_match`,
`_smart_significant_words`, `_person_initial_match`) are imported from
``merger`` so candidate generation reuses exactly the conservative surface
rules the smart-match pass already trusts.
"""

import logging
import math
import os
from typing import Optional

import requests

logger = logging.getLogger(__name__)

# ── Tunables (module constants, env-overridable for A/B) ─────────────────────
# Cosine on nomic-embed-text contexts. Start 0.82 (per spec); tuned so the
# Founder-KB true cross-bucket pairs (ground control org+tech, fjalla, tentris,
# obsidian, fabio) merge while genuine homonyms do not. Overridable via
# GCTRL_CANONICAL_THRESHOLD without a rebuild.
CANONICAL_COSINE_THRESHOLD: float = float(
    os.environ.get("GCTRL_CANONICAL_THRESHOLD", "0.82")
)
# Hard cap on candidate pairs that get embedded, so a pathological merge can't
# fire thousands of Ollama calls. Highest name-similarity pairs are kept first.
MAX_CANONICAL_PAIRS: int = int(os.environ.get("GCTRL_CANONICAL_MAX_PAIRS", "300"))

OLLAMA_BASE = os.environ.get("OLLAMA_BASE", "http://ollama:11434")
EMBED_MODEL = os.environ.get("GCTRL_CANONICAL_EMBED_MODEL", "nomic-embed-text")
QDRANT_URL = os.environ.get("QDRANT_URL", "http://qdrant:6333")
QDRANT_COLLECTION = os.environ.get("QDRANT_COLLECTION", "GCTRL_chunks")

_EMBED_TIMEOUT = 30
_QDRANT_TIMEOUT = 10
# How many 1-hop neighbour names to fold into an entity's context string.
_CTX_NEIGHBORS = 5
# Max chars of a grounding snippet appended to the context (kept short so the
# name + neighbours dominate the embedding signal).
_CTX_SNIPPET_CHARS = 240


def _normalize_name(name: str) -> str:
    return (name or "").strip().lower()


# ── Embedding via Ollama (batched) ───────────────────────────────────────────

# Max inputs per Ollama /api/embed request. nomic-embed-text rejects very large
# batches (HTTP 400) — a single 2000-input call fails — so we chunk. 64 is well
# within limits and keeps per-request latency low.
_EMBED_BATCH = int(os.environ.get("GCTRL_EMBED_BATCH", "64"))


def embed_texts(texts: list[str]) -> Optional[list[list[float]]]:
    """Embed a list of strings via Ollama `nomic-embed-text` /api/embed.

    BATCHED: Ollama rejects very large single requests (HTTP 400), so inputs are
    chunked into ``_EMBED_BATCH``-sized requests and concatenated in order.
    Returns a list of vectors aligned to ``texts``, or None on any failure
    (caller treats None as "Ollama unreachable" → skip the pass / fail open).
    """
    if not texts:
        return []
    out: list[list[float]] = []
    try:
        for i in range(0, len(texts), _EMBED_BATCH):
            chunk = texts[i:i + _EMBED_BATCH]
            resp = requests.post(
                f"{OLLAMA_BASE}/api/embed",
                json={"model": EMBED_MODEL, "input": chunk},
                timeout=_EMBED_TIMEOUT,
            )
            resp.raise_for_status()
            data = resp.json()
            embs = data.get("embeddings")
            if embs is None:
                # Single-input form returns {"embedding": [...]}.
                single = data.get("embedding")
                embs = [single] if single else None
            if not embs or len(embs) != len(chunk):
                logger.warning(
                    "canonical: embed returned %s vectors for %s inputs",
                    len(embs) if embs else 0, len(chunk),
                )
                return None
            out.extend(embs)
        return out
    except Exception as exc:
        logger.warning(f"canonical: Ollama embed failed ({exc}) — skipping pass")
        return None


def cosine(a: list[float], b: list[float]) -> float:
    """Cosine similarity of two equal-length vectors. 0.0 on degenerate input."""
    if not a or not b or len(a) != len(b):
        return 0.0
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    if na == 0.0 or nb == 0.0:
        return 0.0
    return dot / (na * nb)


# ── Context assembly (Neo4j 1-hop + optional Qdrant snippet) ─────────────────

def fetch_contexts(driver, uris: list[str]) -> dict[str, str]:
    """Build a short CONTEXT string per entity URI.

    context = name + up to `_CTX_NEIGHBORS` neighbour "name (rel)" fragments
    from a 1-hop Neo4j walk (skipping structural CONTAINS/SIMILAR_TO edges).
    Returns {uri: context_string}. One round-trip for the whole batch.
    """
    if not uris:
        return {}
    query = """
    MATCH (e:Entity) WHERE e.uri IN $uris
    OPTIONAL MATCH (e)-[r]-(n:Entity)
      WHERE NOT type(r) IN ['CONTAINS', 'SIMILAR_TO'] AND n.name IS NOT NULL
    WITH e, collect(DISTINCT (n.name + ' (' + type(r) + ')'))[..$k] AS neigh
    RETURN e.uri AS uri, e.name AS name, e.type AS type, neigh
    """
    out: dict[str, str] = {}
    with driver.session() as session:
        result = session.run(query, uris=uris, k=_CTX_NEIGHBORS)
        for rec in result:
            name = rec["name"] or ""
            neigh = [x for x in (rec["neigh"] or []) if x]
            ctx = name
            if neigh:
                ctx += ". Related: " + ", ".join(neigh)
            out[rec["uri"]] = ctx
    # Entities with no row (shouldn't happen) fall back to empty → filled later.
    for u in uris:
        out.setdefault(u, "")
    return out


def enrich_with_qdrant(
    contexts: dict[str, str],
    name_by_uri: dict[str, str],
    source_job_ids: list[str],
) -> None:
    """Cheaply append a grounding chunk snippet to each context, in place.

    Best-effort: one Qdrant scroll over the merge's source jobs, then per entity
    pick the first chunk whose text mentions the entity name. Skipped silently
    on any failure (the Neo4j context alone is enough to disambiguate).
    """
    try:
        body = {
            "filter": {"must": [{"key": "job_id", "match": {"any": source_job_ids}}]},
            "limit": 256,
            "with_payload": True,
            "with_vector": False,
        }
        resp = requests.post(
            f"{QDRANT_URL}/collections/{QDRANT_COLLECTION}/points/scroll",
            json=body,
            timeout=_QDRANT_TIMEOUT,
        )
        resp.raise_for_status()
        points = resp.json().get("result", {}).get("points", [])
    except Exception as exc:
        logger.info(f"canonical: Qdrant enrich skipped ({exc})")
        return

    texts = [(p.get("payload") or {}).get("text") or "" for p in points]
    lowered = [t.lower() for t in texts]
    for uri, name in name_by_uri.items():
        needle = _normalize_name(name)
        if not needle:
            continue
        for t, lt in zip(texts, lowered):
            if needle in lt:
                snippet = t.strip()[:_CTX_SNIPPET_CHARS]
                contexts[uri] = (contexts.get(uri, "") + " " + snippet).strip()
                break


# ── Candidate generation (cross-bucket, name-strong, cross-job) ──────────────

def generate_candidates(
    entities: list[dict],
    *,
    coarse_of,
    is_acronym_match,
    smart_token_match,
    smart_significant_words,
    person_initial_match,
) -> list[tuple[dict, dict, float]]:
    """Cross-bucket candidate pairs with strong surface name evidence.

    Returns a list of (e1, e2, name_score) where:
      * e1, e2 are from DIFFERENT source jobs,
      * BOTH carry a REAL `coarse_type` (the KEX 11-bucket label) — entities
        without one (synthetic gold `BQ_<i>`, pre-coarse legacy data) are
        EXCLUDED. The "cross-bucket" concept only exists relative to the real
        coarse taxonomy; without it the per-pair fallback types are all distinct
        and would spuriously pair the gold's hard same-name negatives. This is
        the guard that keeps the gold/regression path a strict no-op.
      * their coarse buckets DIFFER (same-bucket is handled by other stages),
      * names match by exact-normalized equality OR an acronym / token-sort /
        person-initial rule (reusing the smart-match helpers).
    `name_score` ranks candidates so the cap keeps the strongest first.
    """
    # Only entities with a genuine KEX coarse_type participate. The fallback in
    # `_coarse_of` (which returns the fine `type`/QID for un-coarsed data) must
    # NOT drive cross-bucket pairing — see the docstring guard above.
    ents = [
        e for e in entities
        if (e.get("name") or "").strip() and e.get("uri") and e.get("coarse_type")
    ]
    out: list[tuple[dict, dict, float]] = []
    seen: set[tuple[str, str]] = set()

    # Precompute per-entity significant words to keep the O(n²) sweep cheap.
    words_cache = {id(e): smart_significant_words(e["name"].strip()) for e in ents}

    for i, e1 in enumerate(ents):
        n1 = e1["name"].strip()
        c1 = coarse_of(e1)
        j1 = e1.get("source_job")
        norm1 = _normalize_name(n1)
        w1 = words_cache[id(e1)]
        for j in range(i + 1, len(ents)):
            e2 = ents[j]
            if e1.get("source_job") == e2.get("source_job"):
                continue  # cross-job only (mirrors the other stages)
            c2 = coarse_of(e2)
            if c1 == c2:
                continue  # cross-bucket ONLY — same-bucket already handled
            n2 = e2["name"].strip()

            # Named entities only: skip dates / numbers / near-empty tokens,
            # matching smart-match's guard (real graphs hold many same-shape
            # date/metric entities that must never collapse).
            if (n1[:1].isdigit() or n2[:1].isdigit()
                    or sum(ch.isalpha() for ch in n1) < 2
                    or sum(ch.isalpha() for ch in n2) < 2):
                continue

            pair_key = (min(e1["uri"], e2["uri"]), max(e1["uri"], e2["uri"]))
            if pair_key in seen:
                continue

            norm2 = _normalize_name(n2)
            w2 = words_cache[id(e2)]
            score = 0.0

            if norm1 and norm1 == norm2:
                score = 1.0
            else:
                # Acronym (one side initials/embedded-caps of the other).
                if len(w1) <= 1 or len(w2) <= 1:
                    short, long_name = (
                        (n1, n2) if len(n1.replace(" ", "")) <= len(n2.replace(" ", "")) else (n2, n1)
                    )
                    sw = smart_significant_words(short)
                    lw = smart_significant_words(long_name)
                    if len(sw) <= 1 and len(lw) >= 2 and is_acronym_match(short, long_name):
                        score = 0.95
                # Token-sort / token-set (word-order variants).
                if score == 0.0:
                    jac = smart_token_match(n1, n2)
                    if jac >= 0.9 and len(w1) >= 2 and len(w2) >= 2:
                        score = max(score, 0.90)
                # Person initials ("P. Vance" ↔ "Patricia Vance").
                if score == 0.0:
                    pw1 = smart_significant_words(n1, drop_titles=True)
                    pw2 = smart_significant_words(n2, drop_titles=True)
                    if person_initial_match(pw1, pw2) or person_initial_match(pw2, pw1):
                        score = 0.90

            if score > 0.0:
                seen.add(pair_key)
                out.append((e1, e2, score))

    # Strongest name evidence first, so the cap keeps the best candidates.
    out.sort(key=lambda t: t[2], reverse=True)
    return out
