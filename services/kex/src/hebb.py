"""Hebbian retrieval prior for /search — reinforced chunks rank a little higher,
strongly co-activated neighbours are pulled in.

api-rs (services/hebb.rs) writes the signal: every read path adds heat to the
chunks it returned and wires the chunks of one retrieval together in
`memory_coactivation`. This module is the read side, applied AFTER dense+lexical
fusion and the cross-encoder rerank:

  1. every candidate gets a bounded bonus  min(0.3, 0.1 * ln(1 + heat))  on a
     rank-preserving base score  1 - 0.02 * position  (the convention rag.rs uses),
     so heat 1 lifts a chunk ~3 ranks, heat 10 ~12, and the cap is 15 ranks —
     a prior, never an override of relevance;
  2. the strongest co-activation neighbours of the candidates that are NOT already
     in the list are added (at most limit // 4), scored just under their anchor:
     base_anchor - 0.05 - 0.2 * (1 - weight).

Fail-safe by design: any error, no Postgres, no user → the input order is kept.
"""

import logging
import math
from typing import Callable, Optional

logger = logging.getLogger(__name__)

PRIOR_SCALE = 0.1          # bonus = PRIOR_SCALE * ln(1 + heat)
PRIOR_CAP = 0.3            # ≈ 15 ranks at RANK_STEP 0.02
RANK_STEP = 0.02           # rank-preserving base: 1 - RANK_STEP * position
NEIGHBOUR_MIN_WEIGHT = 0.2 # pairs below this are not followed
NEIGHBOUR_OFFSET = 0.05    # a perfect pair lands 2.5 ranks under its anchor
NEIGHBOUR_WEAKNESS = 0.2   # a weight-0.2 pair lands another 8 ranks lower
NEIGHBOUR_FETCH = 50       # pairs read per query (strongest first)
NEIGHBOUR_CONFIDENCE = 0.35  # `score` a pulled-in chunk reports (lexical floor)


def heat_bonus(heat) -> float:
    """Bounded rank bonus for a chunk's heat. `heat` may be None (untyped on purpose:
    the Cython prod build enforces annotations as hard types)."""
    return min(PRIOR_CAP, PRIOR_SCALE * math.log1p(max(0.0, float(heat or 0.0))))


def neighbour_budget(limit: int) -> int:
    """How many co-activation neighbours may join a result of `limit` rows."""
    return max(1, int(limit) // 4)


def apply_prior(chunks: list[dict], heats: dict[str, float],
                neighbours: list[tuple[str, dict, float]], limit: int) -> list[dict]:
    """Pure re-ranking step.

    chunks     — ranked candidates (best first), each with a `chunk_id`.
    heats      — chunk_id → heat for the candidates.
    neighbours — (anchor_chunk_id, chunk_dict, weight) for chunks NOT among the
                 candidates, from `memory_coactivation`.
    Returns a new list of at most `limit` chunks; every chunk carries
    `hebb_bonus`, a pulled-in neighbour additionally `via: "coactivation"`.
    """
    limit = max(1, int(limit))
    if not chunks:
        return []
    scored: list[tuple[float, int, dict]] = []
    base_of: dict[str, float] = {}
    seen: set[str] = set()
    for pos, ch in enumerate(chunks):
        cid = ch.get("chunk_id") or ""
        base = 1.0 - RANK_STEP * pos
        if cid:
            base_of[cid] = base
            seen.add(cid)
        bonus = heat_bonus(heats.get(cid, 0.0)) if cid else 0.0
        out = dict(ch)
        out["hebb_bonus"] = round(bonus, 4)
        scored.append((base + bonus, 0, out))

    added = 0
    budget = neighbour_budget(limit)
    for anchor, nch, weight in sorted(neighbours, key=lambda t: t[2], reverse=True):
        if added >= budget:
            break
        nid = nch.get("chunk_id") or ""
        if not nid or nid in seen or anchor not in base_of or weight < NEIGHBOUR_MIN_WEIGHT:
            continue
        w = min(1.0, max(0.0, float(weight)))
        score = base_of[anchor] - NEIGHBOUR_OFFSET - NEIGHBOUR_WEAKNESS * (1.0 - w)
        out = dict(nch)
        out["hebb_bonus"] = 0.0
        out["via"] = "coactivation"
        out["coactivation_weight"] = round(w, 3)
        scored.append((score, 1, out))
        seen.add(nid)
        added += 1

    scored.sort(key=lambda t: (-t[0], t[1]))
    return [c for _, _, c in scored][:limit]


# ── Postgres side ────────────────────────────────────────────────────────────


def _mention_names(mentions) -> list[str]:
    names: list[str] = []
    seen: set[str] = set()
    for m in (mentions or []):
        nm = (m.get("name") or m.get("text") or "") if isinstance(m, dict) else str(m)
        nm = nm.strip()
        if nm and nm not in seen:
            seen.add(nm)
            names.append(nm)
    return names


def _normalize(rid, content, mentions, job_id, comp_id) -> dict:
    """Same chunk shape the dense/lexical channels produce (rag.rs deserializes it)."""
    return {
        "text": content or "",
        "score": NEIGHBOUR_CONFIDENCE,
        "entity_mentions": _mention_names(mentions),
        "source": "",
        "chunk_id": rid,
        "compilation_id": comp_id,
        "job_id": job_id,
    }


def load_prior_inputs(conn, user_id: Optional[str], chunks: list[dict],
                      max_rank: Optional[int], compilation_id: Optional[str]
                      ) -> tuple[dict[str, float], list[tuple[str, dict, float]]]:
    """Read heats for the candidates and their strongest co-activation neighbours
    (owner + archived + clearance + soft compilation scoped, like _scope_sql)."""
    ids = [c.get("chunk_id") for c in chunks if c.get("chunk_id")]
    if not ids:
        return {}, []
    heats: dict[str, float] = {}
    with conn.cursor() as cur:
        cur.execute("SELECT id::text, heat FROM text_chunks WHERE id = ANY(%s::uuid[])", (ids,))
        for rid, heat in cur.fetchall():
            heats[rid] = float(heat or 0.0)
    if not user_id:
        return heats, []

    # Strongest pairs touching a candidate; keep the best anchor per outside chunk.
    best: dict[str, tuple[str, float]] = {}
    with conn.cursor() as cur:
        cur.execute(
            "SELECT a::text, b::text, weight FROM memory_coactivation "
            "WHERE user_id = %s AND (a = ANY(%s::uuid[]) OR b = ANY(%s::uuid[])) "
            "  AND weight >= %s ORDER BY weight DESC LIMIT %s",
            (user_id, ids, ids, NEIGHBOUR_MIN_WEIGHT, NEIGHBOUR_FETCH),
        )
        idset = set(ids)
        for a, b, w in cur.fetchall():
            anchor, other = (a, b) if a in idset else (b, a)
            if other in idset:
                continue
            w = float(w or 0.0)
            if other not in best or w > best[other][1]:
                best[other] = (anchor, w)
    if not best:
        return heats, []

    clauses = ["id = ANY(%(ids)s::uuid[])", "user_id = %(uid)s", "archived = false"]
    params: dict = {"ids": list(best.keys()), "uid": user_id}
    if max_rank is not None:
        clauses.append("(min_rank IS NULL OR min_rank <= %(rank)s)")
        params["rank"] = max_rank
    if compilation_id:
        clauses.append("(compilation_id = %(comp)s OR compilation_id IS NULL)")
        params["comp"] = compilation_id
    neighbours: list[tuple[str, dict, float]] = []
    with conn.cursor() as cur:
        cur.execute(
            "SELECT id::text, content, entity_mentions, job_id::text, compilation_id::text "
            "FROM text_chunks WHERE " + " AND ".join(clauses),
            params,
        )
        for rid, content, mentions, job_id, comp_id in cur.fetchall():
            anchor, w = best[rid]
            neighbours.append((anchor, _normalize(rid, content, mentions, job_id, comp_id), w))
    return heats, neighbours


def rerank_with_memory(chunks: list[dict], *, user_id: Optional[str], limit: int,
                       max_rank: Optional[int], compilation_id: Optional[str],
                       conn_factory: Callable[[], object]) -> list[dict]:
    """Entry point for /search. Never raises; keeps the input order on any problem."""
    limit = max(1, int(limit))
    if not chunks:
        return chunks
    try:
        conn = conn_factory()
        if conn is None:
            return chunks[:limit]
        heats, neighbours = load_prior_inputs(conn, user_id, chunks, max_rank, compilation_id)
        out = apply_prior(chunks, heats, neighbours, limit)
        pulled = sum(1 for c in out if c.get("via") == "coactivation")
        lifted = sum(1 for c in out if (c.get("hebb_bonus") or 0) > 0)
        if pulled or lifted:
            logger.info("/search hebb: %d reinforced, %d pulled in via co-activation", lifted, pulled)
        return out
    except Exception as exc:  # noqa: BLE001 — a prior must never break retrieval
        logger.warning("/search hebb prior skipped: %s", exc)
        return chunks[:limit]
