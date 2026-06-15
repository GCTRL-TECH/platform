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
from typing import Optional

import requests

from . import config
from . import relvocab

logger = logging.getLogger(__name__)

# Maximum characters of text to send to Ollama (keep prompt manageable).
# Raised from 3000 → 6000: a 3000-char cut decapitates a multi-page document
# (e.g. a CV's Experience/Education sections sit past char 3000), so the relation
# extractor never saw the facts that matter. 6000 still fits qwen2.5:7b's context
# comfortably and roughly doubles structured-document recall.
_MAX_TEXT_CHARS = 6000

# Cap the entity list fed to the LLM. A document can produce hundreds of NER
# entities (a CV yielded 416); dumping all of them bloats the prompt and buries
# the few that actually participate in relations, so the model returns almost
# nothing. The KG builder still stores ALL entities — this cap only bounds the
# relation-extraction prompt.
_MAX_ENTITIES = 80


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
    ) -> list[dict]:
        """
        Extract relations from text given a list of entity dicts.

        `ollama_base` is an optional per-job override for the Ollama endpoint
        (the owner's Settings → Infrastructure base URL, passed through by the
        API). When None/empty the module-wide `config.OLLAMA_BASE` is used, so the
        default install is unchanged.

        Each output dict: { head: str, type: str, tail: str, confidence: float }
        where `type` is a CANONICAL relation from relvocab.RELATIONS (`type` key
        kept for backward compatibility with the KG builder which reads
        `relation["type"]`). `confidence` is the per-triple trust score (0..1)
        the memory layer (A4 heat/trust) reads: ~0.9 for a clean, in-vocab,
        type-checked triple; lower (~0.6) when validation had to repair the
        direction or normalize the relation surface form.

        Returns empty list on any failure (graceful degradation). When the
        failure is the LLM being UNAVAILABLE (connection error / timeout / 5xx),
        `self.last_degraded` is set True with a human-readable
        `self.last_degraded_reason` so the pipeline can mark the job as a
        successful-but-degraded extraction (entities only, no relations) instead
        of failing the whole job.
        """
        # Reset degradation state for this run.
        self.last_degraded = False
        self.last_degraded_reason = None

        if not entities or len(entities) < 2:
            return []

        truncated_text = text[:_MAX_TEXT_CHARS]
        if len(text) > _MAX_TEXT_CHARS:
            truncated_text += " ..."

        # Prefer entities that actually appear in the (truncated) text window we
        # send, then cap the list. This keeps the prompt focused on entities the
        # model can relate, instead of burying them under hundreds of stray NER
        # hits. Validation still runs against the FULL entity set, so a relation
        # whose surface form is in the doc is never dropped for being off-list.
        prompt_entities = self._select_prompt_entities(entities, truncated_text)
        entity_lines = self._format_entity_list(prompt_entities)
        prompt = _build_prompt(truncated_text, entity_lines)

        raw_response = self._call_ollama(prompt, ollama_base=ollama_base)
        if raw_response is None:
            # _call_ollama already recorded the reason on self.last_degraded_*.
            return []

        try:
            parsed = self._parse_json_array(raw_response)
            return self._validate(parsed, entities)
        except Exception as exc:
            # A parsing / validation defect must never fail the whole job.
            logger.warning(f"Relation parse/validation failed (non-fatal): {exc}")
            self.last_degraded = True
            self.last_degraded_reason = (
                "Relation extraction skipped (LLM response could not be parsed)."
            )
            return []

    # ── internal helpers ──────────────────────────────────────────────

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

    def _call_ollama(self, prompt: str, ollama_base: Optional[str] = None) -> Optional[str]:
        """Call Ollama /api/generate; return response text or None on error.

        `ollama_base` overrides `config.OLLAMA_BASE` for this call when provided
        (per-job endpoint from the API); otherwise the env-configured default."""
        base = (ollama_base or "").strip() or config.OLLAMA_BASE
        _unavailable = (
            "Relation extraction skipped — LLM unavailable. Connect a working "
            "Ollama in Settings → Infrastructure to enable relation extraction."
        )
        try:
            resp = requests.post(
                f"{base.rstrip('/')}/api/generate",
                json={
                    "model": config.RELEX_MODEL,
                    "prompt": prompt,
                    "stream": False,
                    "options": {
                        "temperature": 0.0,
                        "num_predict": 1024,
                    },
                },
                timeout=180,
            )
            resp.raise_for_status()
            data = resp.json()
            return data.get("response", "")
        except requests.exceptions.ConnectionError:
            logger.warning("Ollama not reachable - skipping relation extraction")
            self.last_degraded = True
            self.last_degraded_reason = _unavailable
            return None
        except requests.exceptions.Timeout:
            logger.warning("Ollama timed out during relation extraction")
            self.last_degraded = True
            self.last_degraded_reason = _unavailable
            return None
        except requests.exceptions.HTTPError as exc:
            # 5xx / model crash (e.g. "llama runner process has terminated").
            logger.warning(f"Ollama returned an error - skipping relation extraction: {exc}")
            self.last_degraded = True
            self.last_degraded_reason = _unavailable
            return None
        except Exception as exc:
            logger.error(f"Ollama call failed: {exc}")
            self.last_degraded = True
            self.last_degraded_reason = _unavailable
            return None

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


# Module-level singleton
_extractor = RelationExtractor()


def get_extractor() -> RelationExtractor:
    return _extractor
