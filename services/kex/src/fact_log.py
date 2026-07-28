"""Session fact log — atomic memory facts distilled per ingested document.

Long-corpus recall fails on single buried sentences: an updated deadline, a
denial ("I never wrote any Flask routes"), a dated event. Top-k chunk retrieval
ranks whole passages by topical similarity, so those one-liners lose to bulk
prose. This step distills each ingested session part into a handful of atomic,
self-contained facts and stores them as their OWN small chunks (under the same
job): short + dense text embeds cleanly, ranks high, and carries explicit
update/denial/date phrasing that answer generation can rely on.

Runs FULLY LOCAL against Ollama (same privacy story as NER/RelEx — no cloud
call, no key material in the worker). Fails soft: any error simply yields no
fact chunks; the normal pipeline output is untouched.
"""
import json
import logging
import os
import re

import requests

from . import config

logger = logging.getLogger(__name__)

FACT_LOG_ENABLED = os.environ.get("KEX_FACT_LOG", "1").strip() not in ("0", "false", "no")
FACT_LOG_MODEL = os.environ.get("KEX_FACT_LOG_MODEL", "qwen2.5:7b").strip()
FACT_LOG_FALLBACK = os.environ.get("KEX_FACT_LOG_FALLBACK", "qwen2.5:3b").strip()
# Offset keeps fact chunks recognizable + clear of real chunk sequences.
FACT_SEQ_BASE = 5000

PROMPT = """Extract the key memory-worthy facts from this conversation session excerpt. Rules:
- Each fact: ONE self-contained sentence, keeping the conversation's exact names, numbers, and dates.
- Attribute correctly: "The user ..." vs "The assistant suggested ...".
- ALWAYS capture: updates/changes (state BOTH old and new value: "changed from X to Y"), denials ("the user said they never ..."), decisions, preferences, deadlines, and dated events (include the date).
- Skip generic pleasantries and assistant boilerplate.
- 4 to 10 facts. Output each fact on its OWN line starting with "- ". No other text before or after.

EXCERPT:
{text}
"""


def _parse_facts(raw: str) -> list[str]:
    """Parse '- fact' lines; tolerate numbered lists. (Plain lines beat JSON
    here — small local models mangle JSON arrays into keyed objects, which
    silently drops the fact subjects.)"""
    facts = []
    for line in raw.splitlines():
        line = line.strip()
        m = re.match(r"^(?:[-*•]|\d+[.)])\s+(.*)$", line)
        if m:
            facts.append(m.group(1).strip())
    return facts


def _generate(base: str, model: str, prompt: str, timeout: int = 90) -> str | None:
    try:
        resp = requests.post(
            f"{base}/api/generate",
            json={"model": model, "prompt": prompt, "stream": False,
                  "options": {"temperature": 0.1}},
            timeout=timeout,
        )
        if resp.status_code == 404:
            return None  # model not installed
        resp.raise_for_status()
        return resp.json().get("response", "")
    except Exception as exc:  # noqa: BLE001 — fact log must never break ingest
        logger.warning(f"fact_log generate failed on {model}: {exc}")
        return None


def extract_facts(text: str, ollama_base: str | None = None) -> list[str]:
    """Distill `text` into atomic facts. Empty list on any failure (fail-soft)."""
    if not FACT_LOG_ENABLED or len(text) < 200:
        return []
    base = (ollama_base or config.OLLAMA_BASE).rstrip("/")
    prompt = PROMPT.format(text=text[:9000])
    raw = _generate(base, FACT_LOG_MODEL, prompt)
    if raw is None and FACT_LOG_FALLBACK and FACT_LOG_FALLBACK != FACT_LOG_MODEL:
        raw = _generate(base, FACT_LOG_FALLBACK, prompt)
    if not raw:
        return []
    facts = _parse_facts(raw)
    # sanity: drop fragments and runaway outputs
    facts = [f for f in facts if 20 <= len(f) <= 400][:12]
    return facts


def fact_chunks(doc_text: str, facts: list[str]) -> list[dict]:
    """Wrap facts as chunk dicts (vector_store.store_chunks shape).

    IMPORTANT: embed the RAW fact text, not the stored content — the provenance
    prefix is metadata boilerplate that halves the embedding's signal (measured:
    prefixed facts stopped ranking for their own questions). Callers must embed
    `chunk["embed_text"]` and store `chunk["content"]`."""
    header = ""
    first = doc_text.lstrip().splitlines()[0] if doc_text.strip() else ""
    if first.startswith("[") and len(first) < 120:
        h = first.strip("[]").strip()
        # compact: "Conversation session 2 — date: December-12-2023 — part 18"
        # → "session 2 · December-12-2023"
        sess = date = ""
        if "session " in h:
            sess = "session " + h.split("session ", 1)[1].split(" ")[0].strip()
        if "date: " in h:
            date = h.split("date: ", 1)[1].split(" —")[0].strip()
        header = " · ".join(x for x in (sess, date) if x)
    out = []
    for i, f in enumerate(facts):
        content = f"[Fact · {header}] {f}" if header else f"[Fact] {f}"
        out.append({"content": content, "embed_text": f, "start_char": 0,
                    "end_char": 0, "chunk_sequence": FACT_SEQ_BASE + i})
    return out
