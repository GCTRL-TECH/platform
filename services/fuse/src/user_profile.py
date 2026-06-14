"""
A6 — USER-PROFILE / personalization memory (GDPR-aware)
───────────────────────────────────────────────────────

Distils durable, stable user facts/preferences (role, expertise, preferences,
working style, recurring context) from the user's STANDARD-mode conversation
history and persists them into the `user_profile` table. When the profile is
`enabled`, api-rs injects its `summary` as a TRUST TIER 1 hot block into the
RAG/agent prompt so answers are personalized.

DSGVO posture (the thing MemoryOS can't claim and we can):
  • SOURCE IS STANDARD-MODE ONLY. The distiller reads `messages` rows whose
    `conversation_id` belongs to the user. Incognito turns NEVER call
    `persist_turn` (api-rs rag.rs), so they never land in `conversations`/
    `messages` — there is structurally no incognito content here to read. We do
    NOT touch Neo4j or any ephemeral session store.
  • OPT-IN. The api-rs build endpoint refuses to run unless `user_profile.enabled`
    is true (so a build can't happen behind the user's back). This module keeps a
    belt-and-braces guard too.
  • Right-to-be-forgotten lives in api-rs (`DELETE /api/user/profile`).

Everything runs FULLY LOCAL against the in-container Ollama (zero cloud). The LLM
call REUSES `distiller._llm_complete` (GCTRL_DISTILL_PROVIDER / GCTRL_DISTILL_MODEL,
default ollama / llama3.2).
"""

import json
import logging
import re
from typing import Optional

import psycopg2
import psycopg2.extras

from . import config
from . import distiller

logger = logging.getLogger(__name__)

# How much standard-mode history to feed the distiller. Recent turns carry the
# most representative signal; cap to keep the prompt bounded and the pass fast.
_MAX_MESSAGES = 120
_MAX_CHARS_PER_MSG = 600


def _pg_connect():
    return psycopg2.connect(config.PG_URL, connect_timeout=5)


def _is_enabled(conn, user_id: str) -> bool:
    """OPT-IN guard. True only when the user has explicitly enabled the profile."""
    with conn.cursor() as cur:
        cur.execute(
            "SELECT enabled FROM user_profile WHERE user_id = %s::uuid", (user_id,)
        )
        row = cur.fetchone()
    return bool(row and row[0])


def _fetch_standard_history(conn, user_id: str) -> list[dict]:
    """Pull the user's STANDARD-mode conversation turns.

    Every row in `messages` reachable via `conversations.user_id = $user` is, by
    construction, standard-mode content: `persist_turn` is the ONLY writer and it
    is gated on `mode != incognito`. Incognito turns are never written, so this
    query can only ever surface standard-mode material — the GDPR split holds at
    the data layer, not just by prompt wording.
    """
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(
            """
            SELECT m.role, m.content, m.created_at
              FROM messages m
              JOIN conversations c ON c.id = m.conversation_id
             WHERE c.user_id = %s::uuid
             ORDER BY m.created_at DESC
             LIMIT %s
            """,
            (user_id, _MAX_MESSAGES),
        )
        rows = cur.fetchall()
    # Re-order ascending so the transcript reads naturally for the LLM.
    rows.reverse()
    return rows


def _build_transcript(rows: list[dict]) -> str:
    lines = []
    for r in rows:
        role = "User" if r["role"] == "human" else "Assistant"
        content = re.sub(r"\s+", " ", (r["content"] or "")).strip()
        if not content:
            continue
        if len(content) > _MAX_CHARS_PER_MSG:
            content = content[:_MAX_CHARS_PER_MSG] + " …"
        lines.append(f"{role}: {content}")
    return "\n".join(lines)


def _distill_prompt(transcript: str) -> str:
    return (
        "You are building a DURABLE user profile for a personal AI assistant. "
        "Below is a transcript of past conversations between a User and the Assistant.\n\n"
        "Extract ONLY STABLE, DURABLE facts and preferences about the USER that would "
        "help personalize future answers — e.g. their role/job, areas of expertise, "
        "tools/technologies they use, communication preferences, working style, and "
        "recurring projects or context. IGNORE one-off questions, transient task "
        "details, and anything about the Assistant.\n\n"
        "Return STRICT JSON ONLY (no prose, no markdown fences) in this exact shape:\n"
        '{"facts": [{"category": "<role|expertise|preference|working_style|context|other>", '
        '"fact": "<short factual statement about the user>"}], '
        '"summary": "<2-4 sentence prose summary of who the user is and how they '
        'like to work>"}\n\n'
        "If the transcript reveals nothing durable, return "
        '{"facts": [], "summary": ""}.\n\n'
        "Transcript:\n"
        f"{transcript}\n\n"
        "JSON:"
    )


def _parse_distillation(raw: str) -> tuple[list[dict], str]:
    """Parse the LLM JSON. Tolerant: strips ```json fences and trailing prose,
    grabs the first balanced {...} object. Returns (facts, summary)."""
    text = raw.strip()
    # Strip code fences if the model added them despite instructions.
    text = re.sub(r"^```(?:json)?\s*", "", text)
    text = re.sub(r"\s*```$", "", text).strip()
    # Grab the first {...} block (greedy to the last brace).
    start = text.find("{")
    end = text.rfind("}")
    if start != -1 and end != -1 and end > start:
        text = text[start : end + 1]
    try:
        obj = json.loads(text)
    except Exception as exc:
        logger.warning(f"[user_profile] JSON parse failed: {exc}; raw={raw[:200]!r}")
        return [], ""
    facts_in = obj.get("facts") or []
    facts: list[dict] = []
    for f in facts_in:
        if not isinstance(f, dict):
            continue
        fact = re.sub(r"\s+", " ", str(f.get("fact") or "")).strip()
        if not fact:
            continue
        cat = re.sub(r"\s+", " ", str(f.get("category") or "other")).strip().lower()
        facts.append({"category": cat, "fact": fact})
    summary = re.sub(r"\s+", " ", str(obj.get("summary") or "")).strip()
    return facts, summary


def _upsert_profile(conn, user_id: str, facts: list[dict], summary: str) -> None:
    """Write distilled content WITHOUT touching `enabled` (it's the user's opt-in
    flag — a build never flips it). The row exists already (the build endpoint
    creates it on opt-in), so this is a plain UPDATE; INSERT-fallback keeps it
    robust if called directly."""
    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO user_profile (user_id, facts, summary, enabled, updated_at)
            VALUES (%s::uuid, %s::jsonb, %s, false, NOW())
            ON CONFLICT (user_id) DO UPDATE SET
                facts      = EXCLUDED.facts,
                summary    = EXCLUDED.summary,
                updated_at = NOW()
            """,
            (user_id, json.dumps(facts), summary),
        )
    conn.commit()


def build_profile(user_id: str) -> dict:
    """Distil + persist the user's profile from STANDARD-mode history.

    Returns {facts, summary, message_count, action}. Raises PermissionError if the
    profile is not opted-in (belt-and-braces; api-rs also guards). When there is no
    history, persists an empty profile (idempotent) rather than failing.
    """
    conn = _pg_connect()
    try:
        if not _is_enabled(conn, user_id):
            raise PermissionError("user_profile is not enabled (opt-in required)")

        rows = _fetch_standard_history(conn, user_id)
        if not rows:
            logger.info(f"[user_profile] no standard-mode history for {user_id}")
            _upsert_profile(conn, user_id, [], "")
            return {"facts": [], "summary": "", "message_count": 0, "action": "empty"}

        transcript = _build_transcript(rows)
        prompt = _distill_prompt(transcript)
        try:
            raw = distiller._llm_complete(prompt)
        except Exception as exc:
            logger.error(f"[user_profile] LLM distill failed for {user_id}: {exc}")
            raise

        facts, summary = _parse_distillation(raw)
        _upsert_profile(conn, user_id, facts, summary)
        logger.info(
            f"[user_profile] built profile for {user_id}: "
            f"{len(facts)} facts from {len(rows)} messages"
        )
        return {
            "facts": facts,
            "summary": summary,
            "message_count": len(rows),
            "action": "built",
        }
    finally:
        conn.close()
