"""
PII detector for GCTRL KEX pipeline.

Uses presidio-analyzer for entity detection. Designed to run before NER extraction
so PII is either flagged (for manual review) or redacted (for auto-redact mode).

Detection entities: PERSON, EMAIL_ADDRESS, PHONE_NUMBER, IBAN_CODE, LOCATION, NRP
(NRP = German Personalausweis / National Registration Pattern)

Findings are stored as { type, count } — never the actual values, only occurrence counts.
This is intentional: DSGVO compliance requires that PII is not persisted.
"""

from typing import Optional

try:
    from presidio_analyzer import AnalyzerEngine
    _engine = AnalyzerEngine()
    _PRESIDIO_AVAILABLE = True
except ImportError:
    _engine = None
    _PRESIDIO_AVAILABLE = False

DETECTED_ENTITIES = [
    "PERSON",
    "EMAIL_ADDRESS",
    "PHONE_NUMBER",
    "IBAN_CODE",
    "LOCATION",
    "NRP",
]


def detect_pii(text: str, language: str = "en") -> dict:
    """Detect PII in text. Returns { findings: [{type, count}], has_pii: bool, total_count: int }.
    If presidio is not installed, returns empty findings with a 'presidio_unavailable' flag.
    """
    if not _PRESIDIO_AVAILABLE or not _engine:
        return {"findings": [], "has_pii": False, "total_count": 0, "presidio_unavailable": True}

    try:
        results = _engine.analyze(text=text, entities=DETECTED_ENTITIES, language=language)
    except Exception:
        # Fallback: try English if original language fails
        try:
            results = _engine.analyze(text=text, entities=DETECTED_ENTITIES, language="en")
        except Exception:
            return {"findings": [], "has_pii": False, "total_count": 0}

    counts: dict[str, int] = {}
    for r in results:
        counts[r.entity_type] = counts.get(r.entity_type, 0) + 1

    findings = [{"type": t, "count": c} for t, c in sorted(counts.items())]
    total = sum(counts.values())
    return {"findings": findings, "has_pii": total > 0, "total_count": total}


def redact_pii(text: str, language: str = "en") -> tuple[str, dict]:
    """Redact PII from text. Returns (redacted_text, findings_summary).
    Replaces each detected PII span with [REDACTED:TYPE].
    If presidio is not installed, returns original text unchanged.
    """
    if not _PRESIDIO_AVAILABLE or not _engine:
        return text, {"findings": [], "has_pii": False, "total_count": 0, "presidio_unavailable": True}

    try:
        results = _engine.analyze(text=text, entities=DETECTED_ENTITIES, language=language)
    except Exception:
        try:
            results = _engine.analyze(text=text, entities=DETECTED_ENTITIES, language="en")
        except Exception:
            return text, {"findings": [], "has_pii": False, "total_count": 0}

    # Sort by start position descending so replacements don't shift later indices
    results_sorted = sorted(results, key=lambda r: r.start, reverse=True)
    redacted = text
    counts: dict[str, int] = {}
    for r in results_sorted:
        redacted = redacted[:r.start] + f"[REDACTED:{r.entity_type}]" + redacted[r.end:]
        counts[r.entity_type] = counts.get(r.entity_type, 0) + 1

    findings = [{"type": t, "count": c} for t, c in sorted(counts.items())]
    total = sum(counts.values())
    return redacted, {"findings": findings, "has_pii": total > 0, "total_count": total}
