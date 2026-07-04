"""
NER Pipeline for KEX Service — GLiNER Zero-Shot NER
Supports unlimited entity types defined at inference time.
Uses Wikidata QID mapping for structured knowledge graph output.
"""

import logging
import re
import threading
from typing import Optional

from . import config
from .format_ner import detect_format_entities

logger = logging.getLogger(__name__)

# GLiNER has a practical limit on input length (~512 tokens).
# We chunk at character level and process each chunk.
_CHUNK_CHARS = 1200
_OVERLAP_CHARS = 120

# Serializes the GPU/CPU-bound GLiNER work across worker threads. Held ONLY
# around the one-time model load and each per-chunk predict — NOT across a whole
# document. So a huge doc's NER yields the lock between its chunks instead of
# blocking every other worker for minutes (head-of-line stall fix).
_model_lock = threading.Lock()


class NERPipeline:
    """GLiNER-based zero-shot NER with Wikidata type mapping."""

    def __init__(self) -> None:
        self._model = None

    def _get_model(self):
        # Double-checked locking: load exactly once even when several worker
        # threads hit a cold model simultaneously (the lock around predict no
        # longer wraps the whole call, so loading must guard itself).
        if self._model is None:
            with _model_lock:
                if self._model is None:
                    from gliner import GLiNER
                    import torch

                    device = "cuda" if torch.cuda.is_available() else "cpu"
                    logger.info(f"Loading GLiNER model: {config.GLINER_MODEL} on {device}")
                    model = GLiNER.from_pretrained(config.GLINER_MODEL)
                    if device == "cuda":
                        model = model.to(device)
                    self._model = model
                    logger.info(
                        f"GLiNER loaded — {len(config.DEFAULT_ENTITY_TYPES)} default entity types"
                    )
        return self._model

    @property
    def is_loaded(self) -> bool:
        return self._model is not None

    def extract_entities(
        self,
        text: str,
        entity_types: list[str] | None = None,
        threshold: float | None = None,
    ) -> list[dict]:
        """
        Run zero-shot NER on text.

        Args:
            text: Input text
            entity_types: Custom entity type labels (uses defaults if None)
            threshold: Confidence threshold for entity detection. If not
                given (None), resolves to `config.NER_THRESHOLD` (env
                `NER_THRESHOLD`, default 0.3) — a per-call value still wins.

        Returns list of dicts:
            start, end, text, type (Wikidata QID), label, score, gliner_label
        """
        text = text.strip()
        if not text:
            return []

        thr = threshold if threshold is not None else config.NER_THRESHOLD

        labels = entity_types or config.DEFAULT_ENTITY_TYPES
        model = self._get_model()

        # GLiNER performance degrades with too many labels at once.
        # Process in label batches for accuracy, then merge results.
        # Sweet spot: ~20 labels per batch for speed/accuracy balance.
        LABEL_BATCH_SIZE = 20
        all_raw = []

        if len(labels) <= LABEL_BATCH_SIZE:
            all_raw = self._extract_with_chunking(model, text, labels, thr)
        else:
            # Batch labels to keep GLiNER accurate
            for i in range(0, len(labels), LABEL_BATCH_SIZE):
                batch_labels = labels[i : i + LABEL_BATCH_SIZE]
                batch_entities = self._extract_with_chunking(
                    model, text, batch_labels, thr
                )
                all_raw.extend(batch_entities)

        # Deterministic format pre-pass (dates, currency amounts, percentages —
        # German + English). GLiNER's zero-shot model reliably misses these
        # locale-specific numeric formats; regex catches them precisely and
        # cheaply. Entities are folded into the SAME raw list, using a
        # `gliner_label` that already resolves to the right coarse bucket via
        # WIKIDATA_TYPE_MAP/COARSE_MAP (see mapping below), so they flow
        # through the existing dedup/type-mapping/consolidation unchanged.
        # Their fixed 0.95 score is deliberately higher than most GLiNER
        # confidence scores, so when a regex hit overlaps a GLiNER guess for
        # the same span, the dedup's score-sort keeps the (authoritative)
        # regex entity and drops the GLiNER duplicate.
        if config.FORMAT_NER_ENABLED:
            format_hits = detect_format_entities(text)
            if format_hits:
                all_raw.extend(self._format_to_raw(format_hits))
                logger.info(
                    f"Format-NER pre-pass: +{len(format_hits)} entities "
                    f"(temporal/financial/quantity)"
                )

        # Deduplicate overlapping entities (keep highest score)
        deduped = self._deduplicate(all_raw)

        # Map to Wikidata types
        mapped = self._to_wikidata(deduped)

        # Consolidate types so the SAME surface name resolves to ONE stable,
        # human-readable type across all its mentions (fixes "Fjalla is a person").
        return self._consolidate_types(mapped)

    def _extract_with_chunking(
        self, model, text: str, labels: list[str], threshold: float
    ) -> list[dict]:
        """Process text in chunks with overlap, run GLiNER on each."""
        if len(text) <= _CHUNK_CHARS:
            return self._predict(model, text, labels, threshold, offset=0)

        all_entities: list[dict] = []
        offset = 0

        while offset < len(text):
            chunk_end = min(offset + _CHUNK_CHARS, len(text))
            chunk = text[offset:chunk_end]

            # Find word boundary
            if chunk_end < len(text):
                boundary = chunk.rfind(" ")
                if boundary > _CHUNK_CHARS // 2:
                    chunk = chunk[:boundary]
                    chunk_end = offset + boundary

            chunk_entities = self._predict(model, chunk, labels, threshold, offset)
            all_entities.extend(chunk_entities)

            next_offset = chunk_end - _OVERLAP_CHARS
            if next_offset <= offset:
                break
            offset = next_offset

        return all_entities

    def _predict(
        self, model, text: str, labels: list[str], threshold: float, offset: int
    ) -> list[dict]:
        """Run GLiNER prediction on a single chunk.

        The actual inference is serialized via `_model_lock` (GPU/CPU safety),
        but the lock is released between chunks — so a large document can't hold
        it for its whole length and starve the rest of the worker pool.
        """
        try:
            with _model_lock:
                entities = model.predict_entities(
                    text, labels, threshold=threshold
                )
        except Exception as exc:
            logger.warning(f"GLiNER prediction failed on chunk at offset {offset}: {exc}")
            return []

        results = []
        for ent in entities:
            results.append(
                {
                    "start": ent["start"] + offset,
                    "end": ent["end"] + offset,
                    "text": ent["text"],
                    "gliner_label": ent["label"],
                    "score": round(float(ent["score"]), 4),
                }
            )
        return results

    # Maps format_ner.py's coarse `type` to an EXISTING GLiNER label that
    # already resolves to the same coarse bucket via WIKIDATA_TYPE_MAP /
    # COARSE_MAP (see config.py) — so format entities need no special-casing
    # in `_to_wikidata`/`_consolidate_types`, they just look like ordinary
    # (very confident) GLiNER hits for that label.
    _FORMAT_TYPE_TO_GLINER_LABEL = {
        "temporal": "date",
        "financial": "monetary value",
        "quantity": "percentage",
    }

    def _format_to_raw(self, format_entities):
        """Convert format_ner.py output into the same raw shape GLiNER
        predictions use (start, end, text, gliner_label, score), so they can
        be merged into `all_raw` before `_deduplicate`/`_to_wikidata` run.

        Params/return deliberately left without `list`/`dict` annotations —
        Cython-safety, see the `votes` note in `_consolidate_types` above."""
        raw = []
        for ent in format_entities:
            gliner_label = self._FORMAT_TYPE_TO_GLINER_LABEL.get(ent["type"], "quantity")
            raw.append(
                {
                    "start": ent["start"],
                    "end": ent["end"],
                    "text": ent["text"],
                    "gliner_label": gliner_label,
                    "score": ent["score"],
                }
            )
        return raw

    def _deduplicate(self, entities: list[dict]) -> list[dict]:
        """
        Remove overlapping entities, keeping the highest-scoring one.
        Also deduplicates by (text_lower, label).
        """
        if not entities:
            return []

        # Sort by score descending so we keep the best
        sorted_ents = sorted(entities, key=lambda e: -e["score"])
        kept: list[dict] = []
        seen_spans: list[tuple[int, int]] = []
        seen_keys: set[tuple[str, str]] = set()

        for ent in sorted_ents:
            key = (ent["text"].lower(), ent["gliner_label"])
            if key in seen_keys:
                continue

            # Check for span overlap with already-kept entities
            overlaps = False
            for s, e in seen_spans:
                if ent["start"] < e and ent["end"] > s:
                    overlaps = True
                    break

            if not overlaps:
                kept.append(ent)
                seen_spans.append((ent["start"], ent["end"]))
                seen_keys.add(key)

        return kept

    def _to_wikidata(self, entities: list[dict]) -> list[dict]:
        """Map GLiNER labels to a clean, human-readable type.

        The stored `type` is the STABLE coarse bucket (person / organization /
        location / technology / product / work / event / field / temporal /
        financial / quantity / other) — NOT the noisy fine Wikidata QID. The
        same surface entity therefore gets the same `type` regardless of which
        of GLiNER's ~400 fine labels happened to fire on a given mention.

        The fine QID + fine human label are preserved as secondary metadata
        (`fine_qid`, `label`) for callers that want the precise Wikidata type.
        """
        result = []
        for ent in entities:
            gliner_label = ent["gliner_label"]
            mapping = config.WIKIDATA_TYPE_MAP.get(gliner_label)

            if mapping:
                qid = mapping["qid"]
                human_label = mapping["label"]
            else:
                # Unknown type — use generic entity QID
                qid = "Q35120"
                human_label = gliner_label

            coarse = config.coarse_for(gliner_label, human_label)

            result.append(
                {
                    "start": ent["start"],
                    "end": ent["end"],
                    "text": ent["text"],
                    # `type` is now the clean coarse bucket (human-readable, stable).
                    "type": coarse,
                    "coarse_type": coarse,
                    # Fine Wikidata type kept as metadata only.
                    "fine_qid": qid,
                    "label": human_label,
                    "score": ent["score"],
                    "gliner_label": gliner_label,
                }
            )

        return result

    # ── type consolidation ────────────────────────────────────────────

    # Surface forms that look like pure numbers / dates must never become a
    # person/organization, even if GLiNER mis-typed one mention.
    _NUMERIC_RE = re.compile(r"^[\d\s.,:/%+\-€$£¥]+$")
    # Full numeric date shape (DD.MM.YYYY / DD.MM.YY — the format pre-pass's
    # own DD.MM.YYYY pattern, see format_ner.py). Checked BEFORE the generic
    # digit-count heuristic below: a plain 4-digit-count check would otherwise
    # misfire on these (8 digits stripped from "01.03.2026" → falls through to
    # the bare-number "quantity" branch, discarding the correct "temporal").
    _DATE_NUMERIC_RE = re.compile(r"^\d{1,2}\.\d{1,2}\.\d{2,4}$")
    # Presence of a currency symbol means "financial", never a bare quantity
    # or an accidental 4-digit-year match (e.g. "1.200 €" strips to the
    # 4-digit string "1200", which without this check would be misread as
    # the year 1200 instead of the amount it actually is).
    _CURRENCY_SYMBOL_RE = re.compile(r"[€$£¥]")
    _DATE_WORD_RE = re.compile(
        r"\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|"
        r"january|february|march|april|june|july|august|september|"
        r"october|november|december|monday|tuesday|wednesday|thursday|"
        r"friday|saturday|sunday|\d{4})\b",
        re.IGNORECASE,
    )

    def _numeric_sanity(self, name: str) -> Optional[str]:
        """Return a forced coarse type for obviously numeric/date names, else None.

        An all-numeric token (e.g. "42", "3.14", "2026") is a `quantity`; a name
        that is a date/month/weekday ("April 2026", "Monday") is `temporal`; a
        full numeric date ("01.03.2026") is `temporal`; a number carrying a
        currency symbol ("1.200 €", "$100") is `financial`.
        """
        stripped = name.strip()
        if not stripped:
            return None
        if self._DATE_NUMERIC_RE.match(stripped):
            return "temporal"
        if self._NUMERIC_RE.match(stripped):
            if self._CURRENCY_SYMBOL_RE.search(stripped):
                return "financial"
            # bare number → quantity, unless it's a 4-digit year (→ temporal)
            digits = re.sub(r"[^\d]", "", stripped)
            if len(digits) == 4 and digits.isdigit() and 1000 <= int(digits) <= 2999:
                return "temporal"
            return "quantity"
        # contains a month/weekday/year token and little else alphabetic → temporal
        if self._DATE_WORD_RE.search(stripped):
            alpha = re.sub(r"[^a-zA-Z]", "", stripped)
            # short, date-like phrases ("April 2026", "12 May") — not free prose
            if len(alpha) <= 12:
                return "temporal"
        return None

    # Deterministic priority used ONLY to break near-ties in the bucket vote, so
    # the same surface name lands in the same bucket across separate jobs even
    # when GLiNER's per-mention scores jitter. More specific identity kinds win
    # over the deliberately-broad `technology`/`other` catch-alls. Order matters.
    _BUCKET_PRIORITY = {
        "person": 0, "organization": 1, "location": 2, "temporal": 3,
        "financial": 4, "quantity": 5, "event": 6, "work": 7, "field": 8,
        "technology": 9, "other": 10,
    }
    # Two buckets are "tied" when their scores are within this relative margin.
    _TIE_MARGIN = 0.15

    def _pick_bucket(self, bucket_scores: dict[str, float]) -> str:
        """Pick the winning coarse bucket from a score-weighted vote.

        The highest score wins outright. When the runner-up is within
        `_TIE_MARGIN` of the top, the tie is broken by `_BUCKET_PRIORITY` (then
        name) so the choice is STABLE across runs instead of flipping with score
        jitter (e.g. "Ground Control" no longer oscillates organization↔technology).
        """
        if not bucket_scores:
            return "other"
        ranked = sorted(bucket_scores.items(), key=lambda kv: (-kv[1], kv[0]))
        top_bucket, top_score = ranked[0]
        if top_score <= 0:
            return top_bucket
        # Gather everything within the tie band of the top score.
        contenders = [
            b for b, s in ranked if s >= top_score * (1.0 - self._TIE_MARGIN)
        ]
        if len(contenders) == 1:
            return contenders[0]
        return min(
            contenders,
            key=lambda b: (self._BUCKET_PRIORITY.get(b, 99), b),
        )

    def _consolidate_types(self, entities: list[dict]) -> list[dict]:
        """Force ONE stable type per surface name across all of its mentions.

        Within a single extraction job, GLiNER often labels different mentions
        of the same name with different fine types (Fjalla → human / software /
        website / …). We pick a SINGLE winning coarse `type` per (case-folded)
        surface name — by score-weighted majority vote — and rewrite every
        mention of that name to use it. The most-confident fine QID + label for
        the winning bucket are also propagated so metadata stays coherent.

        Numeric/date names are pinned to quantity/temporal regardless of vote.
        """
        if not entities:
            return entities

        # 1. Tally a score-weighted vote per surface name -> coarse bucket.
        from collections import defaultdict

        # Cython-safety: the prod build is Cython-compiled, where a `dict`
        # annotation (on a local OR a function parameter) enforces an EXACT-dict
        # check (PyDict_CheckExact) that REJECTS subclasses like `defaultdict`
        # ("Expected dict, got collections.defaultdict" — fails every job). So:
        #   * `votes` is left untyped (it's only iterated, never passed as dict), and
        #   * its INNER maps are plain dicts (defaultdict(dict)), because each inner
        #     map is handed to `_pick_bucket(bucket_scores: dict[str, float])` — a
        #     defaultdict there would trip the same exact-dict check.
        votes = defaultdict(dict)  # name -> {bucket: score} (inner = plain dict)
        # Best (highest-score) fine metadata seen for each (name, bucket).
        best_meta = {}  # (name, bucket) -> {score, fine_qid, label}

        for ent in entities:
            key = ent["text"].strip().lower()
            bucket = ent.get("coarse_type") or ent.get("type") or "other"
            score = float(ent.get("score", 0.0)) or 0.0001
            bucket_scores = votes[key]  # plain dict (no default factory → use .get)
            bucket_scores[bucket] = bucket_scores.get(bucket, 0.0) + score
            mk = (key, bucket)
            prev = best_meta.get(mk)
            if prev is None or score > prev["score"]:
                best_meta[mk] = {
                    "score": score,
                    "fine_qid": ent.get("fine_qid", "Q35120"),
                    "label": ent.get("label", bucket),
                }

        # 2. Decide the winning bucket per name.
        winner: dict[str, str] = {}
        for key, bucket_scores in votes.items():
            forced = self._numeric_sanity(key)
            if forced is not None:
                winner[key] = forced
                continue
            winner[key] = self._pick_bucket(bucket_scores)

        # 3. Rewrite every mention to its winning type + coherent fine metadata.
        for ent in entities:
            key = ent["text"].strip().lower()
            bucket = winner.get(key, ent.get("coarse_type", "other"))
            ent["type"] = bucket
            ent["coarse_type"] = bucket
            meta = best_meta.get((key, bucket))
            if meta:
                ent["fine_qid"] = meta["fine_qid"]
                ent["label"] = meta["label"]
            else:
                # winner came from numeric sanity (bucket may not be in votes);
                # give it a sensible generic fine label.
                ent.setdefault("fine_qid", "Q35120")
                ent["label"] = ent.get("label") or bucket

        return entities


# Module-level singleton
_ner_pipeline = NERPipeline()


def get_ner_pipeline() -> NERPipeline:
    return _ner_pipeline
