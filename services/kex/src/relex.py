"""
Relation Extraction for KEX Service
Uses local Ollama LLM to extract typed relations between entities.
Gracefully degrades to empty list when Ollama is unavailable.
"""

import json
import logging
import re
from typing import Optional

import requests

from . import config

logger = logging.getLogger(__name__)

# Maximum characters of text to send to Ollama (keep prompt manageable)
_MAX_TEXT_CHARS = 3000

_PROMPT_TEMPLATE = """\
You are a relation extraction system. Given a text and a list of named entities, \
extract all semantic relationships between the entities.

Text:
\"\"\"
{text}
\"\"\"

Named entities found in the text:
{entity_list}

Return ONLY a valid JSON array. Each element must have exactly these fields:
  "head"  - the subject entity (use the exact surface form from the entity list)
  "type"  - a short, lowercase relation label (e.g. "works_for", "located_in", "founded_by", "part_of", "born_in")
  "tail"  - the object entity (use the exact surface form from the entity list)

Rules:
- Only extract relations where both head and tail appear in the entity list.
- Use snake_case for relation types.
- If no relations can be found, return an empty array: []
- Return NOTHING except the JSON array.

JSON array:"""


class RelationExtractor:
    """Ollama-backed relation extractor."""

    def extract_relations(
        self,
        text: str,
        entities: list[dict],
    ) -> list[dict]:
        """
        Extract relations from text given a list of entity dicts.

        Returns list of dicts: { head: str, type: str, tail: str }
        Returns empty list on any failure (graceful degradation).
        """
        if not entities or len(entities) < 2:
            return []

        # Truncate text to keep prompt size manageable
        truncated_text = text[:_MAX_TEXT_CHARS]
        if len(text) > _MAX_TEXT_CHARS:
            truncated_text += " ..."

        entity_list_str = self._format_entity_list(entities)
        prompt = _PROMPT_TEMPLATE.format(
            text=truncated_text,
            entity_list=entity_list_str,
        )

        raw_response = self._call_ollama(prompt)
        if raw_response is None:
            return []

        return self._parse_relations(raw_response, entities)

    # ── internal helpers ──────────────────────────────────────────────

    def _format_entity_list(self, entities: list[dict]) -> str:
        lines: list[str] = []
        seen: set[str] = set()
        for ent in entities:
            surface = ent.get("text", "").strip()
            label = ent.get("label", "entity")
            if surface and surface not in seen:
                lines.append(f"  - {surface} ({label})")
                seen.add(surface)
        return "\n".join(lines)

    def _call_ollama(self, prompt: str) -> Optional[str]:
        """Call Ollama /api/generate; return response text or None on error."""
        try:
            resp = requests.post(
                f"{config.OLLAMA_BASE}/api/generate",
                json={
                    "model": config.RELEX_MODEL,
                    "prompt": prompt,
                    "stream": False,
                    "options": {
                        "temperature": 0.1,
                        "num_predict": 1024,
                    },
                },
                timeout=120,
            )
            resp.raise_for_status()
            data = resp.json()
            return data.get("response", "")
        except requests.exceptions.ConnectionError:
            logger.warning("Ollama not reachable - skipping relation extraction")
            return None
        except requests.exceptions.Timeout:
            logger.warning("Ollama timed out during relation extraction")
            return None
        except Exception as exc:
            logger.error(f"Ollama call failed: {exc}")
            return None

    def _parse_relations(
        self,
        response_text: str,
        entities: list[dict],
    ) -> list[dict]:
        """
        Parse JSON array from Ollama response.
        Uses regex fallback if the response has surrounding prose.
        Validates that head/tail reference known entity surfaces.
        """
        known_surfaces: set[str] = {
            e.get("text", "").strip().lower() for e in entities
        }

        # Try direct parse first
        json_array: Optional[list] = None
        try:
            json_array = json.loads(response_text.strip())
        except json.JSONDecodeError:
            pass

        # Regex fallback: find first [...] block
        if json_array is None:
            match = re.search(r"\[.*?\]", response_text, re.DOTALL)
            if match:
                try:
                    json_array = json.loads(match.group())
                except json.JSONDecodeError:
                    logger.warning("Could not parse relations JSON from Ollama response")
                    return []

        if not json_array or not isinstance(json_array, list):
            return []

        relations: list[dict] = []
        for item in json_array:
            if not isinstance(item, dict):
                continue
            head = str(item.get("head", "")).strip()
            rel_type = str(item.get("type", "")).strip()
            tail = str(item.get("tail", "")).strip()

            # Only accept relations where both ends are known entities
            if (
                head
                and rel_type
                and tail
                and head.lower() in known_surfaces
                and tail.lower() in known_surfaces
                and head.lower() != tail.lower()
            ):
                relations.append({
                    "head": head,
                    "type": rel_type,
                    "tail": tail,
                })

        return relations


# Module-level singleton
_extractor = RelationExtractor()


def get_extractor() -> RelationExtractor:
    return _extractor
