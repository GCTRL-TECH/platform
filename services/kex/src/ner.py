"""
NER Pipeline for KEX Service — GLiNER Zero-Shot NER
Supports unlimited entity types defined at inference time.
Uses Wikidata QID mapping for structured knowledge graph output.
"""

import logging
from typing import Optional

from . import config

logger = logging.getLogger(__name__)

# GLiNER has a practical limit on input length (~512 tokens).
# We chunk at character level and process each chunk.
_CHUNK_CHARS = 1200
_OVERLAP_CHARS = 120


class NERPipeline:
    """GLiNER-based zero-shot NER with Wikidata type mapping."""

    def __init__(self) -> None:
        self._model = None

    def _get_model(self):
        if self._model is None:
            from gliner import GLiNER
            import torch

            device = "cuda" if torch.cuda.is_available() else "cpu"
            logger.info(f"Loading GLiNER model: {config.GLINER_MODEL} on {device}")
            self._model = GLiNER.from_pretrained(config.GLINER_MODEL)
            if device == "cuda":
                self._model = self._model.to(device)
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
        threshold: float = 0.3,
    ) -> list[dict]:
        """
        Run zero-shot NER on text.

        Args:
            text: Input text
            entity_types: Custom entity type labels (uses defaults if None)
            threshold: Confidence threshold for entity detection

        Returns list of dicts:
            start, end, text, type (Wikidata QID), label, score, gliner_label
        """
        text = text.strip()
        if not text:
            return []

        labels = entity_types or config.DEFAULT_ENTITY_TYPES
        model = self._get_model()

        # GLiNER performance degrades with too many labels at once.
        # Process in label batches for accuracy, then merge results.
        # Sweet spot: ~20 labels per batch for speed/accuracy balance.
        LABEL_BATCH_SIZE = 20
        all_raw = []

        if len(labels) <= LABEL_BATCH_SIZE:
            all_raw = self._extract_with_chunking(model, text, labels, threshold)
        else:
            # Batch labels to keep GLiNER accurate
            for i in range(0, len(labels), LABEL_BATCH_SIZE):
                batch_labels = labels[i : i + LABEL_BATCH_SIZE]
                batch_entities = self._extract_with_chunking(
                    model, text, batch_labels, threshold
                )
                all_raw.extend(batch_entities)

        # Deduplicate overlapping entities (keep highest score)
        deduped = self._deduplicate(all_raw)

        # Map to Wikidata types
        return self._to_wikidata(deduped)

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
        """Run GLiNER prediction on a single chunk."""
        try:
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
        """Map GLiNER labels to Wikidata QIDs."""
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

            result.append(
                {
                    "start": ent["start"],
                    "end": ent["end"],
                    "text": ent["text"],
                    "type": qid,
                    "label": human_label,
                    "score": ent["score"],
                    "gliner_label": gliner_label,
                }
            )

        return result


# Module-level singleton
_ner_pipeline = NERPipeline()


def get_ner_pipeline() -> NERPipeline:
    return _ner_pipeline
