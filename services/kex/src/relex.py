"""
Relation Extraction for KEX Service.

Uses a local Ollama LLM to extract DIRECTED, typed relations between entities,
then runs a deterministic validation layer. Designed for trustworthy output:
  * CLOSED relation vocabulary (relvocab.RELATIONS) — the LLM may only pick from
    ~32 canonical relations, killing free-form garbage like
    `is_used_as_second_brain_for`.
  * Direction-enforced prompt with few-shot examples — fixes the inversion bug
    (e.g. "Bigerl is CEO of Tentris" -> (Bigerl, ceo_of, Tentris), not the flip).
  * Deterministic post-LLM validation — both ends must be known entities, no
    self-loops, relation normalized to canonical (out-of-vocab dropped), coarse
    type-compatibility check that REPAIRS obvious direction inversions or drops
    them, and dedupe.

Fully LOCAL: talks only to Ollama at config.OLLAMA_BASE. Gracefully degrades to
an empty list when Ollama is unavailable or the response can't be parsed.

The winning recipe (model + prompt + validation) was selected via the offline
eval harness in bench/kex/ against a hand-labeled gold set. See bench/kex/REPORT.md.
Relation F1 on the gold set: ~0.45 (old free-form llama3.2) -> ~0.86 (this).
"""

import json
import logging
import re
import threading
from typing import Optional

import requests

from . import config
from . import llm_client
from . import relvocab
from .chunking import _split_into_sentences

logger = logging.getLogger(__name__)

# Cap the entity list fed to the LLM per window. A document can produce hundreds
# of NER entities (a CV yielded 416); dumping all of them bloats the prompt and
# buries the few that actually participate in relations, so the model returns
# almost nothing. The KG builder still stores ALL entities — this cap only bounds
# the relation-extraction prompt.
_MAX_ENTITIES = 80

# Window overlap in characters for the windowed relex pass. A small overlap
# ensures a relation that straddles two window boundaries is still captured.
_WINDOW_OVERLAP = 200


def _split_windows(text: str, window_chars: int, overlap: int = _WINDOW_OVERLAP) -> list[tuple[str, int, int]]:
    """Split *text* into sentence-snapped windows of at most *window_chars* chars
    with *overlap* characters of trailing context carried into the next window.

    Returns a list of (window_text, start_offset, end_offset) triples.

    The splitting logic reuses `_split_into_sentences` from chunking.py so the
    boundary-snap behaviour is identical to the chunker — no new dependency.
    """
    if len(text) <= window_chars:
        return [(text, 0, len(text))]

    sentences = _split_into_sentences(text)

    # Pre-compute absolute byte offsets for each sentence (same approach as TextChunker).
    sentence_positions = []
    pos = 0
    for sent in sentences:
        idx = text.find(sent, pos)
        if idx == -1:
            idx = pos
        sentence_positions.append((idx, idx + len(sent)))
        pos = idx + len(sent)

    windows = []
    i = 0
    n = len(sentences)

    while i < n:
        # Build a window starting at sentence i.
        window_sents = []
        window_len = 0
        j = i
        while j < n:
            s = sentences[j]
            if window_len + len(s) > window_chars and window_len > 0:
                break
            window_sents.append(s)
            window_len += len(s)
            j += 1

        # j now points to the first sentence that didn't fit (or == n).
        win_start = sentence_positions[i][0]
        win_end = sentence_positions[j - 1][1]
        windows.append(("".join(window_sents), win_start, win_end))

        if j >= n:
            break

        # Advance i by stepping back into the overlap region so ~overlap chars
        # of context are shared with the next window.
        overlap_len = 0
        next_i = j
        k = j - 1
        while k >= i and overlap_len < overlap:
            overlap_len += len(sentences[k])
            next_i = k
            k -= 1
        # Ensure we always advance to avoid an infinite loop on a single huge sentence.
        if next_i <= i:
            next_i = j
        i = next_i

    return windows


def _build_prompt(text: str, entity_lines: str) -> str:
    """Direction-enforced, closed-vocabulary, thorough prompt (variant 'v4')."""
    vocab_block = relvocab.vocab_prompt_block()
    return f"""You extract directed relationships from text. The HEAD is the subject (the doer); the TAIL is the object. Direction matters — who performs or holds the relation is the HEAD.

Allowed relations (pick ONLY from this list, HEAD then TAIL):
{vocab_block}

Direction examples (study these carefully):
- "Alice is the CEO of Acme"   -> {{"head":"Alice","relation":"ceo_of","tail":"Acme"}}
- "Acme was founded by Alice"  -> {{"head":"Alice","relation":"founded","tail":"Acme"}}  (person is head)
- "Bob founded Acme"           -> {{"head":"Bob","relation":"founded","tail":"Acme"}}
- "Beta is a module of Gamma"  -> {{"head":"Beta","relation":"part_of","tail":"Gamma"}}
- "Gamma uses Redis"           -> {{"head":"Gamma","relation":"uses","tail":"Redis"}}
- "Carol uses a tool"          -> {{"head":"Carol","relation":"uses","tail":"tool"}}
- "Delta calls a service"      -> {{"head":"Delta","relation":"calls","tail":"service"}}

CV / résumé / profile examples (a document describing ONE person's facts — pull
out the person's employment, education, role, languages, skills, origin):
- "Experience: Senior Developer at Acme (2020–2023)" -> [{{"head":"Eve","relation":"worked_at","tail":"Acme"}}, {{"head":"Eve","relation":"has_role","tail":"Senior Developer"}}]
- "Education: BSc Computer Science, TU Berlin"        -> [{{"head":"Eve","relation":"studied_at","tail":"TU Berlin"}}, {{"head":"Eve","relation":"has_degree","tail":"BSc Computer Science"}}]
- "Languages: German, English, Spanish"              -> [{{"head":"Eve","relation":"speaks","tail":"German"}}, {{"head":"Eve","relation":"speaks","tail":"English"}}, {{"head":"Eve","relation":"speaks","tail":"Spanish"}}]
- "Skills: Python, Kubernetes, leadership"           -> [{{"head":"Eve","relation":"has_skill","tail":"Python"}}, {{"head":"Eve","relation":"has_skill","tail":"Kubernetes"}}, {{"head":"Eve","relation":"has_skill","tail":"leadership"}}]
- "Place of birth: Wiesbaden, Germany"               -> {{"head":"Eve","relation":"born_in","tail":"Wiesbaden"}}
(In a CV the person is almost always the HEAD. When a section lists items under
the person — languages, skills, employers, schools, degrees — emit ONE relation
per item, all with that person as head.)

Text:
\"\"\"
{text}
\"\"\"

Entities (use these EXACT surface forms for head and tail):
{entity_lines}

Rules:
- Be THOROUGH: extract EVERY relationship explicitly stated in the text, including simple "X uses Y", "X develops Y", "X is part of Y" facts. Do not skip obvious ones.
- head and tail must both be in the entity list, and must be different.
- Use ONLY a relation from the allowed list; if none fits a pair, skip that pair (never invent a name).
- Keep direction correct.
- Return ONLY a JSON array of objects with keys "head", "relation", "tail". No prose.

JSON array:"""


def _build_gapfill_prompt(text: str, entity_lines: str, isolated_names: list[str]) -> str:
    """Focused SECOND-pass prompt: the first pass left these entities with NO
    relations even though they appear in the text. Concentrate the model's attention
    on them so the per-document graph comes out connected instead of orphaned."""
    vocab_block = relvocab.vocab_prompt_block()
    iso = "\n".join(f"  - {n}" for n in isolated_names)
    return f"""You extract directed relationships from text. The HEAD is the subject (the doer); the TAIL is the object. Direction matters.

FOCUS — these entities appear in the text but currently have NO relationship. Re-read the text carefully and extract EVERY relationship that involves each of them (as HEAD or TAIL). Look hard for employment, job role, who-reports-to-whom, team/membership, location, ownership, part-of, who-uses/builds-what, authorship, and family/social ties. Do not stop at the obvious — connect each listed entity to whatever the text says about it.

Entities still missing relations:
{iso}

Allowed relations (pick ONLY from this list, HEAD then TAIL):
{vocab_block}

Text:
\"\"\"
{text}
\"\"\"

All entities (use these EXACT surface forms for head and tail):
{entity_lines}

Rules:
- head and tail must both be in the entity list, and must be different.
- Use ONLY a relation from the allowed list; if none fits a pair, skip it (never invent a name).
- Keep direction correct (who performs/holds the relation is the HEAD).
- Return ONLY a JSON array of objects with keys "head", "relation", "tail". No prose.

JSON array:"""


class RelationExtractor:
    """Ollama-backed relation extractor with closed vocab + validation."""

    def __init__(self) -> None:
        # Set by the most recent extract_relations() call so the pipeline can
        # tell "the LLM was unavailable" apart from "the LLM ran but found no
        # relations". When degraded, `last_degraded_reason` carries a concise,
        # human-readable message for the job/dashboard.
        self.last_degraded: bool = False
        self.last_degraded_reason: Optional[str] = None

    def extract_relations(
        self,
        text: str,
        entities: list[dict],
        ollama_base: Optional[str] = None,
        model: Optional[str] = None,
        kind: str = "ollama",
        api_key: Optional[str] = None,
    ) -> tuple:
        """
        Extract relations from text given a list of entity dicts.

        Returns (relations, extraction_report) where:
          - relations is a list[dict]: {head, type, tail, confidence}
          - extraction_report is a plain dict with per-job audit counters

        `ollama_base` is an optional per-job override for the Ollama endpoint
        (the owner's Settings → Infrastructure base URL, passed through by the
        API). When None/empty the module-wide `config.OLLAMA_BASE` is used, so the
        default install is unchanged.

        Each relation dict: { head: str, type: str, tail: str, confidence: float }
        where `type` is a CANONICAL relation from relvocab.RELATIONS (`type` key
        kept for backward compatibility with the KG builder which reads
        `relation["type"]`). `confidence` is the per-triple trust score (0..1)
        the memory layer (A4 heat/trust) reads: ~0.9 for a clean, in-vocab,
        type-checked triple; lower (~0.6) when validation had to repair the
        direction or normalize the relation surface form.

        On any failure, returns ([], report) — never raises (graceful degradation).
        When the failure is the LLM being UNAVAILABLE (connection error / timeout /
        5xx), `self.last_degraded` is set True with a human-readable
        `self.last_degraded_reason` so the pipeline can mark the job as a
        successful-but-degraded extraction (entities only, no relations) instead
        of failing the whole job.
        """
        # Reset degradation state for this run.
        self.last_degraded = False
        self.last_degraded_reason = None

        # Report skeleton — all counters start at 0.
        window_chars = getattr(config, "RELEX_WINDOW_CHARS", 6000)
        max_windows = getattr(config, "RELEX_MAX_WINDOWS", 8)
        min_confidence = getattr(config, "RELEX_MIN_CONFIDENCE", 0.0)

        report_windows = 0
        report_truncated = False
        report_entities_prompted = 0
        report_relations_raw = 0
        report_relations_after_validation = 0
        report_dropped_out_of_vocab = 0
        report_dropped_type_incompatible = 0
        report_dropped_below_confidence = 0
        report_repaired_direction_flipped = 0
        report_repaired_normalized = 0
        report_gapfill_added = 0

        def _make_report(rels_after_conf):
            return {
                "windows": report_windows,
                "window_chars": window_chars,
                "text_chars": len(text),
                "truncated_windows": report_truncated,
                "entities_total": len(entities),
                "entities_prompted": report_entities_prompted,
                "relations_raw": report_relations_raw,
                "relations_after_validation": report_relations_after_validation,
                "dropped": {
                    "out_of_vocab": report_dropped_out_of_vocab,
                    "type_incompatible": report_dropped_type_incompatible,
                    "below_confidence": report_dropped_below_confidence,
                },
                "repaired": {
                    "direction_flipped": report_repaired_direction_flipped,
                    "normalized": report_repaired_normalized,
                },
                "gapfill_added": report_gapfill_added,
            }

        if not entities or len(entities) < 2:
            return ([], _make_report([]))

        # Split the FULL text into sentence-snapped windows.
        windows = _split_windows(text, window_chars)
        if len(windows) > max_windows:
            n_total = len(windows)
            windows = windows[:max_windows]
            report_truncated = True
            skipped_frac = (n_total - max_windows) / n_total
            logger.warning(
                "RelEx: doc needs %d windows but cap is %d — keeping first %d "
                "(%.0f%% of text skipped). Raise KEX_RELEX_MAX_WINDOWS to cover more.",
                n_total, max_windows, max_windows, skipped_frac * 100,
            )

        report_windows = len(windows)

        # Per-window extraction: merge triples across windows keeping MAX confidence.
        merged = {}  # key (head_lower, type, tail_lower) -> relation dict

        first_window_text = windows[0][0] if windows else ""

        for win_text, win_start, win_end in windows:
            # Filter entities to those whose span falls inside this window.
            # Entities without offsets (no start/end) go to every window.
            win_entities = []
            for ent in entities:
                ent_start = ent.get("start")
                ent_end = ent.get("end")
                if ent_start is None or ent_end is None:
                    win_entities.append(ent)
                elif ent_start < win_end and ent_end > win_start:
                    win_entities.append(ent)

            if len(win_entities) < 2:
                continue

            prompt_entities = self._select_prompt_entities(win_entities, win_text)
            report_entities_prompted += len(prompt_entities)
            entity_lines = self._format_entity_list(prompt_entities)
            prompt = _build_prompt(win_text, entity_lines)

            raw_response = self._call_ollama(
                prompt, ollama_base=ollama_base, model=model, kind=kind, api_key=api_key
            )
            if raw_response is None:
                # _call_ollama already recorded the reason on self.last_degraded_*.
                # Continue to next window rather than aborting completely.
                if report_windows == 1:
                    # Single-window, can't recover.
                    return ([], _make_report([]))
                continue

            try:
                parsed = self._parse_json_array(raw_response)
                report_relations_raw += len(parsed)
                validated, cnt_oov, cnt_type, cnt_flip, cnt_norm = self._validate_counted(
                    parsed, entities
                )
                report_dropped_out_of_vocab += cnt_oov
                report_dropped_type_incompatible += cnt_type
                report_repaired_direction_flipped += cnt_flip
                report_repaired_normalized += cnt_norm
            except Exception as exc:
                logger.warning(f"Relation parse/validation failed (non-fatal): {exc}")
                if report_windows == 1:
                    self.last_degraded = True
                    self.last_degraded_reason = (
                        "Relation extraction skipped (LLM response could not be parsed)."
                    )
                    return ([], _make_report([]))
                continue

            # Merge: keep the triple with MAX confidence on collision.
            for r in validated:
                key = (r["head"].lower(), r["type"], r["tail"].lower())
                existing = merged.get(key)
                if existing is None or r["confidence"] > existing["confidence"]:
                    merged[key] = r

        relations = list(merged.values())
        report_relations_after_validation = len(relations)

        # ── Recursive gap-fill over the first window's text (isolated entities) ──
        if getattr(config, "RELEX_GAPFILL_ENABLED", False):
            # For gap-fill, use the first window text for global isolated entities.
            # For entities whose span lies in a later window, run gap-fill against
            # that window's text. Keep it simple: one gap-fill pass per window
            # for isolated entities in that window.
            before_gapfill = len(relations)
            for win_text, win_start, win_end in windows:
                win_entities = []
                for ent in entities:
                    ent_start = ent.get("start")
                    ent_end = ent.get("end")
                    if ent_start is None or ent_end is None:
                        win_entities.append(ent)
                    elif ent_start < win_end and ent_end > win_start:
                        win_entities.append(ent)
                if len(win_entities) < 2:
                    continue
                prompt_entities_gf = self._select_prompt_entities(win_entities, win_text)
                new_rels = self._gap_fill(
                    win_text, entities, prompt_entities_gf, relations,
                    ollama_base, model, kind, api_key,
                )
                # Merge any new gap-fill triples into `relations`.
                existing_keys = {(r["head"].lower(), r["type"], r["tail"].lower()) for r in relations}
                added = 0
                for r in new_rels:
                    key = (r["head"].lower(), r["type"], r["tail"].lower())
                    if key not in existing_keys:
                        existing_keys.add(key)
                        relations.append(r)
                        added += 1
                if added > 0:
                    logger.info("RelEx gap-fill window [%d:%d]: +%d relations", win_start, win_end, added)
            report_gapfill_added = len(relations) - before_gapfill

        # Apply min-confidence gate.
        if min_confidence > 0.0:
            kept = []
            for r in relations:
                if r.get("confidence", 0.0) >= min_confidence:
                    kept.append(r)
                else:
                    report_dropped_below_confidence += 1
            relations = kept

        return (relations, _make_report(relations))

    # ── internal helpers ──────────────────────────────────────────────

    # Entity coarse types that should NOT force a relation when isolated — a bare
    # date / number / quantity legitimately stands alone, so don't burn a gap-fill
    # pass chasing relations for it (avoids spurious edges + wasted LLM calls).
    _ISOLATED_SKIP_LABELS = {
        "temporal", "date", "time", "number", "cardinal", "ordinal", "percent",
        "money", "financial", "quantity", "duration", "age", "other",
    }

    def _gap_fill(
        self,
        text: str,
        entities: list[dict],
        prompt_entities: list[dict],
        relations: list[dict],
        ollama_base: Optional[str],
        model: Optional[str],
        kind: str = "ollama",
        api_key: Optional[str] = None,
    ) -> list[dict]:
        """Up to RELEX_GAPFILL_MAX_PASSES focused re-extractions targeting entities
        that appear in the text but ended up in NO relation. Each pass adds only
        deduped, validated triples and stops early when a pass finds nothing new."""
        max_passes = max(0, int(getattr(config, "RELEX_GAPFILL_MAX_PASSES", 0)))
        entity_lines = self._format_entity_list(prompt_entities)
        for _pass in range(max_passes):
            connected = set()
            for r in relations:
                connected.add(str(r.get("head", "")).lower())
                connected.add(str(r.get("tail", "")).lower())
            isolated_names: list[str] = []
            seen: set[str] = set()
            for ent in prompt_entities:
                surf = (ent.get("text") or "").strip()
                if not surf:
                    continue
                low = surf.lower()
                if low in connected or low in seen:
                    continue
                if (ent.get("label") or "entity").lower() in self._ISOLATED_SKIP_LABELS:
                    continue
                isolated_names.append(surf)
                seen.add(low)
            if not isolated_names:
                break  # everything important is connected — done

            gap_prompt = _build_gapfill_prompt(text, entity_lines, isolated_names)
            raw = self._call_ollama(
                gap_prompt, ollama_base=ollama_base, model=model, kind=kind, api_key=api_key
            )
            if raw is None:
                break  # LLM degraded mid-cycle — keep what we have, never fail
            try:
                new_rels = self._validate(self._parse_json_array(raw), entities)
            except Exception:
                break

            existing = {(r["head"], r["type"], r["tail"]) for r in relations}
            added = 0
            for r in new_rels:
                key = (r.get("head"), r.get("type"), r.get("tail"))
                if key not in existing:
                    existing.add(key)
                    relations.append(r)
                    added += 1
            logger.info(
                "RelEx gap-fill pass %d: %d isolated → +%d relations",
                _pass + 1, len(isolated_names), added,
            )
            if added == 0:
                break  # converged — no new relations this pass
        return relations

    def _select_prompt_entities(self, entities: list[dict], text: str) -> list[dict]:
        """Pick the most relation-relevant entities to put in the prompt.

        Entities whose surface form occurs in the text window go first (they can
        actually be related to something the model is reading), then the rest,
        capped at _MAX_ENTITIES. Order within each group is preserved (NER order
        ≈ document order). Validation still runs against the full entity set.
        """
        if len(entities) <= _MAX_ENTITIES:
            return entities
        low_text = text.lower()
        in_text: list[dict] = []
        rest: list[dict] = []
        for ent in entities:
            surf = (ent.get("text") or "").strip()
            if surf and surf.lower() in low_text:
                in_text.append(ent)
            else:
                rest.append(ent)
        selected = in_text[:_MAX_ENTITIES]
        if len(selected) < _MAX_ENTITIES:
            selected += rest[: _MAX_ENTITIES - len(selected)]
        return selected

    def _format_entity_list(self, entities: list[dict]) -> str:
        lines: list[str] = []
        seen: set[str] = set()
        for ent in entities:
            surface = ent.get("text", "").strip()
            label = ent.get("label", "entity")
            if surface and surface.lower() not in seen:
                lines.append(f"  - {surface} ({label})")
                seen.add(surface.lower())
        return "\n".join(lines)

    def _call_ollama(
        self,
        prompt: str,
        ollama_base: Optional[str] = None,
        model: Optional[str] = None,
        kind: str = "ollama",
        api_key: Optional[str] = None,
    ) -> Optional[str]:
        """Call the LLM with SELF-HEALING model provisioning (Ollama) or direct
        passthrough (OpenAI-compatible).

        For kind=="ollama" the full self-healing guarantee is preserved:
          1. primary model = per-job `model` (user prefs) or `config.RELEX_MODEL`.
          2. if Ollama reports the model isn't installed (404), pull it once and
             retry — the first extraction provisions the model itself.
          3. if the primary model can't run (OOM / crashed runner / timeout) or
             can't be pulled, fall back to the lighter `config.RELEX_FALLBACK_MODEL`.
          4. only if every candidate fails do we degrade (entities-only) with a
             human-readable reason on self.last_degraded_*.

        For kind in ("openai", "openai_compatible"):
          - No auto-pull (not applicable to external providers).
          - Calls _generate_once which delegates to llm_client.complete.
          - Degrades on unreachable/server_error with the same mechanism.

        `ollama_base` overrides `config.OLLAMA_BASE` for this call when provided.
        """
        base = (ollama_base or "").strip() or config.OLLAMA_BASE
        primary = (model or "").strip() or config.RELEX_MODEL
        candidates = [primary]
        # Fallback model only makes sense for Ollama (local model switching).
        if kind == "ollama":
            fallback = (getattr(config, "RELEX_FALLBACK_MODEL", "") or "").strip()
            if fallback and fallback != primary:
                candidates.append(fallback)

        for idx, m in enumerate(candidates):
            status, text = self._generate_once(base, m, prompt, kind=kind, api_key=api_key)
            if status == "ok":
                if idx > 0:
                    logger.warning(f"RelEx fell back to '{m}' (primary '{primary}' unavailable)")
                return text
            if status == "not_found":
                if kind == "ollama":
                    # Model isn't installed — provision it once, then retry the same model.
                    if self._pull_model(base, m):
                        status2, text2 = self._generate_once(
                            base, m, prompt, kind=kind, api_key=api_key
                        )
                        if status2 == "ok":
                            if idx > 0:
                                logger.warning(f"RelEx fell back to '{m}' and pulled it on demand")
                            return text2
                continue  # pull failed or still unusable → try the next candidate
            if status == "server_error":
                # OOM / crashed runner / timeout on this model → try the lighter fallback.
                logger.warning(f"RelEx model '{m}' could not run; trying fallback model")
                continue
            if status == "unreachable":
                break  # server is down — a different model won't help.

        self.last_degraded = True
        if kind == "ollama":
            self.last_degraded_reason = (
                "Relation extraction skipped — no usable relation model. Connect a working "
                "Ollama (Settings → Infrastructure) or pick an installed model (Settings → AI Models)."
            )
        else:
            self.last_degraded_reason = (
                f"Relation extraction skipped — relation model '{primary}' not reachable on the "
                f"configured runtime ({kind}) at {base} — check the endpoint URL and model name."
            )
        return None

    def _generate_once(
        self,
        base: str,
        model: str,
        prompt: str,
        kind: str = "ollama",
        api_key: Optional[str] = None,
    ) -> tuple[str, Optional[str]]:
        """One LLM call via llm_client. Returns (status, text) where status is
        'ok' | 'not_found' | 'server_error' | 'unreachable'.

        For kind=="ollama" the Ollama-specific 404 (model not found) is detected
        via the HTTP 404 response and returned as "not_found" so the caller can
        trigger auto-pull. For other kinds, 404 is treated as a server error.
        """
        try:
            text = llm_client.complete(
                prompt,
                model,
                base,
                kind,
                api_key=api_key,
                options={"temperature": 0.0, "num_predict": 1024},
                timeout=180,
            )
            return ("ok", text)
        except requests.exceptions.HTTPError as exc:
            status_code = exc.response.status_code if exc.response is not None else 0
            if kind == "ollama" and status_code == 404:
                # Ollama: "model '…' not found, try pulling it first"
                return ("not_found", None)
            if status_code >= 500:
                logger.warning(f"LLM 5xx for relation model '{model}': {status_code}")
                return ("server_error", None)
            logger.warning(f"LLM HTTP error for relation model '{model}': {exc}")
            return ("server_error", None)
        except requests.exceptions.ConnectionError:
            logger.warning("LLM server not reachable - skipping relation extraction")
            return ("unreachable", None)
        except requests.exceptions.Timeout:
            logger.warning(f"LLM timed out for relation model '{model}'")
            return ("server_error", None)  # a heavy model timing out → try the lighter one
        except Exception as exc:
            logger.error(f"LLM call failed for relation model '{model}': {exc}")
            return ("unreachable", None)

    def _pull_model(self, base: str, model: str) -> bool:
        """Pull a model into Ollama, ONCE per process (best-effort, blocking).

        Guarded so concurrent workers / repeated jobs don't re-trigger a multi-GB
        download. Returns True only on a confirmed successful pull."""
        with _pull_lock:
            if model in _pull_attempted:
                return model in _pulled_ok
            _pull_attempted.add(model)
        logger.info(f"RelEx: relation model '{model}' not installed — pulling it now (one-time)…")
        try:
            resp = requests.post(
                f"{base.rstrip('/')}/api/pull",
                json={"name": model, "stream": False},
                timeout=1800,  # a multi-GB model can take a while on first install
                allow_redirects=False,
            )
            resp.raise_for_status()
            ok = "error" not in (resp.text or "").lower()
            if ok:
                with _pull_lock:
                    _pulled_ok.add(model)
                logger.info(f"RelEx: pulled relation model '{model}'.")
            else:
                logger.warning(f"RelEx: pull of '{model}' reported an error: {(resp.text or '')[:200]}")
            return ok
        except Exception as exc:
            logger.warning(f"RelEx: could not pull relation model '{model}': {exc}")
            return False

    def _parse_json_array(self, response_text: str) -> list[dict]:
        """Parse a JSON array of relation objects from the model response.
        Tolerates code fences and surrounding prose."""
        if not response_text:
            return []
        raw = response_text.strip()
        raw = re.sub(r"^```(?:json)?", "", raw).strip()
        raw = re.sub(r"```$", "", raw).strip()

        try:
            data = json.loads(raw)
            if isinstance(data, list):
                return [d for d in data if isinstance(d, dict)]
        except json.JSONDecodeError:
            pass

        match = re.search(r"\[.*\]", raw, re.DOTALL)
        if match:
            try:
                data = json.loads(match.group())
                if isinstance(data, list):
                    return [d for d in data if isinstance(d, dict)]
            except json.JSONDecodeError:
                logger.warning("Could not parse relations JSON from Ollama response")
        return []

    def _validate(
        self,
        triples: list[dict],
        entities: list[dict],
    ) -> list[dict]:
        """
        Deterministic post-LLM validation:
          * both head and tail must be known entity surface forms
          * no self-loops / circular relations (head != tail)
          * relation normalized to a CANONICAL relation; out-of-vocab dropped
          * coarse type-compatibility: if the head/tail types violate the
            relation's allowed types, try the FLIP (repairs inverted direction);
            if neither orientation is valid, drop the triple
          * dedupe
        """
        # Map normalized surface -> (canonical surface, coarse_type) for lookup.
        surface_map: dict[str, tuple[str, str]] = {}
        for e in entities:
            surf = (e.get("text") or "").strip()
            if not surf:
                continue
            coarse = e.get("coarse_type") or config.coarse_for(
                e.get("gliner_label", ""), e.get("label", "")
            )
            surface_map.setdefault(surf.lower(), (surf, coarse))

        relations: list[dict] = []
        seen: set[tuple[str, str, str]] = set()

        for item in triples:
            head_raw = str(item.get("head", "")).strip()
            tail_raw = str(item.get("tail", "")).strip()
            rel_raw = str(item.get("relation") or item.get("type") or "").strip()

            if not head_raw or not tail_raw or not rel_raw:
                continue

            head_entry = surface_map.get(head_raw.lower())
            tail_entry = surface_map.get(tail_raw.lower())
            if head_entry is None or tail_entry is None:
                continue  # both ends must be known entities

            head, head_coarse = head_entry
            tail, tail_coarse = tail_entry
            if head.lower() == tail.lower():
                continue  # no self/circular

            canon = relvocab.normalize_relation(rel_raw)
            if canon is None:
                continue  # drop out-of-vocab garbage

            # Confidence starts high for a clean triple and is penalised by each
            # repair the deterministic validation has to apply. The memory layer
            # (A4 heat/trust, A3 ground-truth ranking) reads this per edge.
            confidence = 0.9

            # The LLM emitted a relation surface form that wasn't already the
            # canonical token (e.g. "is_ceo_of" -> "ceo_of"): a small penalty,
            # the meaning is still in-vocab but needed normalization.
            if canon != rel_raw.strip().lower():
                confidence -= 0.1

            # Coarse type-compatibility, with direction-flip repair. A flip is a
            # bigger trust hit than a surface normalization: the model got the
            # direction wrong and we corrected it.
            if not relvocab.type_ok(canon, head_coarse, tail_coarse):
                if relvocab.type_ok(canon, tail_coarse, head_coarse):
                    head, tail = tail, head
                    head_coarse, tail_coarse = tail_coarse, head_coarse
                    confidence -= 0.2
                else:
                    continue  # neither orientation valid -> drop

            confidence = round(max(0.0, min(1.0, confidence)), 3)

            key = (head.lower(), canon, tail.lower())
            if key in seen:
                continue
            seen.add(key)
            relations.append(
                {"head": head, "type": canon, "tail": tail, "confidence": confidence}
            )

        return relations

    def _validate_counted(
        self,
        triples: list[dict],
        entities: list[dict],
    ) -> tuple:
        """Like _validate but also returns drop/repair counters for the report.

        Returns (relations, cnt_oov, cnt_type, cnt_direction_flipped, cnt_normalized)
        where:
          cnt_oov              — triples dropped because relation was out-of-vocab
          cnt_type             — triples dropped because neither direction was type-compatible
          cnt_direction_flipped — triples where head<->tail was swapped to repair direction
          cnt_normalized       — triples where relation surface was normalized to canonical

        NOTE: A triple can only be in ONE drop bucket, but can have BOTH a
        normalization repair AND a direction flip (both counters are incremented).
        """
        # Map normalized surface -> (canonical surface, coarse_type) for lookup.
        surface_map = {}
        for e in entities:
            surf = (e.get("text") or "").strip()
            if not surf:
                continue
            coarse = e.get("coarse_type") or config.coarse_for(
                e.get("gliner_label", ""), e.get("label", "")
            )
            surface_map.setdefault(surf.lower(), (surf, coarse))

        relations = []
        seen = set()
        cnt_oov = 0
        cnt_type = 0
        cnt_direction_flipped = 0
        cnt_normalized = 0

        for item in triples:
            head_raw = str(item.get("head", "")).strip()
            tail_raw = str(item.get("tail", "")).strip()
            rel_raw = str(item.get("relation") or item.get("type") or "").strip()

            if not head_raw or not tail_raw or not rel_raw:
                continue

            head_entry = surface_map.get(head_raw.lower())
            tail_entry = surface_map.get(tail_raw.lower())
            if head_entry is None or tail_entry is None:
                continue  # both ends must be known entities

            head, head_coarse = head_entry
            tail, tail_coarse = tail_entry
            if head.lower() == tail.lower():
                continue  # no self/circular

            canon = relvocab.normalize_relation(rel_raw)
            if canon is None:
                cnt_oov += 1
                continue  # drop out-of-vocab garbage

            confidence = 0.9
            was_normalized = False
            was_flipped = False

            if canon != rel_raw.strip().lower():
                confidence -= 0.1
                was_normalized = True

            if not relvocab.type_ok(canon, head_coarse, tail_coarse):
                if relvocab.type_ok(canon, tail_coarse, head_coarse):
                    head, tail = tail, head
                    head_coarse, tail_coarse = tail_coarse, head_coarse
                    confidence -= 0.2
                    was_flipped = True
                else:
                    cnt_type += 1
                    continue  # neither orientation valid -> drop

            if was_normalized:
                cnt_normalized += 1
            if was_flipped:
                cnt_direction_flipped += 1

            confidence = round(max(0.0, min(1.0, confidence)), 3)

            key = (head.lower(), canon, tail.lower())
            if key in seen:
                continue
            seen.add(key)
            relations.append(
                {"head": head, "type": canon, "tail": tail, "confidence": confidence}
            )

        return (relations, cnt_oov, cnt_type, cnt_direction_flipped, cnt_normalized)


# One-time, process-wide guard so concurrent workers / repeated jobs never
# re-trigger a multi-GB model download. `_pulled_ok` records confirmed pulls so a
# second worker can reuse the result instead of re-attempting.
_pull_lock = threading.Lock()
_pull_attempted: set[str] = set()
_pulled_ok: set[str] = set()

# Module-level singleton
_extractor = RelationExtractor()


def get_extractor() -> RelationExtractor:
    return _extractor
