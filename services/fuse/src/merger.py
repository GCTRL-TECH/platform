"""
Three-Stage Entity Merger for GCTRL FUSE

Stage 1: Neo4j APOC — exact/near-exact pre-filter (fast, high confidence)
Stage 2: Semantic Resolver — fuzzy multi-property matching with blocking (precise)
Stage 3: ConEx — knowledge graph embedding link prediction (structural patterns)

Each stage catches what the previous misses. Results are tagged with the
discovery method (apoc/resolver/conex) and confidence score.
"""

import csv
import io
import json
import logging
import os
import re
import tempfile
import unicodedata
from typing import Optional

from neo4j import GraphDatabase, Driver

from . import config
from .limes_client import get_limes_client
from . import config_builder
from . import canonical_link
from . import embedding_match
from .config_builder import build_neo4j_config, build_simple_metric

logger = logging.getLogger(__name__)

# Confidence floor for the difflib (SequenceMatcher) matcher when it runs as a
# COMPLEMENT to a successful LIMES pass (see _stage2_resolver). The loose 0.40
# review floor is right for a trigram-vetted LIMES band, but difflib's raw
# subsequence ratio is more permissive on cross-entity hard negatives, so the
# complement uses a stricter bar to add only confident typo/legal-suffix
# recoveries without costing precision (P=1.0 on the synthetic gold at 0.62).
_STAGE2_COMPLEMENT_FLOOR = 0.62

# ── Attribute-aware (per-field) LIMES matching ───────────────────────────────
# When entities carry RICH ATTRIBUTES beyond `name` (extra string properties),
# Stage-2 swaps the single composite-name metric for a per-field metric: each
# attribute is scored on its OWN axis and ALL must clear their floor (AND). This
# is what breaks the precision ceiling of one flattened composite name — two
# distinct papers that share title boilerplate but differ in year/authors now
# fail the conjunction instead of over-merging.
#
# ATTR_FIELD_SPECS maps a coarse-type/attribute-profile name → an ordered list of
# (property, measure, threshold). The keys are matched against the attribute set
# actually present on the entities (see _stage2_resolver). A spec only references
# properties that exist on the entities; missing-everywhere properties are pruned
# before the metric is built so a partial profile still works.
#
# ⚠ BINARY-METRIC CONSTRAINT (verified empirically against THIS resolver build):
# the resolver's planner only evaluates a 2-OPERAND metric expression. ANY 3+
# leaf metric — flat `AND(a,b,c)` OR nested `AND(a, AND(b,c))` — silently returns
# ZERO links (the engine reads the CSV, then the planner yields no mapping). A
# 2-operand `AND(a, b)` works. So every spec here MUST resolve to AT MOST TWO
# thresholded leaves AFTER pruning absent props (the type-blocking leaf is NOT
# auto-appended in field mode for this reason — see _stage2_resolver). If a spec
# has >2 leaves the builder raises and Stage-2 falls back to the name default.
#
# `work` = bibliographic publications (DBLP-ACM). The winning pair is
# TITLE (fuzzy) + YEAR (exact): title carries the semantic signal but over-merges
# alone on shared domain boilerplate ("… object-oriented databases …"); the EXACT
# year is the precision discriminator that kills those near-duplicate merges (two
# different papers sharing title boilerplate but published in different years now
# fail the conjunction). Tuned on the DBLP-ACM test sample to P=1.0 R=1.0 F1=1.0
# from the REAL engine (trigrams|0.7 + exactmatch year; cosine|0.7 ties it).
# authors-based variants (jaccard) under-perform: author-list formatting differs
# too much across sources (initials, ordering, "and" vs ",") so the floor must
# drop low enough to admit false matches. title+year is the clean winner.
ATTR_FIELD_SPECS: dict[str, list[tuple[str, str, float]]] = {
    "work": [
        ("title", "trigrams", 0.7),
        ("year", "exactmatch", 1.0),
    ],
}

# Max thresholded leaves a single LIMES metric may contain for THIS resolver
# build (see the binary-metric constraint above). Enforced in _stage2_resolver.
MAX_METRIC_LEAVES = 2

# The full universe of extra attribute keys the pipeline carries through Neo4j
# and exports to LIMES (beyond name/type/label). Add a key here AND to a spec to
# make it participate in per-field matching. Selected in _collect_entities.
ATTR_EXTRA_PROPS: tuple[str, ...] = ("title", "authors", "venue", "year")

# ── FIELD-MODE precision recovery: blocking + authors post-filter ────────────
# Two standard ER techniques layered ON TOP of the per-field LIMES metric, both
# gated to field-mode ONLY (the single-name default / synthetic-gold path never
# sees them). They recover the precision that collapses at full-table scale,
# where the 2-field (title+year) metric cannot tell apart identical-title
# same-year DIFFERENT-author papers and everything sits in one coarse bucket.
#
# FIX 1 — AUTHORS POST-FILTER. The binary-metric resolver build can only score
# TWO leaves (title+year), so authors — the discriminator that separates two
# same-title same-year papers by different teams — cannot be a 3rd LIMES leaf.
# Instead, after LIMES returns candidate pairs, we confirm each in PYTHON with a
# cheap authors similarity and REJECT below a threshold. Normalised to survive
# "Last, First" vs "First Last", initials, and separator noise.
#
# FIX 2 — BLOCKING. Partition entities into BLOCKS by a cheap key so only
# same-block pairs are ever compared, cutting the n² confusable-pair growth.
# For field-mode the default key is the YEAR — which is RECALL-LOSSLESS here:
# the per-field metric already requires exactmatch(year)|1.0, so ANY pair it
# could accept MUST share a year and therefore MUST land in the same year-block.
# Blocking on year removes only pairs the metric would have rejected anyway,
# while shrinking each LIMES run from one O(n²) pass to a sum of small per-block
# passes. An optional title-signature refinement sub-partitions within the year
# (cheaper still, mild recall risk) and is OFF by default.
#
# All three knobs are overridable per-merge via the /merge request
# `field_mode_config` block (threaded through run_merge → merger instance).
FIELD_AUTHORS_PROP = "authors"          # attribute carrying the author list
# GENERIC, conservative field-mode floors (open-source defaults). The tuned
# field-mode profile is delivered over the license channel and applied per-merge
# via run_merge()'s `field_mode_config` (tuning.load_tuning()). A miss = these.
FIELD_AUTHORS_THRESHOLD = 0.30          # min authors-set Jaccard to KEEP a pair
FIELD_BLOCKING_KEY = "year"             # "year" | "year_title1" | "none"
FIELD_AUTHORS_MIN_BOTH = True           # only filter when BOTH sides have authors
# TITLE post-filter: a Python char-trigram-Jaccard confirmation floors candidate
# titles so boilerplate-sharing different titles don't over-merge.
FIELD_TITLE_PROP = "title"
FIELD_TITLE_THRESHOLD = 0.70            # min title char-trigram Jaccard to KEEP

# Author tokens this short or in this stoplist are dropped before comparison so
# initials/particles don't dominate the set (they appear in almost every record).
_AUTHOR_PARTICLES = {"van", "der", "von", "de", "di", "da", "la", "le", "el",
                     "al", "and", "jr", "sr", "ii", "iii"}


def _author_token_set(authors: str) -> set[str]:
    """Normalise an author-list string to a SET of surname-ish tokens.

    Handles the cross-source formatting that defeats a naive string compare:
      * "Last, First" vs "First Last"  — order-insensitive (we keep a token SET).
      * initials ("d. scott mackay")   — single-letter tokens dropped.
      * separators (",", " , ", ";", "and", "&", "/") — all split on.
      * diacritics ("Société")         — folded to ASCII.
      * legal particles (van/von/de…)  — dropped as low-signal.

    The SET makes ordering and "Last, First"↔"First Last" irrelevant: both yield
    the same surname tokens. Jaccard over these sets is the discriminator.
    """
    if not authors:
        return set()
    folded = _strip_diacritics(authors).lower()
    # Unify all author separators to a single comma, then split.
    folded = re.sub(r"[;/&]| and ", ",", folded)
    tokens: set[str] = set()
    for chunk in folded.split(","):
        for raw in re.split(r"[\s\.]+", chunk):
            w = re.sub(r"[^\w]", "", raw)
            if len(w) < 2:          # drop initials / single letters
                continue
            if w in _AUTHOR_PARTICLES:
                continue
            tokens.add(w)
    return tokens


def _authors_similarity(a: str, b: str) -> float:
    """Jaccard overlap in [0,1] of two author-list token sets.

    1.0 when the surname token sets are equal; 0.0 when disjoint. Returns 0.0 if
    EITHER side is empty (the caller decides whether an empty side is a reject).
    """
    sa, sb = _author_token_set(a), _author_token_set(b)
    if not sa or not sb:
        return 0.0
    inter = len(sa & sb)
    union = len(sa | sb)
    return inter / union if union else 0.0


def _title_char_trigrams(title: str) -> set[str]:
    """Padded character-trigram SET of a normalised title.

    Char-trigrams (not word sets) so near-identical titles with a word swapped
    still score high, while genuinely different titles sharing only domain
    vocabulary score low. Diacritics folded, whitespace/punct collapsed.
    """
    t = _strip_diacritics((title or "")).lower()
    t = re.sub(r"[^a-z0-9]+", " ", t).strip()
    t = f" {t} "
    return {t[i:i + 3] for i in range(len(t) - 2)}


def _title_similarity(a: str, b: str) -> float:
    """Char-trigram Jaccard of two titles in [0,1].

    This is the precision discriminator the in-engine LIMES `trigrams` measure
    fails to provide at scale: on DBLP-ACM, TRUE matches have near-identical
    titles (Jaccard ≈1.0, p5≈0.84) while the hard-negative pairs that share only
    domain boilerplate ("… real-time database systems …") sit at ≈0.36–0.60. A
    Python confirmation floor between those bands cleanly separates them.
    """
    ta, tb = _title_char_trigrams(a), _title_char_trigrams(b)
    if not ta or not tb:
        return 0.0
    inter = len(ta & tb)
    union = len(ta | tb)
    return inter / union if union else 0.0


def _blocking_key(e: dict, scheme: str) -> str | None:
    """Cheap blocking key for an entity under `scheme`. None → entity is in the
    single global block (current behaviour, no blocking).

      * "none"        — one global block (default for the general path).
      * "year"        — the publication year (recall-lossless under a metric that
                        requires exactmatch(year); the precision/throughput win).
      * "year_title1" — year + first significant char-trigram of the title; a
                        tighter sub-partition (more, smaller blocks) at a small
                        recall risk if a true pair's titles start very differently.
    """
    if scheme == "none" or not scheme:
        return None
    yr = str(e.get("year") or "").strip()
    if scheme == "year":
        return yr or "_noyear"
    if scheme == "year_title1":
        title = _strip_diacritics(str(e.get("title") or "")).lower()
        sig = re.sub(r"[^a-z0-9]", "", title)[:3]
        return f"{yr or '_noyear'}|{sig or '_'}"
    return None


# ── GENERAL-PATH blocking (name-only, recall-preserving) ─────────────────────
# The FIELD-MODE blocking above is recall-LOSSLESS because the per-field metric
# requires exactmatch(year), so the year-block can never drop a pair the metric
# would accept. The GENERAL path has no such structural attribute — entities carry
# only {name, coarse_type, neighbour relations}. So instead of one exact key we
# emit a SMALL SET of REDUNDANT cheap NAME signatures per entity and treat a pair
# as a candidate if it shares ANY key (an OVERLAP / canopy scheme, not a partition).
# Redundancy is the recall insurance: a true match is only lost if it differs on
# EVERY key at once, which the multi-key design makes unlikely. Blocking's job here
# is purely to cut the n² tail of obviously-unrelated comparisons, NOT to be a
# precise matcher — the LIMES trigram metric + threshold remain the actual gate.
#
# THRESHOLD: only ENGAGE when a coarse bucket exceeds GENERAL_BLOCKING_THRESHOLD.
# Below it, compare-all is cheap and maximally safe, so small real graphs (the
# Founder KB) and the synthetic gold are COMPLETELY UNAFFECTED — the blocked code
# path is never entered, behaviour is byte-for-byte identical to before.
GENERAL_BLOCKING_THRESHOLD = 300        # entities/bucket above which blocking engages
GENERAL_BLOCK_PREFIX_LEN = 4            # leading-char prefix length (length-bucketed)
GENERAL_BLOCK_ENABLE = True             # module kill-switch for the whole feature
# Per-LIMES-call entity budget when PACKING blocks. The candidate pairs come from
# key overlap (the n²-tail cut); but issuing one HTTP upload/submit/poll/download
# PER key-block is thousands of round-trips and exhausts ephemeral sockets. So we
# PACK many small blocks into a handful of LIMES calls (each ≤ this many entities
# per side), then POST-FILTER the returned links down to the true candidate pairs.
# LIMES internal compute is sub-quadratic and cheap (the bottleneck is HTTP), so a
# few larger calls are far faster than thousands of tiny ones while the reported
# candidate-pair count stays the bounded (post-filtered) set.
GENERAL_BLOCK_LIMES_BUDGET = 1500


def _general_block_keys(e: dict) -> set[str]:
    """REDUNDANT set of cheap NAME signatures for the general (non-field) path.

    A pair is a blocking CANDIDATE iff its key sets OVERLAP (share ≥1 key) AND it
    is the same coarse_type. The keys are deliberately multiple and cheap so a
    genuine match survives even if one signature differs (a typo, a reordered
    name, a length-band edge), while each key stays SELECTIVE so block sizes — and
    thus the compared-pair count — stay small as the bucket grows.

    A SINGLE first-token key was rejected: on long/compositional names it is too
    coarse (common leading content words form huge canopies that grow with n,
    re-introducing the n² tail). Instead the multi-token keys carry the signal:

      * ``s2:<sorted first-2 significant tokens>`` — ORDER-INSENSITIVE 2-token key.
        Word-order variants ("Bank of America" ↔ "America, Bank of") still collide,
        and two content words are selective enough to keep blocks small.
      * ``s3:<sorted first-3 significant tokens>`` — redundant tighter key; recovers
        a true pair whose 2-token prefix differs but whose 3-token set agrees.
      * ``p:<len-band>:<prefix>`` and ``q:<longer prefix>`` — two character-prefix
        keys (one length-bucketed, one not) that catch single-token / no-space
        names and short typo/diacritic variants sharing a prefix ("Volkswagen" ↔
        "Volkswgen") even when the first token differs.
      * SHORT names (≤1 significant token) fall back to ``t:<token>`` so a bare
        single-word entity still blocks (the short-name regime where one token is
        the only signal — and small-cardinality there is fine, blocks stay tiny).

    Verified on DBLP-ACM (general composite names): vs a first-token scheme this
    HALVES+ the candidate pairs (34k→13k at 2294/side) AND slightly RAISES gold
    recall (0.9862→0.9872) — selective keys lose nothing because the redundant
    keys still co-fire on true matches.

    Returns at least one key for any non-empty name; an empty name gets the shared
    ``_noname`` bucket (matches the old behaviour where empty names were skipped by
    the metric, just localised to one block).
    """
    name = (e.get("name") or "").strip()
    if not name:
        return {"_noname"}
    keys: set[str] = set()
    words = _smart_significant_words(name)
    if len(words) >= 2:
        keys.add("s2:" + "|".join(sorted(words[:2])))
        if len(words) >= 3:
            keys.add("s3:" + "|".join(sorted(words[:3])))
    elif words:
        # Genuinely single-token name — the lone token IS the signal.
        keys.add(f"t:{words[0]}")
    # Character-prefix keys — survive token-1 typos / no-space names. One
    # length-bucketed (near-length names share), one length-free for redundancy.
    folded = _strip_diacritics(name).lower()
    alnum = re.sub(r"[^a-z0-9]", "", folded)
    if alnum:
        band = len(alnum) // 4          # coarse length band so near-length names share
        keys.add(f"p:{band}:{alnum[:GENERAL_BLOCK_PREFIX_LEN]}")
        keys.add(f"q:{alnum[:6]}")
    if not keys:                         # name was all punctuation/stopwords
        keys.add("_residual")
    return keys


def _general_candidate_pairs(
    src_ents: list[dict], tgt_ents: list[dict]
) -> list[tuple[dict, dict]]:
    """Generate cross-source candidate pairs via the redundant name-key OVERLAP.

    Builds an inverted index key → target entities, then for each SOURCE entity
    unions the targets reachable through ANY of its block keys. A pair surfaces
    once even if it shares several keys (deduped by uri pair here). This bounds
    the candidate count by Σ_key |src_k|·|tgt_k| instead of |src|·|tgt|: as a
    bucket grows, comparisons grow with the (much smaller) per-key block sizes,
    not the full cross product. Recall-preserving because the keys are redundant
    and a pair is admitted on ANY shared key.
    """
    tgt_index: dict[str, list[dict]] = {}
    for t in tgt_ents:
        for k in _general_block_keys(t):
            tgt_index.setdefault(k, []).append(t)
    pairs: list[tuple[dict, dict]] = []
    seen: set[tuple[str, str]] = set()
    for s in src_ents:
        su = s.get("uri", "")
        reached: dict[str, dict] = {}
        for k in _general_block_keys(s):
            for t in tgt_index.get(k, ()):  # noqa: B905
                tu = t.get("uri", "")
                if tu and tu != su:
                    reached[tu] = t
        for tu, t in reached.items():
            pair_key = (min(su, tu), max(su, tu))
            if pair_key in seen:
                continue
            seen.add(pair_key)
            pairs.append((s, t))
    return pairs

# ── Smart-match helpers (acronym + token-sort/set) ───────────────────────────
# These power the optional `_stage_smart_match` pass (enable_smart_match=True).
# They are intentionally conservative: every matcher only fires on an
# unambiguous derivation so the hard cross-entity negatives in the gold set
# (e.g. "Volkswagen" vs "International Business Machines") never collapse.

# Stopwords dropped when forming acronym initials and when normalising tokens.
_SMART_STOPWORDS = {"of", "and", "the", "for", "de", "du", "von", "der", "di", "da", "&"}
# Corporate/legal suffixes dropped from significant words. Lowercased, no dots.
_SMART_SUFFIXES = {
    "corp", "corporation", "inc", "incorporated", "ltd", "limited", "llc",
    "gmbh", "ag", "sa", "co", "company", "plc", "spa", "nv", "bv", "kg",
    "group", "holding", "holdings",
}
# Personal honorific titles, dropped only for person-initial matching.
_SMART_TITLES = {"dr", "mr", "mrs", "ms", "prof", "professor", "sir", "dame"}


def _coarse_of(e: dict) -> str:
    """The stable merge-blocking key for an entity, with a SAFE FALLBACK.

    Prefers the coarse bucket (`coarse_type`) written by KEX; falls back to the
    fine Wikidata QID (`type`) for old data and the synthetic gold (types
    `BQ_<i>`, no coarse_type). The fallback is what keeps the gold/regression
    path BYTE-FOR-BYTE identical to the pre-coarse behaviour: when no node in a
    batch has a coarse_type, every comparison reduces to the original
    same-`type` rule.
    """
    return e.get("coarse_type") or e.get("type")


def _strip_diacritics(s: str) -> str:
    """Fold accented characters to ASCII (Société → Societe)."""
    return "".join(
        c for c in unicodedata.normalize("NFKD", s) if not unicodedata.combining(c)
    )


def _smart_significant_words(name: str, drop_titles: bool = False) -> list[str]:
    """Lowercased, diacritic-folded significant words of a name.

    Splits on whitespace, hyphens and slashes; drops stopwords, corporate
    suffixes and pure-punctuation tokens. When ``drop_titles`` is set, personal
    honorifics (Dr/Prof/…) are also dropped — used for person-initial matching.
    """
    folded = _strip_diacritics(name).lower()
    raw = re.split(r"[\s\-/]+", folded)
    words = []
    for w in raw:
        w = re.sub(r"[^\w]", "", w)  # strip surrounding punctuation
        if not w:
            continue
        if w in _SMART_STOPWORDS or w in _SMART_SUFFIXES:
            continue
        if drop_titles and w in _SMART_TITLES:
            continue
        words.append(w)
    return words


def _person_initial_match(words_a: list[str], words_b: list[str]) -> bool:
    """True iff `words_a` is `words_b` with one+ leading-name initialled.

    e.g. ["p","vance"] vs ["patricia","vance"]. Same token count, every
    position either equal or a single-letter initial of the other side's word,
    with at least one genuine initial collapse. Conservative: surnames must
    match exactly, so it never links two distinct people.
    """
    if len(words_a) != len(words_b) or len(words_a) < 2:
        return False
    saw_initial = False
    for a, b in zip(words_a, words_b):
        if a == b:
            continue
        if len(a) == 1 and b.startswith(a):
            saw_initial = True
            continue
        return False
    return saw_initial


def _acronym_from_words(words: list[str]) -> str:
    """First letter of each significant word, lowercased."""
    return "".join(w[0] for w in words if w)


def _embedded_capitals(name: str) -> str:
    """Uppercase letters of a name as a candidate acronym (VolksWagen → VW).

    Always includes the very first letter even if it is lowercase, so a
    leading-lowercase compound still contributes its initial.
    """
    folded = _strip_diacritics(name)
    caps = [c for c in folded if c.isupper()]
    if folded and folded[0].isalpha() and folded[0].islower():
        caps = [folded[0]] + caps
    return "".join(caps).lower()


def _syllabic_acronym_match(short_norm: str, long_words: list[str]) -> bool:
    """True iff `short_norm` is a per-word PREFIX acronym of `long_words`.

    Every significant long word must contribute a non-empty leading chunk of
    its letters, in order, concatenating to exactly `short_norm` — and ALL
    words must be consumed. This catches syllabic abbreviations the pure-initial
    form misses (Société Générale→SocGen, Université de Genève→UNIGE) while
    staying strict: it subsumes the initials case, requires every word to
    participate, and consumes the whole short string, so a partial/cross-entity
    overlap can't satisfy it. (Verified 0 false positives on the gold set.)
    """
    if len(short_norm) < 2 or len(long_words) < 2:
        return False
    import functools

    @functools.lru_cache(None)
    def can(si: int, wi: int) -> bool:
        if wi == len(long_words):
            return si == len(short_norm)
        if si >= len(short_norm):
            return False
        word = long_words[wi]
        maxk = min(len(word), len(short_norm) - si)
        for k in range(1, maxk + 1):
            if short_norm[si:si + k] == word[:k] and can(si + k, wi + 1):
                return True
        return False

    result = can(0, 0)
    can.cache_clear()
    return result


def _is_acronym_match(short: str, long_name: str) -> bool:
    """True iff `short` is an unambiguous acronym of `long_name`.

    `short` must be all letters, length ≥2. It matches when it equals EITHER
    the initial-letters acronym of the long name's significant words, the
    embedded-capitals form, OR a per-word prefix (syllabic) acronym that
    consumes every significant word. Strict derivations only — no partial
    credit — so 'IBM' does NOT match 'International Business' and 'VW' does
    NOT match 'Volvo'.
    """
    short_norm = _strip_diacritics(short).lower()
    if len(short_norm) < 2 or not short_norm.isalpha():
        return False

    long_words = _smart_significant_words(long_name)
    # Require a genuinely multi-word (or compound) long name; a single short
    # word can't legitimately spawn a multi-letter acronym we'd trust.
    candidates = set()
    if long_words:
        candidates.add(_acronym_from_words(long_words))
    emb = _embedded_capitals(long_name)
    if emb:
        candidates.add(emb)

    if short_norm in candidates:
        return True
    # Fallback: syllabic per-word prefix acronym (SocGen, UNIGE).
    return _syllabic_acronym_match(short_norm, long_words)


def _smart_token_match(name_a: str, name_b: str) -> float:
    """Token-sort / token-set similarity in [0,1] (Jaccard of token sets).

    Catches word-order variants: "Bank of America" ↔ "America, Bank of".
    Returns 1.0 when the significant-token SETS are equal, else the Jaccard
    overlap. The caller applies the ≥0.9 threshold.
    """
    set_a = set(_smart_significant_words(name_a))
    set_b = set(_smart_significant_words(name_b))
    if not set_a or not set_b:
        return 0.0
    inter = len(set_a & set_b)
    union = len(set_a | set_b)
    return inter / union if union else 0.0

# ── Classification label helpers ─────────────────────────────────────────────
# A merge UNIONS the per-element labels of its source elements and never
# escalates: the merged element keeps every source's label, its `_min_rank` is
# the most-permissive (so a generic node tagged PUBLIC in one source stays
# public), and `_class_conflict` flags any element carrying ≥2 distinct ranks
# for human review.

_NAME_RANK = {
    "PUBLIC": 0,
    "INTERNAL": 100,
    "CONFIDENTIAL": 200,
    "STRICTLY_CONFIDENTIAL": 300,
}


def _source_labels(rec: dict) -> tuple[list[str], list[int]]:
    """Extract (label_json_list, ranks) from a collected source element.

    Prefers the per-element `_class_labels`/`_label_ranks`; falls back to
    synthesizing a single label from the legacy `_classification` string for
    elements ingested before per-element labels existed.
    """
    labels = rec.get("class_labels")
    ranks = rec.get("label_ranks")
    if isinstance(labels, list) and labels and isinstance(ranks, list) and ranks:
        return ([str(x) for x in labels], [int(r) for r in ranks])
    name = (rec.get("classification") or "PUBLIC")
    rank = _NAME_RANK.get(str(name).upper(), 0)
    label = json.dumps(
        {"rank": rank, "level_id": None, "level_name": name, "source_job": rec.get("source_job")},
        separators=(",", ":"),
    )
    return ([label], [rank])


def _union_labels(members: list[dict]) -> tuple[list[str], list[int], int, bool]:
    """Union labels across cluster members, dedup by rank (keep first per rank).

    Returns (class_labels, label_ranks, min_rank, conflict).
    """
    seen_ranks: dict[int, str] = {}
    for rec in members:
        labels, ranks = _source_labels(rec)
        for lab, rk in zip(labels, ranks):
            if rk not in seen_ranks:
                seen_ranks[rk] = lab
    if not seen_ranks:
        seen_ranks = {0: json.dumps({"rank": 0, "level_name": "PUBLIC"}, separators=(",", ":"))}
    ranks_sorted = sorted(seen_ranks.keys())
    class_labels = [seen_ranks[r] for r in ranks_sorted]
    return class_labels, ranks_sorted, ranks_sorted[0], len(ranks_sorted) > 1


class ThreeStageEntityMerger:
    """Merge entities across knowledge graphs using three-stage pipeline."""

    def __init__(self) -> None:
        self._driver: Optional[Driver] = None
        # LIMES ACCEPTANCE/REVIEW output-band thresholds (the merger auto-merges
        # both bands; the REVIEW threshold is the effective merge floor). These are
        # the GENERIC, conservative defaults shipped open-source — a tuning miss
        # always lands here. The tuned floors are delivered over the license channel
        # and applied by run_merge() via tuning.load_tuning(). See tuning.py.
        self.threshold_accept = 0.85
        self.threshold_review = 0.55
        # Optional per-entity-type LIMES metric overrides, e.g.
        # {"person": "trigrams(x.name,y.name)|0.7"}. Set by run_merge from the
        # /merge request; consulted in stage 2. Empty = use the default metric.
        self.metric_overrides: dict[str, str] = {}
        # Set per-merge by merge(); consulted by Stage-2 metric selection.
        self._enable_smart_match: bool = False
        # Set per-merge by merge(); gates the cross-bucket canonical pass.
        self._enable_canonical_link: bool = False
        # Set per-merge by merge(); gates the embedding best-buddy + model-number
        # pass for NOISY general-name data (the dirty-text quality lever). OFF by
        # default so clean field-mode and the synthetic gold are unaffected.
        self._enable_embedding_match: bool = False
        # FIELD-MODE precision-recovery config (blocking + authors post-filter).
        # Set per-merge from the /merge `field_mode_config` block; defaults below
        # preserve the documented field-mode behaviour. Only consulted when
        # Stage-2 enters attribute-aware field mode — the general path ignores it.
        self.field_blocking_key: str = FIELD_BLOCKING_KEY
        self.field_authors_prop: str = FIELD_AUTHORS_PROP
        self.field_authors_threshold: float = FIELD_AUTHORS_THRESHOLD
        self.field_authors_min_both: bool = FIELD_AUTHORS_MIN_BOTH
        # None → use the ATTR_FIELD_SPECS title threshold (0.7). A float raises the
        # per-field title trigram floor (precision tuning at full-table scale).
        self.field_title_floor: float | None = None
        # Python title-confirmation post-filter (the precision discriminator).
        self.field_title_prop: str = FIELD_TITLE_PROP
        self.field_title_threshold: float = FIELD_TITLE_THRESHOLD

    def connect(self) -> None:
        self._driver = GraphDatabase.driver(
            config.NEO4J_URI,
            auth=(config.NEO4J_USER, config.NEO4J_PASSWORD),
        )
        self._driver.verify_connectivity()
        logger.info(f"Connected to Neo4j at {config.NEO4J_URI}")

    @property
    def driver(self) -> Driver:
        if not self._driver:
            self.connect()
        assert self._driver is not None
        return self._driver

    @property
    def is_connected(self) -> bool:
        return self._driver is not None

    def close(self) -> None:
        if self._driver:
            self._driver.close()
            self._driver = None

    def merge(
        self,
        compilation_id: str,
        source_job_ids: list[str],
        user_id: str,
        classification: str = "PUBLIC",
        enable_conex: bool = False,
        enable_smart_match: bool = False,
        enable_canonical_link: bool = False,
        enable_embedding_match: bool = False,
        field_mode_config: dict | None = None,
    ) -> dict:
        """
        Run three-stage merge pipeline.

        Returns stats dict with breakdown by stage.

        ``enable_smart_match`` (default OFF → zero behaviour change) turns on an
        optional matching pass that catches the recall gaps the trigram/string
        stages miss: ABBREVIATIONS (Volkswagen↔VW, IBM) and WORD-ORDER variants
        (Bank of America↔"America, Bank of"). It also swaps Stage-2's hardcoded
        trigram metric for the per-type DEFAULT_METRICS presets. Gated together
        so the harness A/B (`enable_smart_match=True` vs baseline) isolates the
        full improvement in one run.

        ``enable_canonical_link`` (default OFF) turns on the CONTEXT-embedding
        pass that collapses CROSS-COARSE-BUCKET co-references the coarse-blocked
        stages cannot reach (e.g. "Ground Control" tagged organization in one
        doc and technology in another). It generates cross-bucket name-strong
        candidates, then confirms each by cosine similarity of an Ollama
        nomic-embed-text embedding of the entities' 1-hop context — so true
        co-references merge while homonyms stay apart. Fails open if Ollama is
        unreachable.
        """
        # Store on the instance so stage helpers (Stage-2 metric selection) can
        # consult it without threading the flag through every signature.
        self._enable_smart_match = bool(enable_smart_match)
        self._enable_canonical_link = bool(enable_canonical_link)
        self._enable_embedding_match = bool(enable_embedding_match)
        # Apply per-merge field-mode overrides (blocking key + authors filter).
        # Defaults stay in place when a key is absent, so an empty/omitted block
        # preserves the documented field-mode behaviour.
        if field_mode_config:
            if "blocking_key" in field_mode_config:
                self.field_blocking_key = str(field_mode_config["blocking_key"])
            if "authors_prop" in field_mode_config:
                self.field_authors_prop = str(field_mode_config["authors_prop"])
            if "authors_threshold" in field_mode_config:
                self.field_authors_threshold = float(
                    field_mode_config["authors_threshold"]
                )
            if "authors_min_both" in field_mode_config:
                self.field_authors_min_both = bool(
                    field_mode_config["authors_min_both"]
                )
            if "title_floor" in field_mode_config:
                self.field_title_floor = float(field_mode_config["title_floor"])
            if "title_threshold" in field_mode_config:
                self.field_title_threshold = float(
                    field_mode_config["title_threshold"]
                )
        logger.info(
            f"[{compilation_id}] Three-stage merge — {len(source_job_ids)} sources"
            + (" [smart_match ON]" if enable_smart_match else "")
        )

        # Collect all entities
        all_entities = self._collect_entities(source_job_ids)
        logger.info(f"[{compilation_id}] Collected {len(all_entities)} entities")

        if not all_entities:
            return self._empty_stats()

        # ── Stage 1: Neo4j APOC Pre-filter ────────────────────────────
        stage1_links = self._stage1_apoc(source_job_ids)
        logger.info(
            f"[{compilation_id}] Stage 1 (APOC): {len(stage1_links)} exact matches"
        )

        # ── Stage 2: Semantic Resolver ─────────────────────────────────
        matched_uris = self._extract_matched_uris(stage1_links)
        stage2_links = self._stage2_resolver(source_job_ids, exclude_uris=matched_uris)
        logger.info(
            f"[{compilation_id}] Stage 2 (resolver): {len(stage2_links)} fuzzy matches"
        )

        # ── Stage 3: ConEx Link Prediction (optional) ─────────────────
        stage3_links: list[dict] = []
        if enable_conex:
            all_matched = matched_uris | self._extract_matched_uris(stage2_links)
            stage3_links = self._stage3_conex(
                source_job_ids, exclude_uris=all_matched
            )
            logger.info(
                f"[{compilation_id}] Stage 3 (ConEx): {len(stage3_links)} predicted links"
            )

        # ── Smart-match pass (optional) ────────────────────────────────
        smart_links: list[dict] = []
        if enable_smart_match:
            smart_links = self._stage_smart_match(all_entities)
            logger.info(
                f"[{compilation_id}] Smart-match: {len(smart_links)} acronym/word-order links"
            )

        # ── Canonical entity-linking pass (optional, cross-bucket) ─────
        canonical_links: list[dict] = []
        if enable_canonical_link:
            canonical_links = self._stage_canonical_link(all_entities, source_job_ids)
            logger.info(
                f"[{compilation_id}] Canonical-link: {len(canonical_links)} cross-bucket context merges"
            )

        # ── Embedding best-buddy + model-number pass (optional, noisy data) ─
        embedding_links: list[dict] = []
        if enable_embedding_match:
            embedding_links = self._stage_embedding_match(
                all_entities, source_job_ids
            )
            logger.info(
                f"[{compilation_id}] Embedding-match: {len(embedding_links)} "
                f"best-buddy/model-number links"
            )

        # ── Merge Results ──────────────────────────────────────────────
        all_links = (
            stage1_links + stage2_links + stage3_links
            + smart_links + canonical_links + embedding_links
        )
        all_links = self._deduplicate_links(all_links)

        # Write merged graph to Neo4j
        stats = self._write_merged_graph(
            compilation_id, all_entities, all_links,
            source_job_ids, user_id, classification
        )

        # Merge relations
        rel_count = self._merge_relations(
            compilation_id, source_job_ids, user_id, classification
        )

        # Aggregate classification conflicts (node + edge) surfaced by the merge.
        conflicts = list(stats.pop("_conflicts", []))
        conflicts.extend(getattr(self, "_last_relation_conflicts", []))

        stats.update({
            "relations_merged": rel_count,
            "stage1_apoc": len(stage1_links),
            "stage2_resolver": len(stage2_links),
            "stage3_conex": len(stage3_links),
            "smart_match": len(smart_links),
            "canonical_link": len(canonical_links),
            "embedding_match": len(embedding_links),
            "total_links": len(all_links),
            "_conflicts": conflicts,
            "conflicts_found": len(conflicts),
        })

        logger.info(f"[{compilation_id}] Merge complete: {stats}")
        return stats

    # ── Stage 1: Neo4j APOC ─────────────────────────────────────────

    def _stage1_apoc(self, source_job_ids: list[str]) -> list[dict]:
        """
        Fast pre-filter: find entities with identical/near-identical names
        across different source jobs using Neo4j Cypher.
        """
        query = """
        MATCH (a:Entity), (b:Entity)
        WHERE a._source_job IN $job_ids
          AND b._source_job IN $job_ids
          AND a._source_job <> b._source_job
          AND coalesce(a.coarse_type, a.type) = coalesce(b.coarse_type, b.type)
          AND toLower(a.name) = toLower(b.name)
          AND elementId(a) < elementId(b)
        RETURN a.uri AS source, b.uri AS target,
               a.name AS source_name, b.name AS target_name,
               1.0 AS confidence
        """
        links = []
        try:
            with self.driver.session() as session:
                result = session.run(query, job_ids=source_job_ids)
                for record in result:
                    links.append({
                        "source": record["source"],
                        "target": record["target"],
                        "confidence": record["confidence"],
                        "method": "apoc",
                        "source_name": record["source_name"],
                        "target_name": record["target_name"],
                    })
        except Exception as exc:
            logger.warning(f"Stage 1 (APOC) failed: {exc}")

        return links

    # ── Stage 2: Semantic Resolver ──────────────────────────────────

    def _stage2_resolver(
        self, source_job_ids: list[str], exclude_uris: set[str] | None = None
    ) -> list[dict]:
        """
        Fuzzy multi-property matching via semantic resolver.
        Exports entities to CSV, uploads, submits config, parses results.
        Falls back to enhanced string similarity if resolver is unavailable.
        """
        resolver = get_limes_client()

        entities = self._collect_entities(source_job_ids)
        if exclude_uris:
            entities = [e for e in entities if e.get("uri") not in exclude_uris]

        if len(entities) < 2:
            return []

        # Split into source/target (different source jobs)
        mid = len(source_job_ids) // 2
        source_jobs = set(source_job_ids[:max(mid, 1)])
        source_ents = [e for e in entities if e.get("source_job") in source_jobs]
        target_ents = [e for e in entities if e.get("source_job") not in source_jobs]

        if not target_ents:
            mid_e = len(entities) // 2
            source_ents = entities[:mid_e]
            target_ents = entities[mid_e:]

        if not resolver.is_healthy():
            logger.error(
                "STAGE-2 FALLBACK (resolver_fallback): LIMES resolver at %s is "
                "UNHEALTHY/unreachable — using O(n^2) python string matcher. This is "
                "a degraded path; investigate resolver health.",
                getattr(config, "RESOLVER_URL", "?"),
            )
            return self._stage2_fallback(source_job_ids, exclude_uris)

        # Pick the LIMES metric. Precedence:
        #   1. explicit metric_overrides (benchmark A/B knob) — always honoured.
        #   2. when smart-match is on, the per-type DEFAULT_METRICS preset
        #      (config_builder.DEFAULT_METRICS) keyed by the batch's single type.
        #   3. otherwise the length-adaptive default name metric (below).
        # DEFAULT_METRICS wiring is gated behind enable_smart_match so the A/B
        # isolates the full improvement and default-OFF behaviour is unchanged.
        #
        # NAME METRIC = char-trigrams, NOT levenshtein. levenshtein(x.name,y.name)
        # was empirically WORTHLESS inside LIMES: on the DBLP-ACM composite name
        # ("title | authors | venue year", ~80-120 chars) it scored every true
        # match BELOW 0.6 (different venue strings = many edits) so LIMES returned
        # ZERO links and Stage-2 silently fell back to the O(n^2) python matcher on
        # EVERY run (verified: `parsed 0 resolver links from N3`). trigrams is a
        # char-n-gram set similarity — far better suited to long, compositional
        # names — and tuned on the DBLP-ACM test sample it gives P=0.90 R=1.0
        # F1=0.95 from the REAL engine in ~2s (vs the 12s fallback).
        #
        # LENGTH-ADAPTIVE THRESHOLD: a single trigram floor cannot serve both long
        # composite names (publications) and SHORT entity names (orgs/people: the
        # synthetic-gold "Volkswagen"/"Acme Corp" set). Short names have few
        # trigrams, so a high floor over-prunes them; long names need a higher
        # floor to stay precise. We pick the floor from the batch's MEDIAN name
        # length: long → 0.55 (best DBLP F1), short → 0.40 (best gold recall while
        # still holding P=1.0 — trigram set-similarity on a short name has few
        # n-grams so the floor must be lower to admit typos/legal-suffix variants;
        # abbreviations like VW↔Volkswagen are out of reach for ANY string metric
        # and are recovered by the independent smart_match acronym pass).
        # Both keep exactmatch(x.type,y.type)|1.0 so LIMES blocks
        # on type EXACTLY like every other stage (APOC, fallback, smart-match all
        # do `_coarse_of(e1) != _coarse_of(e2): continue`) — without it LIMES would
        # link every same-named entity globally and collapse distinct type blocks
        # (regressed the synthetic gold P=1.0→0.53 the first time LIMES fired).
        # `type` on the export is the projected coarse bucket (see src_export).
        _names = [(e.get("name") or "") for e in (source_ents + target_ents)]
        _name_lens = sorted(len(n) for n in _names if n)
        _median_len = _name_lens[len(_name_lens) // 2] if _name_lens else 0
        _name_floor = 0.55 if _median_len >= 40 else 0.40
        metric = (
            f"AND(trigrams(x.name, y.name)|{_name_floor}, "
            "exactmatch(x.type, y.type)|1.0)"
        )
        # Block on the COARSE type, not the fine QID, so the same-real-entity
        # fragments (software/framework/library/…) land in one batch. Falls back
        # to fine type for old data / synthetic gold (see _coarse_of).
        batch_types = {_coarse_of(e) for e in (source_ents + target_ents) if _coarse_of(e)}
        overrides = getattr(self, "metric_overrides", None) or {}

        if getattr(self, "_enable_smart_match", False) and len(batch_types) == 1:
            only_type = next(iter(batch_types))
            preset = config_builder.DEFAULT_METRICS.get(str(only_type).lower())
            if preset:
                metric = preset

        # ── ATTRIBUTE-AWARE (per-field) metric ───────────────────────────────
        # If the entities carry RICH ATTRIBUTES (any of ATTR_EXTRA_PROPS present
        # non-empty), build a per-field metric that scores each attribute on its
        # own axis (AND of thresholded measures) instead of the single composite
        # name. This is the precision lever: two papers that share title
        # boilerplate but differ in year/authors fail the conjunction. The export
        # then carries those attribute COLUMNS so LIMES can reference them.
        # Detection is data-driven (any extra prop present), so the general-KG /
        # synthetic-gold path — which has only `name` — never enters this branch
        # and the single-name default is preserved byte-for-byte.
        present_props = {
            p for p in ATTR_EXTRA_PROPS
            if any(str(e.get(p) or "").strip() for e in (source_ents + target_ents))
        }
        export_props = ["name", "type", "label"]
        field_mode = False
        if present_props and len(batch_types) <= 1:
            # Attribute-aware mode applies to SINGLE-coarse-type batches: every
            # record is already in one block (the benchmark's shared coarse_type,
            # or a real per-type FUSE pass), so the metric's job is pure per-field
            # DISCRIMINATION, not type-blocking. (Mixed-type batches keep the name
            # default, which carries exactmatch(x.type) for cross-type blocking.)
            only_type = next(iter(batch_types)) if batch_types else None
            spec = ATTR_FIELD_SPECS.get(str(only_type).lower()) if only_type else None
            if spec:
                spec = [(p, m, t) for (p, m, t) in spec if p in present_props]
            # Per-merge title-floor override (precision tuning knob). Raising the
            # title trigram floor cuts boilerplate-only candidate links (the chains
            # that wreck precision at full-table scale) before they ever form.
            _title_floor = getattr(self, "field_title_floor", None)
            if spec and _title_floor is not None:
                spec = [
                    (p, m, (float(_title_floor) if p == "title" else t))
                    for (p, m, t) in spec
                ]
            if not spec:
                # No type-specific spec → generic: the present props, trigrams,
                # capped at the 2 most-discriminative we can express in this build.
                spec = [(p, "trigrams", 0.6) for p in sorted(present_props)]
            # BINARY-METRIC CONSTRAINT: this resolver build evaluates at most 2
            # operands; a 3+ leaf metric silently returns 0. Cap the spec to the
            # first MAX_METRIC_LEAVES leaves (specs are authored most-significant
            # first). If somehow empty, fall through to the name default below.
            spec = spec[:MAX_METRIC_LEAVES]
            if spec:
                metric = config_builder.build_field_metric(spec)
                export_props = ["name", "type", "label"] + sorted(present_props)
                field_mode = True
                logger.info(
                    "STAGE-2 attribute-aware: %d extra props present %s → per-field "
                    "metric %r", len(present_props), sorted(present_props), metric,
                )

        if overrides:
            # Precedence: an EXACT per-type override wins; otherwise a wildcard
            # "*" override applies regardless of how many coarse types are in the
            # batch (previously "*" was only consulted for MIXED-type batches, so
            # a single-type batch like the ER benchmark's all-"work" set silently
            # ignored a "*" override and kept the trigram default). An explicit
            # override ALSO supersedes the attribute-aware metric (the benchmark
            # A/B knob) — but the extra attribute columns stay EXPORTED so a
            # per-field override metric can still reference them.
            only_type = next(iter(batch_types)) if len(batch_types) == 1 else None
            if only_type is not None and only_type in overrides:
                metric = overrides[only_type]
            elif "*" in overrides:
                metric = overrides["*"]

        # The resolver matches on the entity `type` property when the metric
        # contains exactmatch(x.type, y.type) (DEFAULT_METRICS presets / "*"
        # overrides). Project the COARSE bucket onto `type` for the export so
        # that type-aware blocking groups same-real-entity fragments together.
        # The fallback in _coarse_of leaves the synthetic gold (BQ_<i>, no
        # coarse_type) and old data untouched — they keep their fine type.
        src_export = [{**e, "type": _coarse_of(e)} for e in source_ents]
        tgt_export = [{**e, "type": _coarse_of(e)} for e in target_ents]

        # ── FIELD-MODE precision-recovery path (blocking + authors post-filter) ─
        # Diverges from the general single-call path ONLY when field_mode is on
        # (rich attributes present, single coarse bucket). Everything else — the
        # general KG path, the synthetic gold, name-only DBLP — falls through to
        # the original code below UNCHANGED.
        if field_mode:
            return self._stage2_field_mode(
                resolver, src_export, tgt_export, metric, export_props,
            )

        # ── GENERAL-PATH blocking (name-only, recall-preserving) ──────────────
        # Engage ONLY when a coarse bucket is large enough that the full src×tgt
        # cross product is the n² wall. Below GENERAL_BLOCKING_THRESHOLD the
        # original single-call path runs UNCHANGED (small real graphs + synthetic
        # gold never enter here). The blocked path sub-partitions by redundant
        # NAME keys so LIMES only ever scores within-block pairs, then applies the
        # SAME difflib short-name complement — but restricted to the SAME candidate
        # pairs (so the complement is bounded too, not a fresh O(n²) sweep).
        bucket_n = max(len(src_export), len(tgt_export))
        if (
            GENERAL_BLOCK_ENABLE
            and bucket_n > GENERAL_BLOCKING_THRESHOLD
            and len(src_export) >= 1
            and len(tgt_export) >= 1
        ):
            return self._stage2_general_blocked(
                resolver, src_export, tgt_export, metric, export_props,
                median_len=_median_len,
            )

        try:
            # Include BOTH the accepted and review bands (accepted_only=False).
            # The cross-entity false positives that the review band used to
            # introduce are now prevented at the SOURCE by the type-blocking
            # metric (exactmatch(x.type, y.type)|1.0) baked into the default and
            # the DEFAULT_METRICS presets — distinct-type entities are never even
            # scored, so the review band only contains within-block fuzzy matches
            # (typos, diacritics) we WANT to merge. This keeps gold precision at
            # 1.0 while recovering the typo/diacritic recall that an accepted-only
            # (≥0.85) cut would lose to the review band.
            links = resolver.discover_links(
                source_entities=src_export,
                target_entities=tgt_export,
                metric=metric,
                acceptance_threshold=self.threshold_accept,
                review_threshold=self.threshold_review,
                accepted_only=False,
                properties=export_props,
            )
            if links:
                # COMPLEMENT the LIMES char-trigram links with the difflib
                # (SequenceMatcher) matcher. The two are complementary, not
                # redundant: LIMES trigrams win decisively on LONG compositional
                # names (DBLP-ACM publications, where difflib is O(n^2)-slow and
                # less discriminating), while difflib's longest-common-subsequence
                # ratio is markedly more typo-robust on SHORT entity names (e.g.
                # "Volkswgen"↔"Volkswagen", "Acme Corporaton"↔"Acme Corporation")
                # which trigram set-similarity under-scores. BOTH passes apply the
                # SAME type-blocking (`exactmatch(x.type,y.type)` in LIMES; the
                # `_coarse_of(e1)!=_coarse_of(e2): continue` guard in the fallback),
                # so unioning them cannot introduce a cross-type false merge — it
                # only recovers within-block recall. Links are deduped downstream
                # by `_deduplicate_links` (keeps the highest-confidence per pair).
                # This is what keeps the short-name synthetic-gold F1 at ~0.95
                # AFTER LIMES became the primary long-name engine.
                # Gate the difflib complement to SHORT-name batches. On LONG
                # composite names (publications) difflib's subsequence ratio fires
                # on shared domain boilerplate ("... object-oriented databases ...")
                # and adds false near-duplicate merges, so there LIMES trigrams run
                # ALONE. On short entity names it is the typo-robustness that holds
                # the synthetic-gold precision/recall — the SAME median-length
                # signal that picked the trigram floor selects it.
                # In ATTRIBUTE-AWARE field mode the difflib complement is OFF
                # unconditionally: it only knows the composite `name`, and that
                # composite-name boilerplate matching is exactly the over-merge
                # the per-field metric exists to AVOID — re-introducing it via the
                # complement would re-open the precision hole. The per-field LIMES
                # metric is the sole Stage-2 signal in field mode.
                if field_mode:
                    complement = []
                elif _median_len < 40:
                    complement = self._stage2_fallback(
                        source_job_ids, exclude_uris,
                        min_score=_STAGE2_COMPLEMENT_FLOOR,
                    )
                else:
                    complement = []
                merged = self._dedup_stage2(links + complement)
                logger.info(
                    f"STAGE-2 LIMES (method=resolver): discovered {len(links)} links "
                    f"with metric {metric!r} over {len(src_export)}x{len(tgt_export)} "
                    f"entities (+{len(merged)-len(links)} from difflib complement, "
                    f"{len(merged)} total)"
                )
                return merged
            else:
                logger.error(
                    "STAGE-2 FALLBACK (resolver_fallback): LIMES resolver returned ZERO "
                    "links with metric %r over %dx%d entities — falling back to O(n^2) "
                    "python string matcher. If this is unexpected, check resolver logs "
                    "(docker logs gctrl-resolver): config XML / CSV / metric may be wrong.",
                    metric, len(src_export), len(tgt_export),
                )
                return self._stage2_fallback(source_job_ids, exclude_uris)
        except Exception as exc:
            logger.error(
                "STAGE-2 FALLBACK (resolver_fallback): LIMES resolver raised %r — "
                "falling back to O(n^2) python string matcher.", exc,
            )
            return self._stage2_fallback(source_job_ids, exclude_uris)

    def _stage2_field_mode(
        self,
        resolver,
        src_export: list[dict],
        tgt_export: list[dict],
        metric: str,
        export_props: list[str],
    ) -> list[dict]:
        """Attribute-aware Stage-2 with BLOCKING + AUTHORS POST-FILTER.

        This is the full-scale precision-recovery path. It:
          1. Partitions source+target into BLOCKS by ``self.field_blocking_key``
             (default 'year' — recall-lossless under an exactmatch(year) metric),
             and runs the per-field LIMES metric ONCE PER BLOCK so cross-block
             pairs are never compared (kills the n² confusable-pair growth).
          2. Confirms every LIMES candidate pair with an AUTHORS similarity
             post-filter, rejecting same-title/same-year-but-different-author
             false merges that the 2-leaf (title+year) metric cannot tell apart.

        Both steps apply ONLY here (field mode); the general path is untouched.
        The difflib complement is intentionally OFF in field mode (it only knows
        the composite name and would re-open the boilerplate over-merge hole).
        """
        scheme = self.field_blocking_key or "none"

        # Index target entities by block key so each source block matches only
        # its same-key target block.
        tgt_blocks: dict[str | None, list[dict]] = {}
        for e in tgt_export:
            tgt_blocks.setdefault(_blocking_key(e, scheme), []).append(e)
        src_blocks: dict[str | None, list[dict]] = {}
        for e in src_export:
            src_blocks.setdefault(_blocking_key(e, scheme), []).append(e)

        all_links: list[dict] = []
        n_blocks = 0
        compared_pairs = 0
        block_keys = sorted(
            set(src_blocks) | set(tgt_blocks), key=lambda k: (k is None, str(k))
        )
        for key in block_keys:
            s_block = src_blocks.get(key, [])
            t_block = tgt_blocks.get(key, [])
            if not s_block or not t_block:
                continue  # a block with no counterpart can produce no links
            n_blocks += 1
            compared_pairs += len(s_block) * len(t_block)
            try:
                blk_links = resolver.discover_links(
                    source_entities=s_block,
                    target_entities=t_block,
                    metric=metric,
                    acceptance_threshold=self.threshold_accept,
                    review_threshold=self.threshold_review,
                    accepted_only=False,
                    properties=export_props,
                )
            except Exception as exc:
                logger.warning(
                    "STAGE-2 field-mode block %r raised %r — skipping block", key, exc
                )
                continue
            if blk_links:
                all_links.extend(blk_links)

        merged = self._dedup_stage2(all_links)

        # ── PYTHON POST-FILTER (title + authors confirmation) ────────────────
        # LIMES generated cheap candidates (title-trigram + exact-year). Now
        # confirm each in Python on TWO axes the binary-metric build cannot
        # express as extra LIMES leaves:
        #   * TITLE — char-trigram Jaccard. The decisive discriminator: TRUE
        #     DBLP-ACM matches have near-identical titles (≈1.0); the hard
        #     negatives that share only domain boilerplate sit ≈0.36–0.60, and
        #     LIMES' own `trigrams` over-scores them regardless of its floor.
        #   * AUTHORS — surname-set Jaccard (order/format-insensitive). Separates
        #     same-title same-year DIFFERENT-team papers the title axis can't.
        # A pair is KEPT only if it clears BOTH floors (when both fields present).
        title_by_uri: dict[str, str] = {}
        authors_by_uri: dict[str, str] = {}
        for e in src_export + tgt_export:
            u = e.get("uri")
            if u:
                title_by_uri[u] = str(e.get(self.field_title_prop) or "")
                authors_by_uri[u] = str(e.get(self.field_authors_prop) or "")

        a_thr = self.field_authors_threshold
        t_thr = self.field_title_threshold
        kept: list[dict] = []
        rej_title = rej_authors = 0
        kept_empty = 0
        for l in merged:
            s, t = l.get("source", ""), l.get("target", "")
            a_title, b_title = title_by_uri.get(s, ""), title_by_uri.get(t, "")
            a_auth, b_auth = authors_by_uri.get(s, ""), authors_by_uri.get(t, "")

            # TITLE confirmation (when both titles present). This is the primary
            # precision gate — reject before even looking at authors.
            if a_title.strip() and b_title.strip():
                t_sim = _title_similarity(a_title, b_title)
                if t_sim < t_thr:
                    rej_title += 1
                    continue
                l["_title_sim"] = round(t_sim, 3)

            # AUTHORS confirmation (when both author lists present).
            both_auth = bool(a_auth.strip()) and bool(b_auth.strip())
            if not both_auth:
                kept_empty += 1
                if self.field_authors_min_both:
                    kept.append(l)
                    continue
            a_sim = _authors_similarity(a_auth, b_auth)
            if a_sim >= a_thr:
                l["_authors_sim"] = round(a_sim, 3)
                kept.append(l)
            else:
                rej_authors += 1

        logger.info(
            "STAGE-2 field-mode: blocking=%r blocks=%d compared_pairs=%d "
            "(vs %d full n^2) → %d LIMES links; post-filter(title>=%.2f,authors>=%.2f) "
            "kept %d rej_title %d rej_authors %d (kept_empty_authors=%d) title_floor=%s",
            scheme, n_blocks, compared_pairs,
            len(src_export) * len(tgt_export), len(merged), t_thr, a_thr,
            len(kept), rej_title, rej_authors, kept_empty, str(self.field_title_floor),
        )
        return kept

    def _stage2_general_blocked(
        self,
        resolver,
        src_export: list[dict],
        tgt_export: list[dict],
        metric: str,
        export_props: list[str],
        median_len: int,
    ) -> list[dict]:
        """General-path Stage-2 with NAME-based, recall-preserving BLOCKING.

        Same engine and metric as the unblocked general path (the trigram name
        metric with exactmatch(type) blocking), but instead of one LIMES call over
        the full src×tgt cross product, it sub-partitions the coarse bucket into
        BLOCKS keyed by ``_general_block_keys`` and runs LIMES PER BLOCK. A block
        for key ``k`` is (src entities carrying k) × (tgt entities carrying k); a
        pair is compared iff it shares ≥1 key (canopy overlap). This bounds the
        compared pairs by Σ_k |src_k|·|tgt_k| ≪ |src|·|tgt| as the bucket grows.

        The keys are REDUNDANT so the candidate set is a SUPERSET of the true
        matches with high probability: a true pair is dropped only if it differs
        on every cheap signature at once. LIMES + the trigram floor remain the
        actual precision gate, so blocking does not change precision — it only
        removes pairs LIMES would never accept anyway, recovering throughput.

        The difflib short-name COMPLEMENT runs exactly as in the unblocked path,
        but restricted to the SAME candidate pairs (so it stays bounded too).

        IMPLEMENTATION NOTE — why PACK instead of one-call-per-block: the natural
        "one LIMES call per key block" is thousands of HTTP upload/submit/poll/
        download cycles (mostly singleton blocks) and exhausts ephemeral sockets
        on the host long before it saturates LIMES (whose compute is sub-quadratic
        and cheap). So we compute the bounded CANDIDATE-PAIR set from key overlap
        (this is the n²-tail cut and what `compared_pairs` reports), then run LIMES
        over a HANDFUL of packed batches and POST-FILTER its links down to exactly
        those candidate pairs. Same recall/precision as per-block, a few HTTP calls
        instead of thousands.
        """
        # 1. Bounded candidate-pair set via redundant-key OVERLAP (the n²-tail cut).
        candidate_pairs = _general_candidate_pairs(src_export, tgt_export)
        compared_pairs = len(candidate_pairs)
        candidate_set: set[tuple[str, str]] = set()
        for e1, e2 in candidate_pairs:
            u1, u2 = e1.get("uri", ""), e2.get("uri", "")
            candidate_set.add((min(u1, u2), max(u1, u2)))

        # 2. Only entities that appear in ≥1 candidate pair need to go to LIMES.
        src_uris_needed: set[str] = set()
        tgt_uris_needed: set[str] = set()
        for e1, e2 in candidate_pairs:
            src_uris_needed.add(e1.get("uri", ""))
            tgt_uris_needed.add(e2.get("uri", ""))
        src_use = [e for e in src_export if e.get("uri") in src_uris_needed]
        tgt_use = [e for e in tgt_export if e.get("uri") in tgt_uris_needed]

        # 3. PACK into a bounded number of LIMES calls (≤ budget entities/side).
        #    Each batch is an independent src×tgt slice; LIMES blocks internally so
        #    its cross-batch compute stays cheap, and we post-filter to candidates.
        budget = max(GENERAL_BLOCK_LIMES_BUDGET, 1)
        all_links: list[dict] = []
        n_calls = 0
        si = 0
        while si < len(src_use):
            s_batch = src_use[si:si + budget]
            si += budget
            tj = 0
            while tj < len(tgt_use):
                t_batch = tgt_use[tj:tj + budget]
                tj += budget
                n_calls += 1
                try:
                    blk_links = resolver.discover_links(
                        source_entities=s_batch,
                        target_entities=t_batch,
                        metric=metric,
                        acceptance_threshold=self.threshold_accept,
                        review_threshold=self.threshold_review,
                        accepted_only=False,
                        properties=export_props,
                    )
                except Exception as exc:
                    logger.warning(
                        "STAGE-2 general-blocked batch (%d×%d) raised %r — skipping",
                        len(s_batch), len(t_batch), exc,
                    )
                    continue
                if blk_links:
                    all_links.extend(blk_links)

        # 4. POST-FILTER LIMES output to ONLY the candidate pairs (so cross-block
        #    pairs that share a packed batch but no block key are dropped — the
        #    blocking semantics are preserved exactly).
        all_links = [
            l for l in all_links
            if (min(l.get("source", ""), l.get("target", "")),
                max(l.get("source", ""), l.get("target", ""))) in candidate_set
        ]
        merged = self._dedup_stage2(all_links)

        # Difflib short-name COMPLEMENT — same recall lever as the unblocked path
        # (typo/legal-suffix recoveries trigram set-similarity under-scores), but
        # restricted to the SAME within-block candidate pairs so it stays bounded.
        complement: list[dict] = []
        if median_len < 40:
            complement = self._difflib_complement_blocked(
                src_export, tgt_export, min_score=_STAGE2_COMPLEMENT_FLOOR,
            )
        if complement:
            merged = self._dedup_stage2(merged + complement)

        full_n2 = len(src_export) * len(tgt_export)
        logger.info(
            "STAGE-2 LIMES (method=resolver) GENERAL-BLOCKED: limes_calls=%d "
            "candidate_pairs=%d (vs %d full n^2, %.1fx fewer) → %d links "
            "(+%d difflib complement) over %d/%d entities, metric %r",
            n_calls, compared_pairs, full_n2,
            (full_n2 / compared_pairs) if compared_pairs else 0.0,
            len(merged) - len(complement) if complement else len(merged),
            len(complement), len(src_export), len(tgt_export), metric,
        )
        # If blocking somehow produced nothing AND LIMES never errored, do NOT
        # silently fall back to a full O(n^2) sweep (that would defeat the point at
        # scale); an empty result here means no within-block fuzzy match cleared
        # the floor, which is the correct answer.
        #
        # A8 HOOK (noisy-text within-block semantic confirm — NOT built here):
        # For dirty/noisy general names where the trigram floor over- or
        # under-merges, `_stage_canonical_link`'s embedding step is the natural
        # within-block precision check: embed the 1-hop context of each entity in a
        # candidate pair (canonical_link.fetch_contexts + embed_texts) and confirm
        # cosine >= CANONICAL_COSINE_THRESHOLD before accepting. It would slot in
        # right here as a post-filter over `merged` (candidate pairs only, so it
        # stays bounded), reusing the exact helpers `_stage_canonical_link` already
        # calls. Deferred deliberately — it adds an Ollama round-trip per pair and
        # is the next QUALITY lever for noisy data, separate from this throughput
        # (blocking) work.
        return merged

    def _difflib_complement_blocked(
        self,
        src_export: list[dict],
        tgt_export: list[dict],
        min_score: float,
    ) -> list[dict]:
        """difflib SequenceMatcher complement restricted to within-block candidate
        pairs (the general-path bounded analogue of ``_stage2_fallback``).

        Only the candidate pairs from ``_general_candidate_pairs`` are scored, so
        this is O(candidate_pairs) not O(n²). Same coarse-type + cross-source
        guards as the full fallback; same floor semantics.
        """
        from difflib import SequenceMatcher

        links: list[dict] = []
        for e1, e2 in _general_candidate_pairs(src_export, tgt_export):
            if e1.get("source_job") == e2.get("source_job"):
                continue
            if _coarse_of(e1) != _coarse_of(e2):
                continue
            name1 = (e1.get("name") or "").lower().strip()
            name2 = (e2.get("name") or "").lower().strip()
            if not name1 or not name2:
                continue
            ratio = SequenceMatcher(None, name1, name2).ratio()
            containment = 0.0
            if name1 in name2 or name2 in name1:
                shorter = min(len(name1), len(name2))
                longer = max(len(name1), len(name2))
                containment = shorter / longer if longer > 0 else 0
            score = max(ratio, containment * 0.9)
            if score >= min_score:
                links.append({
                    "source": e1.get("uri", ""),
                    "target": e2.get("uri", ""),
                    "confidence": round(score, 4),
                    "method": "resolver_fallback",
                    "source_name": e1.get("name", ""),
                    "target_name": e2.get("name", ""),
                })
        return links

    @staticmethod
    def _dedup_stage2(links: list[dict]) -> list[dict]:
        """Dedup an undirected (source,target) link list, keeping the highest
        confidence per pair. Used to union the LIMES + difflib Stage-2 passes
        without double-counting a pair both engines agree on."""
        best: dict[tuple[str, str], dict] = {}
        for l in links:
            s = l.get("source", "")
            t = l.get("target", "")
            if not s or not t:
                continue
            key = (min(s, t), max(s, t))
            if key not in best or l.get("confidence", 0) > best[key].get("confidence", 0):
                best[key] = l
        return list(best.values())

    def _stage2_fallback(
        self, source_job_ids: list[str], exclude_uris: set[str] | None = None,
        min_score: float | None = None,
    ) -> list[dict]:
        """
        Enhanced string similarity fallback when resolver is unavailable.
        Uses multiple metrics: JaroWinkler, trigram, and type matching.

        ``min_score`` floors the difflib/containment score. Defaults to
        ``self.threshold_review`` for the standalone fallback path (LIMES down),
        which preserves its original behaviour. When the matcher runs as a
        COMPLEMENT to a successful LIMES pass, the caller passes a stricter floor
        (``_STAGE2_COMPLEMENT_FLOOR``): the loose 0.40 review floor is correct for
        a trigram-vetted LIMES band, but difflib's raw subsequence ratio is more
        permissive on the cross-entity hard negatives, so the complement needs a
        higher bar to add ONLY confident typo/legal-suffix recoveries (it must not
        cost precision — verified: 0.40 dropped synthetic-gold P to 0.95, 0.62
        restores P=1.0).
        """
        floor = self.threshold_review if min_score is None else min_score
        from difflib import SequenceMatcher

        entities = self._collect_entities(source_job_ids)
        if exclude_uris:
            entities = [e for e in entities if e.get("uri") not in exclude_uris]

        links = []
        seen = set()

        for i, e1 in enumerate(entities):
            for j, e2 in enumerate(entities):
                if j <= i:
                    continue
                if e1.get("source_job") == e2.get("source_job"):
                    continue
                if _coarse_of(e1) != _coarse_of(e2):
                    continue

                pair_key = (
                    min(e1.get("uri", ""), e2.get("uri", "")),
                    max(e1.get("uri", ""), e2.get("uri", "")),
                )
                if pair_key in seen:
                    continue

                name1 = (e1.get("name") or "").lower().strip()
                name2 = (e2.get("name") or "").lower().strip()

                if not name1 or not name2:
                    continue

                # Multiple similarity measures
                ratio = SequenceMatcher(None, name1, name2).ratio()

                # Also check containment (e.g., "VW" in "Volkswagen")
                containment = 0.0
                if name1 in name2 or name2 in name1:
                    shorter = min(len(name1), len(name2))
                    longer = max(len(name1), len(name2))
                    containment = shorter / longer if longer > 0 else 0

                # Combined score
                score = max(ratio, containment * 0.9)

                if score >= floor:
                    seen.add(pair_key)
                    links.append({
                        "source": e1.get("uri", ""),
                        "target": e2.get("uri", ""),
                        "confidence": round(score, 4),
                        "method": "resolver_fallback",
                        "source_name": e1.get("name", ""),
                        "target_name": e2.get("name", ""),
                    })

        return links

    # ── Stage 3: ConEx ──────────────────────────────────────────────

    def _stage3_conex(
        self, source_job_ids: list[str], exclude_uris: set[str] | None = None
    ) -> list[dict]:
        """
        Knowledge graph embedding-based link prediction.
        Trains ConEx on the graph structure and predicts missing links.
        """
        try:
            from .conex import get_conex_predictor
        except Exception as exc:
            logger.warning(f"ConEx not available: {exc}")
            return []

        # Collect all triples from source jobs
        triples = self._collect_triples(source_job_ids)
        if len(triples) < 10:
            logger.info("Not enough triples for ConEx training — skipping Stage 3")
            return []

        # Train ConEx
        predictor = get_conex_predictor(epochs=30, embedding_dim=50)
        train_stats = predictor.train(triples)
        logger.info(f"ConEx training: {train_stats}")

        if "error" in train_stats:
            return []

        # Predict links between unmatched entities
        entities = self._collect_entities(source_job_ids)
        unmatched = [
            e.get("uri", "") for e in entities
            if e.get("uri") and (not exclude_uris or e.get("uri") not in exclude_uris)
        ]

        predictions = predictor.predict_links(
            unmatched, unmatched, top_k=50, threshold=0.6
        )

        return predictions

    # ── Smart-match: acronym + token-sort/set ────────────────────────

    def _stage_smart_match(self, entities: list[dict]) -> list[dict]:
        """Catch abbreviation + word-order co-references the other stages miss.

        Compares entities of the SAME ``type`` across DIFFERENT source jobs
        (mirroring stages 1-3). Two conservative matchers, each emitting a
        ``method='smart'`` sameAs link:

          * Acronym — one side is an unambiguous acronym (initials or embedded
            capitals) of the other. Confidence 0.95.
          * Token-sort/set — significant-token sets equal or Jaccard ≥0.9,
            i.e. a pure word-order / reordering variant. Confidence 0.90.

        Strictness protects precision against the gold set's hard cross-entity
        negatives: acronyms require a full consistent derivation, and the token
        matcher only fires on (near-)identical token SETS — never on a mere
        shared word.
        """
        TOKEN_JACCARD_MIN = 0.9
        links: list[dict] = []
        seen: set[tuple[str, str]] = set()

        # Pre-compute the significant words / acronym candidates per entity so
        # the O(n²) sweep stays cheap.
        ents = [e for e in entities if (e.get("name") or "").strip() and e.get("uri")]

        for i, e1 in enumerate(ents):
            n1 = e1["name"].strip()
            t1 = _coarse_of(e1)
            j1 = e1.get("source_job")
            words1 = _smart_significant_words(n1)
            for j in range(i + 1, len(ents)):
                e2 = ents[j]
                if e1.get("source_job") == e2.get("source_job"):
                    continue  # only link across source jobs
                if t1 != _coarse_of(e2):
                    continue  # same coarse-type only, like every other stage
                n2 = e2["name"].strip()

                # Smart-match is for NAMED entities (orgs, people, products).
                # Skip dates / numbers / non-name tokens: real graphs hold many
                # same-type date/metric entities that must NEVER collapse
                # (e.g. "2024-01-01" vs "2024", "2022-05-01" vs "2022"). This
                # over-merge was caught in real-graph validation, invisible to
                # the clean synthetic gold.
                if (n1[:1].isdigit() or n2[:1].isdigit()
                        or sum(c.isalpha() for c in n1) < 2
                        or sum(c.isalpha() for c in n2) < 2):
                    continue

                pair_key = (
                    min(e1["uri"], e2["uri"]),
                    max(e1["uri"], e2["uri"]),
                )
                if pair_key in seen:
                    continue

                method = None
                confidence = 0.0
                words2 = _smart_significant_words(n2)
                set1, set2 = set(words1), set(words2)

                # ── Acronym: one side initials/embedded-caps of the other ──
                if len(words1) <= 1 or len(words2) <= 1:
                    short, long_name = (n1, n2) if len(n1.replace(" ", "")) <= len(n2.replace(" ", "")) else (n2, n1)
                    short_words = _smart_significant_words(short)
                    long_words = _smart_significant_words(long_name)
                    # Only treat as acronym when the long side is genuinely
                    # multi-word/compound and the short side is a single token.
                    if len(short_words) <= 1 and len(long_words) >= 2 and _is_acronym_match(short, long_name):
                        method, confidence = "smart", 0.95

                # ── Token-set equal: identical core name after suffix/stop
                # stripping (covers legal-suffix + reordering identity). ──
                if method is None and set1 and set2 and set1 == set2:
                    method, confidence = "smart", 0.92

                # (Token-subset / leading-prefix rule REMOVED: it over-merged on
                # real data — "Software" ⊂ "Software as a Service", and even its
                # intended case "Siemens" ⊂ "Siemens Healthineers" is a distinct
                # parent/subsidiary, not a co-reference. A leading prefix is too
                # weak a signal for sameness.)

                # ── Token-sort/set Jaccard: word-order / reordering variants
                if method is None:
                    jac = _smart_token_match(n1, n2)
                    if jac >= TOKEN_JACCARD_MIN and len(words1) >= 2 and len(words2) >= 2:
                        method, confidence = "smart", 0.90

                # ── Person initials: "P. Vance" ↔ "Dr Patricia Vance" ──────
                if method is None:
                    pw1 = _smart_significant_words(n1, drop_titles=True)
                    pw2 = _smart_significant_words(n2, drop_titles=True)
                    if _person_initial_match(pw1, pw2) or _person_initial_match(pw2, pw1):
                        method, confidence = "smart", 0.90

                if method:
                    seen.add(pair_key)
                    links.append({
                        "source": e1["uri"],
                        "target": e2["uri"],
                        "confidence": confidence,
                        "method": method,
                        "source_name": n1,
                        "target_name": n2,
                    })

        return links

    # ── Canonical entity-linking: cross-bucket co-reference by context ───

    def _stage_canonical_link(
        self, entities: list[dict], source_job_ids: list[str]
    ) -> list[dict]:
        """Collapse CROSS-coarse-bucket co-references confirmed by CONTEXT.

        The coarse-blocked stages (APOC / resolver / smart-match) only compare
        SAME-bucket entities, so a real-world entity whose coarse type differs
        across documents stays fragmented. This pass targets exactly those
        pairs:

          1. Generate cross-bucket, cross-job candidates with strong surface
             name evidence (exact-normalized / acronym / token-sort / person-
             initial — reusing the smart-match helpers).
          2. Embed a short CONTEXT per entity (name + 1-hop neighbours +
             optional grounding snippet) via Ollama nomic-embed-text, cache by
             uri within the run, and MERGE only when cosine ≥ threshold.

        Emits ``method='canonical'`` sameAs links (confidence = cosine) feeding
        the same union-find as the other stages. Fails OPEN: if Ollama is
        unreachable or no candidates exist, returns [] and the merge proceeds.
        """
        candidates = canonical_link.generate_candidates(
            entities,
            coarse_of=_coarse_of,
            is_acronym_match=_is_acronym_match,
            smart_token_match=_smart_token_match,
            smart_significant_words=_smart_significant_words,
            person_initial_match=_person_initial_match,
        )
        if not candidates:
            logger.info("canonical: no cross-bucket candidates — pass is a no-op")
            return []

        # Performance guard: cap the number of pairs we embed; strongest
        # name-similarity pairs are kept first (generate_candidates pre-sorts).
        if len(candidates) > canonical_link.MAX_CANONICAL_PAIRS:
            logger.warning(
                "canonical: %s candidates exceeds cap %s — processing top by name-similarity",
                len(candidates), canonical_link.MAX_CANONICAL_PAIRS,
            )
            candidates = candidates[: canonical_link.MAX_CANONICAL_PAIRS]

        # Unique URIs across all candidate pairs → build + embed contexts once.
        uris: list[str] = []
        name_by_uri: dict[str, str] = {}
        seen_uri: set[str] = set()
        for e1, e2, _ in candidates:
            for e in (e1, e2):
                u = e.get("uri")
                if u and u not in seen_uri:
                    seen_uri.add(u)
                    uris.append(u)
                    name_by_uri[u] = e.get("name") or ""

        try:
            contexts = canonical_link.fetch_contexts(self.driver, uris)
        except Exception as exc:
            logger.warning(f"canonical: context fetch failed ({exc}) — skipping pass")
            return []
        # Best-effort grounding-snippet enrichment (never fatal).
        canonical_link.enrich_with_qdrant(contexts, name_by_uri, source_job_ids)

        # Ensure every context is non-empty (fall back to the bare name) so the
        # embedder always gets a meaningful string.
        ctx_list = [contexts.get(u) or name_by_uri.get(u, "") or u for u in uris]
        vectors = canonical_link.embed_texts(ctx_list)
        if vectors is None:
            logger.warning("canonical: embeddings unavailable — pass skipped (fail-open)")
            return []
        emb_by_uri = dict(zip(uris, vectors))

        threshold = canonical_link.CANONICAL_COSINE_THRESHOLD
        links: list[dict] = []
        for e1, e2, name_score in candidates:
            u1, u2 = e1.get("uri"), e2.get("uri")
            v1, v2 = emb_by_uri.get(u1), emb_by_uri.get(u2)
            if not v1 or not v2:
                continue
            sim = canonical_link.cosine(v1, v2)
            if sim >= threshold:
                links.append({
                    "source": u1,
                    "target": u2,
                    "confidence": round(sim, 4),
                    "method": "canonical",
                    "source_name": e1.get("name", ""),
                    "target_name": e2.get("name", ""),
                    "source_coarse": _coarse_of(e1),
                    "target_coarse": _coarse_of(e2),
                    "name_score": name_score,
                })
                logger.info(
                    "canonical MERGE: %r[%s] + %r[%s] cosine=%.4f",
                    e1.get("name"), _coarse_of(e1),
                    e2.get("name"), _coarse_of(e2), sim,
                )
            else:
                logger.info(
                    "canonical SKIP: %r[%s] vs %r[%s] cosine=%.4f < %.2f",
                    e1.get("name"), _coarse_of(e1),
                    e2.get("name"), _coarse_of(e2), sim, threshold,
                )
        return links

    # ── Embedding best-buddy + model-number (NOISY general-name data) ───

    def _stage_embedding_match(
        self, entities: list[dict], source_job_ids: list[str]
    ) -> list[dict]:
        """The DIRTY-TEXT quality lever (Abt-Buy faithful F1 0.48 → 0.87).

        Wraps the converged research recipe (embedding_match.discover_embedding_
        links): reciprocal best-buddy on NAME and NAME+DESCRIPTION nomic-embed-
        text embeddings, plus strict model-number matching, all local via Ollama.

        Gated to the GENERAL (name-only) path: it is a NO-OP for the clean
        field-mode path (rich attributes → the per-field LIMES metric is the
        right tool) and for tiny graphs (below EMB_MATCH_MIN_ENTITIES, where the
        trigram path is already adequate and an Ollama round-trip is wasteful).
        So enabling it cannot degrade the clean-data or synthetic-gold results;
        it only ADDS recall+precision on noisy product/general data.

        Source/target are split by source job exactly like Stage-2, so the
        best-buddy reciprocity is a true cross-source 1:1 competition. Emits
        ``method='embedding-*'`` sameAs links into the same union-find as the
        other stages. Fails OPEN (returns []) if Ollama is unreachable.
        """
        ents = [e for e in entities if (e.get("name") or "").strip() and e.get("uri")]
        if len(ents) < embedding_match.EMB_MATCH_MIN_ENTITIES:
            logger.info(
                "embedding-match: %d entities < min %d — pass skipped",
                len(ents), embedding_match.EMB_MATCH_MIN_ENTITIES,
            )
            return []

        # FIELD-MODE GUARD: when entities carry rich discriminating attributes
        # (title/authors/venue/year), the clean per-field LIMES metric is the
        # right matcher and this noisy-text pass must stay out of its way. Detect
        # the same way Stage-2 does (any extra attribute present non-empty).
        has_rich_attrs = any(
            str(e.get(p) or "").strip()
            for e in ents for p in ATTR_EXTRA_PROPS
        )
        if has_rich_attrs:
            logger.info(
                "embedding-match: rich field attributes present — deferring to "
                "field-mode metric (pass skipped)"
            )
            return []

        # Split source/target by source job (mirror _stage2_resolver), so the
        # reciprocal best-buddy is a genuine cross-source competition.
        mid = len(source_job_ids) // 2
        source_jobs = set(source_job_ids[:max(mid, 1)])
        src = [e for e in ents if e.get("source_job") in source_jobs]
        tgt = [e for e in ents if e.get("source_job") not in source_jobs]
        if not src or not tgt:
            mid_e = len(ents) // 2
            src, tgt = ents[:mid_e], ents[mid_e:]
        if not src or not tgt:
            return []

        try:
            return embedding_match.discover_embedding_links(
                src, tgt, coarse_of=_coarse_of,
            )
        except Exception as exc:
            logger.warning(
                "embedding-match: pass raised %r — skipping (fail-open)", exc
            )
            return []

    # ── Helpers ──────────────────────────────────────────────────────

    def _collect_entities(self, source_job_ids: list[str]) -> list[dict]:
        # Carry the extra attribute properties (title/authors/venue/year, …)
        # alongside name/type so Stage-2 can do ATTRIBUTE-AWARE (per-field)
        # matching. These are absent on the general-KG / synthetic-gold path
        # (return null → pruned downstream), so that path is unchanged.
        extra = ", ".join(f"e.{p} AS {p}" for p in ATTR_EXTRA_PROPS)
        query = f"""
        MATCH (e:Entity)
        WHERE e._source_job IN $job_ids
        RETURN e.name AS name, e.type AS type, e.coarse_type AS coarse_type,
               e.label AS label,
               {extra},
               e.uri AS uri, e._source_job AS source_job,
               e._classification AS classification,
               e._class_labels AS class_labels, e._label_ranks AS label_ranks
        """
        with self.driver.session() as session:
            result = session.run(query, job_ids=source_job_ids)
            return [dict(record) for record in result]

    def _collect_triples(self, source_job_ids: list[str]) -> list[tuple[str, str, str]]:
        """Collect (head_uri, relation_type, tail_uri) triples."""
        query = """
        MATCH (a:Entity)-[r]->(b:Entity)
        WHERE a._source_job IN $job_ids
          AND b._source_job IN $job_ids
          AND NOT type(r) IN ['CONTAINS', 'SIMILAR_TO']
        RETURN a.uri AS head, type(r) AS rel, b.uri AS tail
        """
        triples = []
        with self.driver.session() as session:
            result = session.run(query, job_ids=source_job_ids)
            for record in result:
                if record["head"] and record["tail"]:
                    triples.append((record["head"], record["rel"], record["tail"]))
        return triples

    def _extract_matched_uris(self, links: list[dict]) -> set[str]:
        uris = set()
        for link in links:
            uris.add(link.get("source", ""))
            uris.add(link.get("target", ""))
        uris.discard("")
        return uris

    def _deduplicate_links(self, links: list[dict]) -> list[dict]:
        """Remove duplicate links, keeping highest confidence."""
        seen: dict[tuple[str, str], dict] = {}
        for link in links:
            key = (
                min(link["source"], link["target"]),
                max(link["source"], link["target"]),
            )
            if key not in seen or link["confidence"] > seen[key]["confidence"]:
                seen[key] = link
        return list(seen.values())

    @staticmethod
    def _canonical_coarse_type(member_recs: list[dict]) -> tuple[str, list[str]]:
        """Pick the cluster's canonical coarse_type + list all constituents.

        Returns (canonical_coarse, constituent_coarses):
          * canonical_coarse — the MOST FREQUENT coarse bucket among members,
            with ties broken toward a non-"other" bucket (an explicit type is
            more informative than the catch-all). For a normal same-bucket
            cluster this is just that single bucket, so behaviour is unchanged.
          * constituent_coarses — sorted unique coarse buckets across the
            cluster, stored on the merged node as `_coarse_types` provenance so
            a cross-bucket canonical merge is fully transparent.
        """
        coarses = [_coarse_of(r) for r in member_recs]
        coarses = [c for c in coarses if c]
        if not coarses:
            return "", []
        counts: dict[str, int] = {}
        for c in coarses:
            counts[c] = counts.get(c, 0) + 1
        # Sort by (frequency desc, is-"other" asc, name) → most frequent first,
        # preferring an explicit bucket over "other" on ties, deterministic.
        best = sorted(
            counts.items(),
            key=lambda kv: (-kv[1], 1 if str(kv[0]).lower() == "other" else 0, str(kv[0])),
        )[0][0]
        return best, sorted(set(coarses))

    def _write_merged_graph(
        self,
        compilation_id: str,
        all_entities: list[dict],
        all_links: list[dict],
        source_job_ids: list[str],
        user_id: str,
        classification: str,
    ) -> dict:
        """Write merged entities and sameAs links to Neo4j."""
        entities_created = 0

        # Build a union-find to cluster linked entities
        uri_to_cluster: dict[str, int] = {}
        clusters: dict[int, list[str]] = {}
        next_cluster = 0

        # Every entity starts in its own cluster
        for e in all_entities:
            uri = e.get("uri", "")
            if uri and uri not in uri_to_cluster:
                uri_to_cluster[uri] = next_cluster
                clusters[next_cluster] = [uri]
                next_cluster += 1

        # Merge clusters based on links
        for link in all_links:
            src = link["source"]
            tgt = link["target"]
            if src not in uri_to_cluster or tgt not in uri_to_cluster:
                continue

            c1 = uri_to_cluster[src]
            c2 = uri_to_cluster[tgt]
            if c1 != c2:
                # Merge smaller into larger
                if len(clusters.get(c1, [])) < len(clusters.get(c2, [])):
                    c1, c2 = c2, c1
                for uri in clusters.get(c2, []):
                    uri_to_cluster[uri] = c1
                    clusters.setdefault(c1, []).append(uri)
                clusters.pop(c2, None)

        # Build entity lookup
        entity_by_uri: dict[str, dict] = {}
        for e in all_entities:
            uri = e.get("uri", "")
            if uri:
                entity_by_uri[uri] = e

        # Create merged entities in Neo4j
        unique_clusters = set(uri_to_cluster.values())
        conflicts: list[dict] = []

        with self.driver.session() as session:
            # Create compilation node
            session.run(
                """
                MERGE (c:Compilation {compilation_id: $cid})
                SET c.updated_at = datetime(),
                    c._owner = $user_id,
                    c._classification = $classification
                """,
                cid=compilation_id, user_id=user_id, classification=classification,
            )

            for cluster_id in unique_clusters:
                members = clusters.get(cluster_id, [])
                if not members:
                    continue

                # Pick canonical entity (highest scoring or first)
                canonical_uri = members[0]
                canonical = entity_by_uri.get(canonical_uri, {})

                member_recs = [entity_by_uri.get(uri, {}) for uri in members]
                source_jobs = list({rec.get("source_job", "") for rec in member_recs})
                source_jobs = [s for s in source_jobs if s]

                # Canonical coarse_type for the cluster. For a normal same-bucket
                # cluster this is just the (single) coarse type. For a CROSS-bucket
                # cluster produced by the canonical-link pass, members carry
                # different coarse types: pick the MOST FREQUENT, preferring a
                # non-"other" bucket on ties, and keep ALL constituent coarse
                # types in a provenance array for transparency.
                canonical_coarse, constituent_coarses = self._canonical_coarse_type(
                    member_recs
                )

                # Union classification labels across the cluster (no escalation).
                class_labels, label_ranks, min_rank, conflict = _union_labels(member_recs)
                merged_uri = f"{canonical.get('name','')}_{canonical.get('type','')}_{compilation_id}"
                if conflict:
                    conflicts.append({
                        "element_kind": "node",
                        "element_key": merged_uri,
                        "labels": [json.loads(x) for x in class_labels],
                    })

                session.run(
                    """
                    MERGE (e:Entity:Merged {
                        name: $name,
                        type: $type,
                        _compilation: $cid
                    })
                    SET e.label = $label,
                        e.coarse_type = $coarse_type,
                        e.uri = $name + '_' + $type + '_' + $cid,
                        e._classification = $level_name,
                        e._class_labels = $class_labels,
                        e._label_ranks = $label_ranks,
                        e._min_rank = $min_rank,
                        e._class_conflict = $conflict,
                        e._owner = $user_id,
                        e._source_jobs = $source_jobs,
                        e._coarse_types = $coarse_types,
                        e._merge_count = $merge_count
                    WITH e
                    MATCH (c:Compilation {compilation_id: $cid})
                    MERGE (c)-[:CONTAINS]->(e)
                    """,
                    name=canonical.get("name", ""),
                    type=canonical.get("type", ""),
                    coarse_type=canonical_coarse,
                    label=canonical.get("label", ""),
                    cid=compilation_id,
                    level_name=next((n for n, r in _NAME_RANK.items() if r == min_rank), "PUBLIC"),
                    class_labels=class_labels,
                    label_ranks=label_ranks,
                    min_rank=min_rank,
                    conflict=conflict,
                    user_id=user_id,
                    source_jobs=source_jobs,
                    coarse_types=constituent_coarses,
                    merge_count=len(members),
                )
                entities_created += 1

        duplicates_found = sum(1 for c in unique_clusters if len(clusters.get(c, [])) > 1)

        return {
            "entities_merged": entities_created,
            "duplicates_found": duplicates_found,
            "nodes_total": entities_created,
            "_conflicts": conflicts,
        }

    def _merge_relations(
        self,
        compilation_id: str,
        source_job_ids: list[str],
        user_id: str,
        classification: str,
    ) -> int:
        """Copy relations from source jobs to merged entities."""
        query = """
        MATCH (a:Entity)-[r]->(b:Entity)
        WHERE a._source_job IN $job_ids
          AND b._source_job IN $job_ids
          AND NOT type(r) IN ['CONTAINS', 'SIMILAR_TO']
        RETURN a.name AS head_name, a.type AS head_type,
               type(r) AS rel_type,
               b.name AS tail_name, b.type AS tail_type,
               r._source_job AS source_job,
               r._class_labels AS class_labels, r._label_ranks AS label_ranks,
               r._classification AS classification,
               coalesce(r.asserted_at, r.created_at, 0) AS asserted_at
        """
        with self.driver.session() as session:
            result = session.run(query, job_ids=source_job_ids)
            relations = [dict(record) for record in result]

        # Group duplicate source relations by (head,tail,rel_type) so the merged
        # relation carries the UNION of their classification labels.
        grouped: dict[tuple, list[dict]] = {}
        for rel in relations:
            key = (rel["head_name"], rel["head_type"], rel["rel_type"],
                   rel["tail_name"], rel["tail_type"])
            grouped.setdefault(key, []).append(rel)

        count = 0
        conflicts: list[dict] = []
        with self.driver.session() as session:
            for key, members in grouped.items():
                head_name, head_type, rel_type, tail_name, tail_type = key
                safe_type = rel_type.replace("`", "``")
                class_labels, label_ranks, min_rank, conflict = _union_labels(members)
                # Preserve recency through fusion: the merged fact's asserted_at is the
                # NEWEST source assertion, so latest-value-wins survives into the
                # compiled graph (incremental refresh keeps temporal ordering correct).
                max_asserted = max((m.get("asserted_at") or 0) for m in members)
                if conflict:
                    conflicts.append({
                        "element_kind": "edge",
                        "element_key": f"{head_name}|{rel_type}|{tail_name}|{compilation_id}",
                        "labels": [json.loads(x) for x in class_labels],
                    })
                result = session.run(
                    f"""
                    MATCH (a:Entity:Merged {{_compilation: $cid}})
                    WHERE a.name = $head_name AND a.type = $head_type
                    MATCH (b:Entity:Merged {{_compilation: $cid}})
                    WHERE b.name = $tail_name AND b.type = $tail_type
                    MERGE (a)-[r:`{safe_type}`]->(b)
                    SET r._compilation = $cid,
                        r._classification = $level_name,
                        r._class_labels = $class_labels,
                        r._label_ranks = $label_ranks,
                        r._min_rank = $min_rank,
                        r._class_conflict = $conflict,
                        r._owner = $user_id,
                        r.asserted_at = $asserted_at
                    RETURN count(r) AS cnt
                    """,
                    cid=compilation_id,
                    asserted_at=max_asserted,
                    head_name=head_name,
                    head_type=head_type,
                    tail_name=tail_name,
                    tail_type=tail_type,
                    level_name=next((n for n, r in _NAME_RANK.items() if r == min_rank), "PUBLIC"),
                    class_labels=class_labels,
                    label_ranks=label_ranks,
                    min_rank=min_rank,
                    conflict=conflict,
                    user_id=user_id,
                )
                record = result.single()
                if record and record["cnt"] > 0:
                    count += 1

        self._last_relation_conflicts = conflicts
        return count

    def _empty_stats(self) -> dict:
        return {
            "entities_merged": 0,
            "duplicates_found": 0,
            "relations_merged": 0,
            "nodes_total": 0,
            "stage1_apoc": 0,
            "stage2_resolver": 0,
            "stage3_conex": 0,
            "smart_match": 0,
            "canonical_link": 0,
            "total_links": 0,
        }


_merger: Optional[ThreeStageEntityMerger] = None


def get_merger() -> ThreeStageEntityMerger:
    global _merger
    if _merger is None:
        _merger = ThreeStageEntityMerger()
    return _merger

