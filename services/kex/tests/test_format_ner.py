"""Tests for the format-based NER pre-pass (German/EN temporal + financial +
percentage regex detection) and the NER_THRESHOLD env knob.

Covers:
  1. detect_format_entities on a German block -> correct spans + types
  2. detect_format_entities on an English block -> correct spans + types
  3. No-FP check: plain prose numbers ("12 engineers") yield nothing
  4. German + English month name coverage (full + abbreviated)
  5. Magnitude words (Mio./Mrd./Tsd./M/K/bn)
  6. NER_THRESHOLD env: default 0.3, env override, per-call override wins
  7. Merge into NERPipeline.extract_entities (GLiNER mocked): regex entities
     appear in output, and dedup removes an overlapping GLiNER duplicate.
"""

import importlib

import pytest

from src.format_ner import detect_format_entities
from src import config as config_module


# ── helpers ──────────────────────────────────────────────────────────────────

def _find(entities, substring):
    """Return the single entity whose text equals `substring`, or None."""
    for e in entities:
        if e["text"] == substring:
            return e
    return None


# ── 1. German block ──────────────────────────────────────────────────────────

class TestGermanBlock:
    TEXT = (
        "Rechnungsdatum: 01.03.2026. Lieferung am 12. März 2026. "
        "Gesamtbetrag: EUR 92.701,00. Rabatt: 19 %. "
        "Umsatz im 1. Quartal 2026 betrug 3,5 Mio. EUR."
    )

    def test_dd_mm_yyyy(self):
        ents = detect_format_entities(self.TEXT)
        e = _find(ents, "01.03.2026")
        assert e is not None
        assert e["type"] == "temporal"
        assert e["score"] == 0.95
        assert e["source"] == "regex"
        assert self.TEXT[e["start"]:e["end"]] == "01.03.2026"

    def test_long_form_german_date(self):
        ents = detect_format_entities(self.TEXT)
        e = _find(ents, "12. März 2026")
        assert e is not None
        assert e["type"] == "temporal"
        assert self.TEXT[e["start"]:e["end"]] == "12. März 2026"

    def test_currency_amount_with_german_separators(self):
        ents = detect_format_entities(self.TEXT)
        e = _find(ents, "EUR 92.701,00")
        assert e is not None
        assert e["type"] == "financial"
        assert self.TEXT[e["start"]:e["end"]] == "EUR 92.701,00"

    def test_percentage(self):
        ents = detect_format_entities(self.TEXT)
        e = _find(ents, "19 %")
        assert e is not None
        assert e["type"] == "quantity"

    def test_quarter(self):
        ents = detect_format_entities(self.TEXT)
        e = _find(ents, "1. Quartal 2026")
        assert e is not None
        assert e["type"] == "temporal"

    def test_magnitude_word_mio(self):
        ents = detect_format_entities(self.TEXT)
        e = _find(ents, "3,5 Mio. EUR")
        assert e is not None
        assert e["type"] == "financial"


# ── 2. English block ─────────────────────────────────────────────────────────

class TestEnglishBlock:
    TEXT = (
        "Invoice date: March 12, 2026. Total: USD 1,200.00. "
        "Discount: 19.5%. Revenue in Q1 2026 was $2.4M."
    )

    def test_long_form_english_date(self):
        ents = detect_format_entities(self.TEXT)
        e = _find(ents, "March 12, 2026")
        assert e is not None
        assert e["type"] == "temporal"

    def test_currency_amount_with_english_separators(self):
        ents = detect_format_entities(self.TEXT)
        e = _find(ents, "USD 1,200.00")
        assert e is not None
        assert e["type"] == "financial"

    def test_percentage_decimal(self):
        ents = detect_format_entities(self.TEXT)
        e = _find(ents, "19.5%")
        assert e is not None
        assert e["type"] == "quantity"

    def test_quarter_english(self):
        ents = detect_format_entities(self.TEXT)
        e = _find(ents, "Q1 2026")
        assert e is not None
        assert e["type"] == "temporal"

    def test_magnitude_word_m_symbol(self):
        ents = detect_format_entities(self.TEXT)
        e = _find(ents, "$2.4M")
        assert e is not None
        assert e["type"] == "financial"


# ── 3. No false-positive flood ───────────────────────────────────────────────

class TestNoFalsePositives:
    def test_plain_prose_numbers_yield_nothing(self):
        text = "We hired 12 engineers this quarter and shipped 3 releases."
        ents = detect_format_entities(text)
        assert ents == []

    def test_phone_and_id_numbers_yield_nothing(self):
        text = "Phone: 030-12345678, ID 2024, order #1200 shipped."
        ents = detect_format_entities(text)
        assert ents == []

    def test_iso_date_still_detected_in_prose(self):
        # sanity: prose doesn't suppress genuine ISO dates
        text = "Meeting scheduled for 2026-03-01 to discuss headcount."
        ents = detect_format_entities(text)
        assert _find(ents, "2026-03-01") is not None


# ── 4. Month name coverage (full + abbreviated, DE + EN) ────────────────────

class TestMonthNames:
    @pytest.mark.parametrize("text,expected", [
        ("Termin im Jan. 2026.", "Jan. 2026"),
        ("Termin im Januar 2026.", "Januar 2026"),
        ("Termin im Okt. 2025.", "Okt. 2025"),
        ("Deadline in Oct. 2025.", "Oct. 2025"),
        ("Deadline in October 2025.", "October 2025"),
        ("Report for Sept. 2025 is due.", "Sept. 2025"),
        ("Report for Sep. 2025 is due.", "Sep. 2025"),
    ])
    def test_bare_month_year(self, text, expected):
        ents = detect_format_entities(text)
        e = _find(ents, expected)
        assert e is not None, f"expected {expected!r} in {ents}"
        assert e["type"] == "temporal"


# ── 5. Magnitude words ───────────────────────────────────────────────────────

class TestMagnitudeWords:
    @pytest.mark.parametrize("text,expected", [
        ("Fund size: 1,2 Mrd. € total.", "1,2 Mrd. €"),
        ("Budget: 500 Tsd. EUR reserved.", "500 Tsd. EUR"),
        ("Valuation reached $3bn quickly.", "$3bn"),
        ("Market cap of 2K USD is tiny.", "2K USD"),
    ])
    def test_magnitude_word_detected(self, text, expected):
        ents = detect_format_entities(text)
        e = _find(ents, expected)
        assert e is not None, f"expected {expected!r} in {ents}"
        assert e["type"] == "financial"


# ── 6. NER_THRESHOLD env knob ────────────────────────────────────────────────

class TestNerThresholdEnv:
    def teardown_method(self, method):
        # Always leave config back at its unset-env default for other tests.
        import os
        os.environ.pop("NER_THRESHOLD", None)
        importlib.reload(config_module)

    def test_default_is_point_three(self, monkeypatch):
        monkeypatch.delenv("NER_THRESHOLD", raising=False)
        importlib.reload(config_module)
        assert config_module.NER_THRESHOLD == 0.3

    def test_env_override_respected(self, monkeypatch):
        monkeypatch.setenv("NER_THRESHOLD", "0.55")
        importlib.reload(config_module)
        assert config_module.NER_THRESHOLD == 0.55

    def test_extract_entities_resolves_none_to_config_threshold(self, monkeypatch):
        """extract_entities(threshold=None) must use config.NER_THRESHOLD,
        and an explicit per-call threshold must still override it."""
        monkeypatch.setenv("NER_THRESHOLD", "0.42")
        importlib.reload(config_module)

        # Reimport ner AFTER reloading config so its `from . import config`
        # binding sees the same (already-reloaded) module object — reload
        # mutates the module in place, so this isn't strictly required, but
        # keeps the test explicit about what's being exercised.
        from src import ner as ner_module
        importlib.reload(ner_module)

        pipeline = ner_module.NERPipeline()
        seen_thresholds = []

        def fake_predict_entities(text, labels, threshold):
            seen_thresholds.append(threshold)
            return []

        fake_model = type("FakeModel", (), {"predict_entities": staticmethod(fake_predict_entities)})()
        monkeypatch.setattr(pipeline, "_get_model", lambda: fake_model)

        # No threshold given -> should resolve to config.NER_THRESHOLD (0.42)
        pipeline.extract_entities("Some short text.", entity_types=["date"], threshold=None)
        assert seen_thresholds[-1] == 0.42

        # Explicit per-call threshold must override the env-configured default
        pipeline.extract_entities("Some short text.", entity_types=["date"], threshold=0.9)
        assert seen_thresholds[-1] == 0.9


# ── 7. Merge into NERPipeline.extract_entities (GLiNER mocked) ──────────────

class TestFormatNerMergeIntoPipeline:
    def _make_pipeline_with_fake_gliner(self, monkeypatch, gliner_entities):
        from src import ner as ner_module

        pipeline = ner_module.NERPipeline()

        def fake_predict_entities(text, labels, threshold):
            return gliner_entities

        fake_model = type("FakeModel", (), {"predict_entities": staticmethod(fake_predict_entities)})()
        monkeypatch.setattr(pipeline, "_get_model", lambda: fake_model)
        return pipeline

    def test_regex_entity_appears_when_gliner_misses_it(self, monkeypatch):
        text = "Gesamtbetrag: EUR 92.701,00 wurde bezahlt."
        pipeline = self._make_pipeline_with_fake_gliner(monkeypatch, gliner_entities=[])

        entities = pipeline.extract_entities(text, entity_types=["date"])

        matches = [e for e in entities if e["text"] == "EUR 92.701,00"]
        assert len(matches) == 1
        assert matches[0]["type"] == "financial"

    def test_dedup_removes_overlapping_gliner_date_duplicate(self, monkeypatch):
        text = "Rechnungsdatum: 01.03.2026 sonst nichts."
        # GLiNER "finds" the same date span but with a lower score and its
        # own (weaker) label — the regex hit (score 0.95) must win and the
        # GLiNER duplicate must be dropped by the existing span-overlap dedup.
        gliner_hit = {
            "start": text.index("01.03.2026"),
            "end": text.index("01.03.2026") + len("01.03.2026"),
            "text": "01.03.2026",
            "label": "date",
            "score": 0.5,
        }
        pipeline = self._make_pipeline_with_fake_gliner(monkeypatch, gliner_entities=[gliner_hit])

        entities = pipeline.extract_entities(text, entity_types=["date"])

        matches = [e for e in entities if e["text"] == "01.03.2026"]
        assert len(matches) == 1, f"expected exactly one deduped entity, got {matches}"
        assert matches[0]["score"] == 0.95
        assert matches[0]["type"] == "temporal"

    def test_format_ner_disabled_via_config_flag(self, monkeypatch):
        from src import ner as ner_module

        monkeypatch.setattr(config_module, "FORMAT_NER_ENABLED", False)
        pipeline = self._make_pipeline_with_fake_gliner(monkeypatch, gliner_entities=[])

        text = "Gesamtbetrag: EUR 92.701,00 wurde bezahlt."
        entities = pipeline.extract_entities(text, entity_types=["date"])

        assert entities == []
