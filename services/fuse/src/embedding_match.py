"""
Embedding Reciprocal Best-Buddy + Model-Number matcher for GCTRL FUSE.
═══════════════════════════════════════════════════════════════════════

The DIRTY-TEXT quality lever. The trigram/LIMES Stage-2 path lands at the
classic-string ER tier on noisy product-style names (Abt-Buy faithful F1 ≈ 0.48)
because a single char-trigram name signal cannot separate true matches from
same-category negatives: the titles are reordered, abbreviated, or model-number-
only, and there is no clean key (like DBLP's `year`) to block/confirm on.

This module implements the recipe that closed most of that gap in the offline
research cycle (bench/er/abtbuy_research.py): **F1 0.48 → 0.87** UNSUPERVISED,
past DeepMatcher (0.628), near Ditto (0.891). Three complementary signals, all
local (DSGVO — embeddings come from the in-container Ollama):

  1. RECIPROCAL BEST-BUDDY on NAME embeddings (nomic-embed-text). For each source
     entity, its single most cosine-similar target, and vice versa. A pair is
     admitted only when it is the MUTUAL top-1. This reciprocity constraint is
     the precision engine: a flat cosine threshold drowns in same-category false
     positives (every microwave is near every microwave → P≈0.07), but forcing a
     1:1 mutual-best competition lifts precision to ≈0.92 at the same recall.

  2. RECIPROCAL BEST-BUDDY on NAME+DESCRIPTION embeddings. A second independent
     channel that recovers true pairs whose NAMES diverge structurally but whose
     descriptions align ("1.6 cu.ft over the range microwave" ↔ "lg …microwave
     lmv1680ss"). Unioned with channel 1 (each is high-precision on its own).

  3. STRICT MODEL-NUMBER / SKU. Normalised alphanumeric part tokens (len ≥ 5)
     shared across catalogs are a high-precision identity signal even when the
     title is fully rewritten. Confirmed with a light trigram floor so accidental
     SKU collisions on unrelated products are dropped.

GATING: this pass is OFF by default and only runs when a merge explicitly asks
for it (enable_embedding_match=True) on the GENERAL (noisy, name-only) path. The
clean field-mode path (DBLP-ACM) and the synthetic gold never see it unless it
strictly helps. All thresholds are module constants, env-overridable for A/B.

FAIL-OPEN: if Ollama is unreachable the pass returns [] and the merge proceeds on
the trigram/LIMES path unchanged (same contract as canonical_link).
"""

import logging
import os
import re

from . import canonical_link

logger = logging.getLogger(__name__)

# ── Embedding-match cutoffs ───────────────────────────────────────────────────
# These are the GENERIC, conservative open-source defaults (precision-leaning, so
# below the tuned profile on recall). Env-overridable, and additionally settable
# at runtime by `apply_embedding_overrides()` from the license-delivered tuning
# profile (see services/fuse/src/tuning.py). A tuning miss → exactly these values.
# Reciprocal best-buddy (mutual-top-1) name + name+desc floors.
EMB_NAME_BB_THRESHOLD: float = float(
    os.environ.get("GCTRL_EMB_NAME_BB_THRESHOLD", "0.55")
)
EMB_NAMEDESC_BB_THRESHOLD: float = float(
    os.environ.get("GCTRL_EMB_NAMEDESC_BB_THRESHOLD", "0.60")
)
# Absolute cosine magnitude gate: a best-buddy pair is admitted only if its real
# cosine ≥ this floor (drops force-paired noise in heterogeneous pools).
EMB_MATCH_COSINE_FLOOR: float = float(
    os.environ.get("GCTRL_EMB_MATCH_COSINE_FLOOR", "0.75")
)
# Strict model-number: only tokens this long count; the pair is then trigram-
# confirmed on the name.
EMB_MODEL_MIN_LEN: int = int(os.environ.get("GCTRL_EMB_MODEL_MIN_LEN", "6"))
EMB_MODEL_TRIGRAM_FLOOR: float = float(
    os.environ.get("GCTRL_EMB_MODEL_TRIGRAM_FLOOR", "0.30")
)
# Engage the (more expensive, embedding-driven) pass only on batches at least this
# large — below it the trigram path is adequate and we avoid an Ollama round-trip.
EMB_MATCH_MIN_ENTITIES: int = int(
    os.environ.get("GCTRL_EMB_MATCH_MIN_ENTITIES", "30")
)


def apply_embedding_overrides(overrides: dict | None) -> None:
    """Apply a license-delivered embedding-tuning override at runtime. Mutates the
    module globals (read by the matcher at call time). Unknown / missing keys are
    ignored, leaving the generic default in place. Never raises."""
    if not overrides:
        return
    g = globals()
    _floats = {
        "name_bb": "EMB_NAME_BB_THRESHOLD",
        "namedesc_bb": "EMB_NAMEDESC_BB_THRESHOLD",
        "cosine_floor": "EMB_MATCH_COSINE_FLOOR",
        "model_trigram_floor": "EMB_MODEL_TRIGRAM_FLOOR",
    }
    _ints = {"model_min_len": "EMB_MODEL_MIN_LEN", "min_entities": "EMB_MATCH_MIN_ENTITIES"}
    for key, gname in _floats.items():
        if overrides.get(key) is not None:
            try:
                g[gname] = float(overrides[key])
            except (TypeError, ValueError):
                pass
    for key, gname in _ints.items():
        if overrides.get(key) is not None:
            try:
                g[gname] = int(overrides[key])
            except (TypeError, ValueError):
                pass
# Confidence floor for whether to fold the name+description channel in. When a
# batch has NO usable descriptions (median desc length below this), channel 2 is
# identical to channel 1 and adds nothing, so it is skipped.
_MIN_DESC_CHARS = 8
_MAX_EMBED_TEXT = 1200            # truncate very long name+desc strings


# ── Similarity primitives (mirror the research harness EXACTLY) ──────────────

def _char_trigrams(s: str) -> set:
    t = re.sub(r"[^a-z0-9]+", " ", (s or "").lower()).strip()
    t = f"  {t}  "
    return {t[i:i + 3] for i in range(len(t) - 2)}


def _trigram_jaccard(a: str, b: str) -> float:
    ta, tb = _char_trigrams(a), _char_trigrams(b)
    if not ta or not tb:
        return 0.0
    return len(ta & tb) / len(ta | tb)


# Mixed letter+digit run, or letters-then-digits like "pslx350h", "ezxs88w",
# "am53bk", "lmv1680ss", "vgc-lv140j". Must contain a digit; separators stripped.
_MODEL_RE = re.compile(r"\b([a-z]{0,5}[-/]?\d{2,}[a-z0-9\-]*|[a-z]{2,}\d+[a-z0-9]*)\b")


def model_tokens(name: str, min_len: int = EMB_MODEL_MIN_LEN) -> set:
    """Normalised alphanumeric model/SKU tokens (len ≥ min_len) from a name."""
    name = (name or "").lower()
    out = set()
    for m in _MODEL_RE.findall(name):
        norm = re.sub(r"[-/ ]", "", m)
        if any(c.isdigit() for c in norm) and len(norm) >= min_len:
            out.add(norm)
    return out


# ── Cosine over (optionally) un-normalised vectors ───────────────────────────

def _norm_vec(v: list[float]) -> list[float]:
    import math
    n = math.sqrt(sum(x * x for x in v)) or 1.0
    return [x / n for x in v]


def _reciprocal_best_buddies(
    src_uris: list[str], tgt_uris: list[str],
    src_vecs: dict, tgt_vecs: dict, threshold: float,
    cosine_floor: float = EMB_MATCH_COSINE_FLOOR,
) -> dict:
    """Mutual top-1 cosine pairs, gated by an ABSOLUTE cosine floor.

    Returns ``{(uri_src, uri_tgt): cosine}`` for every pair that is
    simultaneously (a) the mutual top-1 (each is the other's argmax), (b) above
    the per-channel best-buddy ``threshold``, and (c) above the absolute
    ``cosine_floor``. The floor is the guardrail that keeps the mutual-top-1
    competition from force-pairing unrelated singletons in a small heterogeneous
    pool: reciprocity alone says "you're each other's closest", the floor adds
    "…AND you're actually close". The returned cosine is the REAL magnitude, used
    downstream as the link confidence (no flat 0.9).

    Pure-python (no numpy dependency in the service image): for each source its
    argmax target and vice versa, admit the pair iff each is the other's best.
    O(|src|·|tgt|·dim) — fine for the candidate batch sizes FUSE sees per merge.
    """
    sv = {u: _norm_vec(src_vecs[u]) for u in src_uris if u in src_vecs}
    tv = {u: _norm_vec(tgt_vecs[u]) for u in tgt_uris if u in tgt_vecs}
    if not sv or not tv:
        return {}
    tv_items = list(tv.items())

    def best_for(vec, items):
        best_u, best_c = None, -1.0
        for u, w in items:
            c = sum(x * y for x, y in zip(vec, w))
            if c > best_c:
                best_u, best_c = u, c
        return best_u, best_c

    # source → best target
    s_best = {u: best_for(v, tv_items) for u, v in sv.items()}
    sv_items = list(sv.items())
    # target → best source
    t_best = {u: best_for(v, sv_items) for u, v in tv.items()}

    floor = max(threshold, cosine_floor)  # the floor never loosens the threshold
    pairs: dict = {}
    for su, (tb, tc) in s_best.items():
        if tb is None or tc < floor:
            continue
        if t_best.get(tb, (None, 0.0))[0] == su:
            pairs[(su, tb)] = tc
    return pairs


def discover_embedding_links(
    src_ents: list[dict],
    tgt_ents: list[dict],
    *,
    coarse_of,
    name_threshold: float = EMB_NAME_BB_THRESHOLD,
    namedesc_threshold: float = EMB_NAMEDESC_BB_THRESHOLD,
    cosine_floor: float = EMB_MATCH_COSINE_FLOOR,
    model_min_len: int = EMB_MODEL_MIN_LEN,
    model_trigram_floor: float = EMB_MODEL_TRIGRAM_FLOOR,
) -> list[dict]:
    """The converged Abt-Buy recipe as a reusable matcher.

    Returns ``method='embedding'`` sameAs links between source and target
    entities, combining three high-precision channels (reciprocal best-buddy on
    name embeddings, reciprocal best-buddy on name+desc embeddings, strict
    model-number). Type-blocked like every other stage: only same-coarse-type
    cross-source pairs are admitted, so unioning into the merge cannot introduce
    a cross-type false merge.

    Fail-open: returns [] if Ollama embeddings are unavailable.
    """
    src_ents = [e for e in src_ents if (e.get("name") or "").strip() and e.get("uri")]
    tgt_ents = [e for e in tgt_ents if (e.get("name") or "").strip() and e.get("uri")]
    if not src_ents or not tgt_ents:
        return []

    src_by_uri = {e["uri"]: e for e in src_ents}
    tgt_by_uri = {e["uri"]: e for e in tgt_ents}
    src_uris = list(src_by_uri)
    tgt_uris = list(tgt_by_uri)

    def _name(e):
        return (e.get("name") or "").strip()

    def _namedesc(e):
        nd = _name(e)
        d = (e.get("description") or e.get("label") or "").strip()
        if d:
            nd = f"{nd}. {d}"
        return nd[:_MAX_EMBED_TEXT]

    # Decide whether the name+desc channel is worth an extra embed pass.
    descs = [(e.get("description") or "").strip() for e in (src_ents + tgt_ents)]
    have_desc = sum(1 for d in descs if len(d) >= _MIN_DESC_CHARS)
    use_namedesc = have_desc >= max(2, len(descs) // 10)

    # ── Embed (batched, local Ollama) — name channel, then name+desc ─────────
    name_texts = [_name(e) for e in src_ents + tgt_ents]
    name_vecs = canonical_link.embed_texts(name_texts)
    if name_vecs is None:
        logger.warning(
            "embedding-match: Ollama unavailable — pass skipped (fail-open)"
        )
        return []
    all_ents = src_ents + tgt_ents
    name_emb = {all_ents[i]["uri"]: name_vecs[i] for i in range(len(all_ents))}

    nd_emb = {}
    if use_namedesc:
        nd_texts = [_namedesc(e) for e in all_ents]
        nd_vecs = canonical_link.embed_texts(nd_texts)
        if nd_vecs is not None:
            nd_emb = {all_ents[i]["uri"]: nd_vecs[i] for i in range(len(all_ents))}

    # ── Channel 1+2: reciprocal best-buddy (absolute-cosine-floor gated) ──────
    # cos_of maps each admitted pair → its REAL cosine, used as link confidence.
    pairs_name = _reciprocal_best_buddies(
        src_uris, tgt_uris, name_emb, name_emb, name_threshold, cosine_floor
    )
    pairs_nd: dict = {}
    if nd_emb:
        pairs_nd = _reciprocal_best_buddies(
            src_uris, tgt_uris, nd_emb, nd_emb, namedesc_threshold, cosine_floor
        )

    # ── Channel 3: strict model-number, trigram-confirmed ────────────────────
    src_mod = {u: model_tokens(_name(src_by_uri[u]), model_min_len) for u in src_uris}
    tgt_mod_index: dict[str, list[str]] = {}
    for u in tgt_uris:
        for m in model_tokens(_name(tgt_by_uri[u]), model_min_len):
            tgt_mod_index.setdefault(m, []).append(u)
    pairs_model = set()
    for su in src_uris:
        for m in src_mod[su]:
            for tu in tgt_mod_index.get(m, ()):
                if _trigram_jaccard(
                    _name(src_by_uri[su]), _name(tgt_by_uri[tu])
                ) >= model_trigram_floor:
                    pairs_model.add((su, tu))

    # ── Union, type-block, emit links ────────────────────────────────────────
    # method_of: pair → method; cos_of: pair → real cosine (None for model-number,
    # which is a discrete-token match, not an embedding cosine).
    method_of: dict = {}
    cos_of: dict = {}
    for p, c in pairs_name.items():
        method_of[p] = "embedding-name"
        cos_of[p] = c
    for p, c in pairs_nd.items():
        if p not in method_of:
            method_of[p] = "embedding-desc"
            cos_of[p] = c
    for p in pairs_model:
        method_of.setdefault(p, "embedding-model")

    links: list[dict] = []
    cross_type_dropped = 0
    for (su, tu), method in method_of.items():
        e1, e2 = src_by_uri.get(su), tgt_by_uri.get(tu)
        if not e1 or not e2:
            continue
        # TYPE-BLOCK like every other stage (never collapse distinct coarse types).
        if coarse_of(e1) and coarse_of(e2) and coarse_of(e1) != coarse_of(e2):
            cross_type_dropped += 1
            continue
        # HONEST CONFIDENCE: the real cosine for the embedding channels (no flat
        # 0.9). Model-number is a discrete-token identity match → fixed high conf.
        cos = cos_of.get((su, tu))
        confidence = round(cos, 4) if cos is not None else 0.90
        links.append({
            "source": su,
            "target": tu,
            "confidence": confidence,
            "method": method,
            "source_name": _name(e1),
            "target_name": _name(e2),
        })

    logger.info(
        "embedding-match: name_bb=%d desc_bb=%d model=%d → %d links "
        "(use_namedesc=%s, dropped_cross_type=%d) over %d×%d entities",
        len(pairs_name), len(pairs_nd), len(pairs_model), len(links),
        use_namedesc, cross_type_dropped, len(src_uris), len(tgt_uris),
    )
    return links
