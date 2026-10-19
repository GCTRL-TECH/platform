"""Trust order for /search: agent notes never outrank source documents.

Found 2026-10-19 (Anvil prod nightly bench): chat agents wrote their own research
results into users' knowledge bases with `store` (jobs.input->>'source' =
'agent_store'), some with future dates. Later answers retrieved those notes and
quoted them back as facts ("follow-up contract EnBW" while the documents say
Baltic Offshore; "CFO since founding 2011" while the source says 2022). The
Hebbian prior made it worse: every answer that used a note heated it, so the
note climbed further.

The rule here is deliberately simple: in the final /search ranking every chunk
of an agent-store job comes AFTER every chunk of any other job (uploads, files,
connectors, lessons, ...). Relative order inside both groups is unchanged, so a
note still answers a question no document covers. Each demoted chunk carries
`origin: "agent_note"` so callers can label it as an unconfirmed finding.

KEX_AGENT_NOTE_DEMOTE=0 switches it off. Never raises: on any lookup problem the
input order is kept.
"""
from __future__ import annotations

import logging
import os
from typing import Callable, Optional

logger = logging.getLogger(__name__)

AGENT_NOTE_SOURCE = "agent_store"


def demote_enabled() -> bool:
    return os.environ.get("KEX_AGENT_NOTE_DEMOTE", "1").strip().lower() not in ("0", "false", "no", "off")


def demote_agent_notes(chunks, agent_job_ids):
    """Pure: stable partition, non-agent chunks first. `chunks` un-annotated on
    purpose (the Cython prod build enforces `list` annotations as exact types)."""
    if not chunks or not agent_job_ids:
        return chunks
    docs = []
    notes = []
    for c in chunks:
        jid = c.get("job_id")
        if jid is not None and str(jid) in agent_job_ids:
            c["origin"] = "agent_note"
            notes.append(c)
        else:
            docs.append(c)
    return docs + notes


def agent_note_job_ids(chunks, conn_factory: Callable[[], object]) -> set:
    """The job ids among `chunks` that were written by an agent `store` call."""
    ids = sorted({str(c.get("job_id")) for c in chunks if c.get("job_id")})
    if not ids:
        return set()
    conn = conn_factory()
    if conn is None:
        return set()
    with conn.cursor() as cur:
        cur.execute(
            "SELECT id::text FROM jobs WHERE id = ANY(%s::uuid[]) AND input->>'source' = %s",
            (ids, AGENT_NOTE_SOURCE),
        )
        return {row[0] for row in cur.fetchall()}


def apply_trust_order(chunks, conn_factory: Callable[[], object], enabled: Optional[bool] = None):
    """Entry point for /search. Never raises; keeps the input order on any problem."""
    if not chunks or not (demote_enabled() if enabled is None else enabled):
        return chunks
    try:
        agent_jobs = agent_note_job_ids(chunks, conn_factory)
    except Exception as exc:  # noqa: BLE001 — ordering must never break retrieval
        logger.warning("/search trust order skipped: %s", exc)
        return chunks
    if agent_jobs:
        logger.info("/search trust: %d agent-note job(s) ranked after source documents", len(agent_jobs))
    return demote_agent_notes(chunks, agent_jobs)
