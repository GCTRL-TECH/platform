"""
Deterministic format-based NER pre-pass — German/EN temporal + financial + percentage.

GLiNER (zero-shot) is a strong generalist but misses locale-specific numeric
formats: German decimal/thousands separators are the INVERSE of English ones
("92.701,00" = ninety-two thousand seven hundred one, "1.200 €" = twelve
hundred euros), German long-form dates ("12. März 2026"), and abbreviated
"Mio."/"Mrd." magnitude words. These are deterministically detectable with
regex and don't need a bigger/slower model — this module is a cheap, precise
recall lever that runs BEFORE/alongside GLiNER (see ner.py).

Deliberately narrow scope (see task spec): temporal, financial, and — for
quantity — ONLY percentages. Plain large numbers with unit-ish context are
excluded to avoid a false-positive flood ("12 engineers", "3 rooms", phone
numbers, IDs, etc.).

Pure function, no I/O, no model loading — safe to unit test without mocking
anything.
"""

import re

# ── shared vocabularies ──────────────────────────────────────────────────────

# NOTE: each of these is wrapped in its own non-capturing group. Interpolating
# a BARE `A|B|C` alternation into the middle of a larger f-string pattern is a
# classic regex bug — alternation has the lowest precedence, so it would split
# the ENCLOSING pattern at every `|`, not just the month list. Always group.
_MONTHS_DE = (
    r"(?:Januar|Februar|M[äa]rz|April|Mai|Juni|Juli|August|September|"
    r"Oktober|November|Dezember|"
    r"Jan\.?|Feb\.?|M[äa]r\.?|Apr\.?|Jun\.?|Jul\.?|Aug\.?|Sept\.?|Sep\.?|Okt\.?|Nov\.?|Dez\.?)"
)
_MONTHS_EN = (
    r"(?:January|February|March|April|May|June|July|August|September|"
    r"October|November|December|"
    r"Jan\.?|Feb\.?|Mar\.?|Apr\.?|Jun\.?|Jul\.?|Aug\.?|Sept\.?|Sep\.?|Oct\.?|Nov\.?|Dec\.?)"
)
_MONTHS_ANY = f"(?:{_MONTHS_DE}|{_MONTHS_EN})"

# ── temporal patterns (compiled once, module level) ──────────────────────────

_TEMPORAL_PATTERNS = [
    # ISO date: 2026-03-01 (checked before DD.MM.YYYY since it uses '-')
    re.compile(r"\b\d{4}-\d{2}-\d{2}\b"),
    # DD.MM.YYYY or DD.MM.YY — German numeric date. Word-boundary anchored so
    # it doesn't gobble part of a larger decimal number chain.
    re.compile(r"(?<!\d)\d{1,2}\.\d{1,2}\.\d{2,4}(?!\d)"),
    # D. <Monat> YYYY  (German long-form: "12. März 2026", "1. Jan. 2025")
    re.compile(rf"\b\d{{1,2}}\.\s?{_MONTHS_DE}\s+\d{{4}}\b"),
    # <Month> D, YYYY  (English long-form: "March 12, 2026")
    re.compile(rf"\b{_MONTHS_EN}\s+\d{{1,2}},\s?\d{{4}}\b"),
    # <Month> D YYYY  (English, no comma: "March 12 2026")
    re.compile(rf"\b{_MONTHS_EN}\s+\d{{1,2}}\s+\d{{4}}\b"),
    # D <Month> YYYY  (English day-first: "12 March 2026")
    re.compile(rf"\b\d{{1,2}}\s+{_MONTHS_EN}\s+\d{{4}}\b"),
    # bare "<Monat> YYYY" (German/English: "März 2026", "October 2025")
    re.compile(rf"\b{_MONTHS_ANY}\s+\d{{4}}\b"),
    # quarters: "Q1 2026", "1. Quartal 2026"
    re.compile(r"\bQ[1-4]\s?\d{4}\b"),
    re.compile(r"\b[1-4]\.\s?Quartal\s+\d{4}\b"),
]

# ── financial patterns ────────────────────────────────────────────────────

# Currency symbols/codes on either side of a number, plus German/English
# magnitude words (Mio./Mrd./Tsd./bn/M/K). Numbers may use German separators
# (. thousands, , decimal) or English separators (, thousands, . decimal).
_CUR_SYM = r"€|\$|£|¥"
_CUR_CODE = r"EUR|USD|GBP|CHF|JPY"
_CUR = rf"(?:{_CUR_SYM}|{_CUR_CODE})"

# A locale-agnostic number: leading 1-3 digits, then zero or more THREE-DIGIT
# groups separated by either "." or "," (thousands, either locale), then an
# optional final decimal part separated by whichever of "."/"," wasn't used
# for grouping. This single pattern handles German (92.701,00 / 1.200 / 3,5)
# and English (92,701.00 / 1,200 / 3.5) without needing to pick a locale via
# alternation — alternation between `_NUM_DE|_NUM_EN` was tried first and
# rejected: Python's `re` alternation is first-match-wins (not longest-match),
# so for e.g. "2.4M" the DE alternative would greedily claim just "2" (its
# `\.\d{3}` grouping requires exactly 3 digits, "4" is only 1, so the group
# doesn't extend) and the overall match would stop there instead of falling
# through to also capture ".4" — silently truncating amounts. Non-capturing
# groups throughout so this composes into the financial patterns below.
_NUM_ANY = r"\d{1,3}(?:[.,]\d{3})*(?:[.,]\d+)?"

# magnitude words: Mio./Mio, Mrd./Mrd, Tsd./Tsd, bn, M, K (word-boundary gated)
_MAG = r"(?:Mio\.?|Mrd\.?|Tsd\.?|bn|M|K)"

# Trailing/leading assertions use `(?!\w)` / `(?<!\w)` rather than `\b` wherever
# a currency SYMBOL (€ $ £ ¥ — all non-word chars) can sit at that edge: `\b`
# requires a word/non-word TRANSITION, which never holds between a symbol and
# an adjacent space or another symbol, so `...€\b` silently fails to match
# whenever the € is followed by whitespace. `(?!\w)`/`(?<!\w)` just assert
# "not immediately glued to a word char", which is what we actually want and
# works uniformly whether the edge character is a letter, digit, or symbol.
_FINANCIAL_PATTERNS = [
    # CUR NUM [MAG]  — "EUR 92.701,00", "USD 1,200.00", "$1,200", "EUR 3,5 Mio."
    re.compile(rf"\b(?:{_CUR_CODE})\s?{_NUM_ANY}(?:\s?{_MAG})?(?!\w)"),
    re.compile(rf"(?:{_CUR_SYM})\s?{_NUM_ANY}(?:\s?{_MAG})?(?!\w)"),
    # NUM [MAG] CUR — "92.701,00 EUR", "1.200 €", "3,5 Mio. EUR", "2.4M USD"
    re.compile(rf"\b{_NUM_ANY}(?:\s?{_MAG})?\s?(?:{_CUR_CODE}|{_CUR_SYM})(?!\w)"),
]

# ── quantity: percentages ONLY (deliberately narrow — see module docstring) ──

_PERCENT_PATTERN = re.compile(rf"\b{_NUM_ANY}\s?%")

# ── Compliance / standards gazetteer (coarse type `field`) ─────────────────────
# GLiNER reliably misses acronymic regulation/standard names (GDPR, DSGVO,
# ISO 27001, TISAX). These are a closed, high-precision set — a curated regex
# gazetteer recovers them without a bigger model. Multi-word/number-bearing
# forms are listed most-specific-first so the ISO-with-number span wins over a
# bare "ISO". Matched case-insensitively; `field` maps to gliner_label
# "regulation" in ner.py's _FORMAT_TYPE_TO_GLINER_LABEL.
_COMPLIANCE_PATTERNS = [
    re.compile(r"\bISO/IEC\s?\d{4,5}(?:[-:]\d+)?(?:[-:]\d{4})?\b"),
    re.compile(r"\bISO\s?\d{4,5}(?:[-:]\d+)?(?:[-:]\d{4})?\b"),
    re.compile(r"\bTISAX(?:\s+Level\s+\d)?\b", re.IGNORECASE),
    re.compile(r"\bSOC\s?2(?:\s+Type\s+I{1,2})?\b", re.IGNORECASE),
    re.compile(r"\bPCI[\s-]?DSS\b", re.IGNORECASE),
    re.compile(r"\bFDA\s?510\(k\)(?!\w)", re.IGNORECASE),
    re.compile(r"\bNIS\s?2\b", re.IGNORECASE),
    re.compile(r"\bIT-Grundschutz\b", re.IGNORECASE),
    # Bare acronyms — word-boundary, case-SENSITIVE (avoid matching lowercase
    # prose collisions); these forms are always upper-case in real docs.
    re.compile(r"\b(?:GDPR|DSGVO|HIPAA|CCPA|BDSG|SOX|MDR|IVDR|GxP|GAMP|HACCP|GoBD)\b"),
]

_FORMAT_SCORE = 0.95
_SOURCE = "regex"


def _spans_overlap(a_start: int, a_end: int, b_start: int, b_end: int) -> bool:
    return a_start < b_end and a_end > b_start


def _add_matches(text: str, patterns, entity_type: str, out) -> None:
    # `out` intentionally left untyped (not annotated `list`) — prod kex is
    # Cython-compiled, where a builtin-type annotation on a local/param
    # enforces an EXACT-type check (PyList_CheckExact) that would reject a
    # list subclass. It's only ever appended/iterated here, never relied on
    # for its exact type, so leaving it unannotated costs nothing.
    for pattern in patterns:
        for m in pattern.finditer(text):
            start, end = m.start(), m.end()
            # Skip if this exact span already claimed by a higher-priority
            # pattern within this same category pass (keeps offsets exact,
            # avoids duplicate entries for the same match from overlapping
            # alternations, e.g. ISO date pattern vs DD.MM.YYYY).
            if any(_spans_overlap(start, end, e["start"], e["end"]) for e in out):
                continue
            out.append(
                {
                    "start": start,
                    "end": end,
                    "text": m.group(0),
                    "type": entity_type,
                    "score": _FORMAT_SCORE,
                    "source": _SOURCE,
                }
            )


def detect_format_entities(text: str):
    """Detect German/EN temporal, financial, and percentage entities via regex.

    Returns a list of entity dicts: {start, end, text, type, score, source}
    with `type` in {"temporal", "financial", "quantity"}, `score` fixed at
    0.95 (authoritative — format matches are unambiguous), `source="regex"`.

    Offsets are exact character positions into `text`. Patterns are anchored
    on word boundaries and run against the whole string in one pass per
    category (temporal, then financial, then percentage) so within-category
    overlaps are deduped, but cross-category overlaps are left for the
    caller's own dedup (ner.py merges these into the GLiNER span-overlap
    dedup so the whole entity list is deduped once, consistently).

    Return/local values are deliberately left without `list`/`dict` type
    annotations — see the Cython-safety note on `_add_matches` above; the
    prod kex build is Cython-compiled and an exact-builtin-type annotation
    would reject any subclass instance passed in at runtime.
    """
    if not text:
        return []

    entities = []

    temporal_matches = []
    _add_matches(text, _TEMPORAL_PATTERNS, "temporal", temporal_matches)
    entities.extend(temporal_matches)

    financial_matches = []
    _add_matches(text, _FINANCIAL_PATTERNS, "financial", financial_matches)
    entities.extend(financial_matches)

    percent_matches = []
    _add_matches(text, [_PERCENT_PATTERN], "quantity", percent_matches)
    entities.extend(percent_matches)

    compliance_matches = []
    _add_matches(text, _COMPLIANCE_PATTERNS, "field", compliance_matches)
    entities.extend(compliance_matches)

    # Cross-category overlap resolution: a financial match ("EUR 92.701,00")
    # can overlap a bare-number temporal false-hit is not expected here, but a
    # percentage ("19 %") could in theory overlap a financial number pattern
    # if adjacent — resolve by keeping the FIRST-detected (temporal >
    # financial > quantity priority, matching the order entities were added),
    # dropping later spans that overlap an earlier one.
    resolved = []
    for ent in entities:
        if any(_spans_overlap(ent["start"], ent["end"], r["start"], r["end"]) for r in resolved):
            continue
        resolved.append(ent)

    resolved.sort(key=lambda e: e["start"])
    return resolved
