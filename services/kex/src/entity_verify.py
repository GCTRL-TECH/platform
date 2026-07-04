"""
Entity Verify/Retype Tier for KEX Service — OPT-IN LLM precision pass.

Measured honestly (entity_mentions readback): NER detection-recall is ~0.977
but precision is only ~0.55 — GLiNER over-extracts junk noun-phrases ("async
wrapper", "Primary Product", "Port 443", "Berlin-based") and mistypes some
mentions. This module asks the already-configured generation LLM (the SAME
model/base/kind relex.py uses) to VERIFY each GLiNER candidate — keep/drop —
and RETYPE it if the coarse bucket is wrong.

Panel-endorsed architecture: GLiNER remains the ONLY span producer (offset
fidelity). This module NEVER invents an entity or a span — it can only drop
(keep=false) or retype a candidate GLiNER already found. Start/end/score of
every kept entity are preserved byte-for-byte.

Failure-safe: any LLM/parse error returns the ORIGINAL entity list UNCHANGED
(plus report.error) — a verify failure must never cost recall.

Off by default (config.ENTITY_VERIFY_ENABLED, env KEX_ENTITY_VERIFY) — this is
an opt-in precision tier, not a default-on behavior change.

CYTHON TRAP: no local/param annotated `dict`/`list`/`set` in this module — the
prod kex build is Cython-compiled and those annotations enforce an exact-type
check (PyDict_CheckExact / PyList_CheckExact) that rejects subclasses. See
relex.py's `_GENERIC_SUFFIX_TOKENS` / `votes` comments for the same trap.
"""

import logging

from . import config, llm_client
from .relex import get_extractor

logger = logging.getLogger(__name__)

# One prompt per this many candidates — keeps each request's expected JSON
# response small enough to stay well inside a typical num_predict budget even
# for a dense document with hundreds of NER hits.
_BATCH_SIZE = 40

# Characters of surrounding context (each side) included per candidate so the
# LLM judges a bare surface name in its actual sentence, not in isolation.
_SNIPPET_RADIUS = 60

# The 10 coarse buckets (config.COARSE_TYPES) + a 1-line definition each, so
# the LLM's "corrected_type" always lands in the SAME closed vocabulary the
# rest of KEX already uses (ner.py's `_consolidate_types` / config.COARSE_MAP).
_BUCKET_DEFINITIONS = [
    ("person", "a named human being or a specific human role holder"),
    ("organization", "a company, institution, agency, team, or other collective body"),
    ("location", "a place, geographic feature, building, or physical structure"),
    ("technology", "software, hardware, a product, tool, platform, or technical system"),
    ("work", "a creative or published work (book, film, song, patent, artwork, ...)"),
    ("event", "a discrete happening (war, election, conference, historical event, ...)"),
    ("field", "an abstract concept, discipline, ideology, language, theory, or biomedical concept"),
    ("temporal", "a date, year, time period, or era"),
    ("financial", "money, currency, a security, tax, or payment instrument"),
    ("quantity", "a numeric measurement, percentage, or statistic"),
    ("other", "a genuine named entity that doesn't fit any bucket above"),
]

_VALID_TYPES = {bucket for bucket, _ in _BUCKET_DEFINITIONS}


def _bucket_block():
    return "\n".join(f"- {bucket}: {desc}" for bucket, desc in _BUCKET_DEFINITIONS)


def _clean(value):
    """Strip quotes/newlines from prompt-embedded text so a candidate's raw
    surface text or context snippet can never break the illustrative JSON
    block in the prompt (this block is prompt TEXT, not parsed — but a stray
    unescaped quote still confuses the model)."""
    return " ".join(str(value or "").replace('"', "'").split())


def _snippet(text, start, end):
    if not isinstance(start, int) or not isinstance(end, int):
        return ""
    lo = max(0, start - _SNIPPET_RADIUS)
    hi = min(len(text), end + _SNIPPET_RADIUS)
    return _clean(text[lo:hi])


def _build_prompt(batch, text):
    lines = []
    for cand in batch:
        ent = cand["entity"]
        snippet = _snippet(text, ent.get("start"), ent.get("end"))
        name = _clean(cand["name"])
        lines.append(
            f'  {{"id": {cand["id"]}, "name": "{name}", "type": "{cand["type"]}", '
            f'"context": "{snippet}"}}'
        )
    candidates_block = "\n".join(lines)
    return f"""You verify named-entity candidates extracted from a document. For EACH candidate, decide:
  - "keep": true if it is a genuine named entity (a specific person, organization, location, product/technology, creative work, event, date, amount, or standard). false if it is a generic descriptive phrase, a sentence fragment, a tool/version fragment, or a non-named concept.
  - "corrected_type": the correct coarse type from the list below if the given "type" is wrong; otherwise repeat the given "type".

Coarse types (pick ONLY from this list):
{_bucket_block()}

Rules:
- Drop generic descriptive phrases (e.g. "async wrapper", "Primary Product"), tool/version fragments (e.g. "Port 443"), and non-named descriptive concepts (e.g. "Berlin-based") — these are keep=false.
- Keep named people, organizations, locations, products, technologies, dates, amounts, and standards — these are keep=true.
- Respond for EXACTLY the candidates given below, matched by "id". Do not add or omit any.

Candidates:
[
{candidates_block}
]

Return ONLY a JSON array, one object per candidate, in this exact shape:
[{{"id": 0, "keep": true, "corrected_type": "person"}}, ...]

JSON array:"""


def verify_entities(entities, text, model, base, kind, api_key=None, min_score=0.0):
    """Verify/retype GLiNER candidates via the configured generation LLM.

    Args:
        entities: list of NER entity dicts (ner.py shape: start, end, text,
            type, coarse_type, score, gliner_label, label, ...).
        text: the full source text (used to derive context snippets).
        model/base/kind/api_key: the SAME generation runtime params the job
            already resolved for relex (relex_base, relex_model,
            generation_kind, generation_api_key) — this tier rides whatever
            runtime is configured (Ollama 7b/14b, or an OpenAI-compatible
            GPU endpoint), it never hardcodes its own model.
        min_score: entities scoring below this are never sent to the LLM and
            pass through untouched (never a recall cost). Default 0.0 = every
            entity is a verify candidate.

    Returns:
        (kept_entities, report) where kept_entities is a NEW list (original
        `entities` list/dicts are not mutated in place beyond the type/
        coarse_type fields on entities that are actually retyped) preserving
        the original relative order, and report is a plain dict:
        {verified, dropped_junk, retyped, llm_calls, salvaged, error?}.

    NEVER adds an entity the LLM didn't receive — spans are authoritative
    from GLiNER. Only drops (keep=false) or retypes. On ANY LLM/parse error,
    returns the ORIGINAL `entities` list unchanged (recall-safe).
    """
    report = {
        "verified": 0,
        "dropped_junk": 0,
        "retyped": 0,
        "llm_calls": 0,
        "salvaged": 0,
    }

    if not entities:
        return (entities, report)

    # Resolve the endpoint exactly like relex.py does (relex.py:763): a None/empty
    # `base` (the job didn't pass a per-request ollama_base — the default install)
    # falls back to config.OLLAMA_BASE. Without this, base=None reaches
    # llm_client.complete's `base.rstrip("/")` → the whole verify pass errors out
    # and (failure-safe) drops nothing.
    base = (base or "").strip() or config.OLLAMA_BASE
    model = model or config.RELEX_MODEL

    # `final[idx]` holds the (possibly retyped) entity, or None once dropped.
    # Entities below min_score are filled in immediately and never touch the LLM.
    final = [None] * len(entities)
    candidates = []
    for idx, ent in enumerate(entities):
        score = ent.get("score", 0.0) or 0.0
        if score < min_score:
            final[idx] = ent
            continue
        coarse = ent.get("coarse_type") or ent.get("type") or "other"
        candidates.append({
            "id": idx,
            "name": ent.get("text") or "",
            "type": coarse if coarse in _VALID_TYPES else "other",
            "entity": ent,
        })

    if not candidates:
        return (entities, report)

    parser = get_extractor()  # reuse RelationExtractor's JSON-parse + truncation-salvage helper

    decisions = {}
    try:
        for i in range(0, len(candidates), _BATCH_SIZE):
            batch = candidates[i:i + _BATCH_SIZE]
            prompt = _build_prompt(batch, text)
            raw = llm_client.complete(
                prompt, model, base, kind,
                api_key=api_key,
                options={"temperature": 0.0},
                timeout=180,
            )
            report["llm_calls"] += 1
            parsed = parser._parse_json_array(raw)
            report["salvaged"] += parser.last_salvaged_count
            for item in parsed:
                if not isinstance(item, dict):
                    continue
                cid = item.get("id")
                if cid is None:
                    continue
                keep_val = item.get("keep")
                ctype = item.get("corrected_type") or item.get("type")
                decisions[cid] = {
                    "keep": bool(keep_val) if keep_val is not None else True,
                    "type": ctype if ctype in _VALID_TYPES else None,
                }
    except Exception as exc:
        logger.warning(
            "entity_verify: LLM call failed — keeping original %d entities unchanged: %s",
            len(entities), exc,
        )
        report["error"] = str(exc)
        return (entities, report)

    for cand in candidates:
        idx = cand["id"]
        ent = cand["entity"]
        decision = decisions.get(idx)
        if decision is None:
            # No decision came back for this candidate — recall-safe default: keep as-is.
            final[idx] = ent
            continue
        report["verified"] += 1
        if not decision["keep"]:
            report["dropped_junk"] += 1
            final[idx] = None
            continue
        new_type = decision["type"]
        old_type = ent.get("coarse_type") or ent.get("type")
        if new_type and new_type != old_type:
            ent["type"] = new_type
            ent["coarse_type"] = new_type
            report["retyped"] += 1
        final[idx] = ent

    kept_entities = [e for e in final if e is not None]
    return (kept_entities, report)
