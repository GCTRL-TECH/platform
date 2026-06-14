"""Classification resolution + per-element label helpers for the KEX worker.

Every node / edge / chunk written by KEX carries the classification it was
ingested with, expressed as a *set* of provenance labels plus a denormalized
`_min_rank` (the most-permissive rank across labels) used for fast read
filtering. A fresh ingest carries exactly one label; FUSE later unions labels
across merged sources (see services/fuse/src/merger.py), and re-ingesting the
same entity at a different classification appends a second label (conflict).

Visibility rule (enforced in api-rs): an element is visible to a viewer when
`_min_rank <= viewer_rank` — i.e. the most-permissive historical label wins, so
a generic node tagged PUBLIC in one source stays public even if also referenced
by a confidential source. The genuinely sensitive *connected* content keeps its
own higher label and stays gated.
"""

import json
import logging
from datetime import datetime, timezone
from typing import Optional

from . import config

logger = logging.getLogger(__name__)

# System ISO 27001 levels — fixed ranks, used as a fallback when the DB is
# unreachable or a name can't be resolved. Mirrors migration 024.
_SYSTEM_BY_NAME = {
    "PUBLIC": 0,
    "INTERNAL": 100,
    "CONFIDENTIAL": 200,
    "STRICTLY_CONFIDENTIAL": 300,
}
_DEFAULT = {"id": None, "name": "PUBLIC", "rank": 0}

# tiny in-process cache: "id:<uuid>" / "name:<NAME>" -> {id, name, rank}
_cache: dict = {}


def resolve_classification(level_id: Optional[str] = None,
                           name: Optional[str] = None) -> dict:
    """Resolve a classification to ``{id, name, rank}``.

    Prefers ``level_id``, then ``name``; falls back to the system rank table,
    then PUBLIC. Never raises — ingestion must not fail because a classification
    lookup hiccuped.
    """
    key = f"id:{level_id}" if level_id else (f"name:{name}" if name else None)
    if key and key in _cache:
        return _cache[key]

    resolved = None
    try:
        import psycopg2
        conn = psycopg2.connect(config.PG_URL, connect_timeout=5)
        with conn, conn.cursor() as cur:
            if level_id:
                cur.execute(
                    "SELECT id::text, name, rank FROM classification_levels WHERE id = %s",
                    (level_id,),
                )
            elif name:
                cur.execute(
                    "SELECT id::text, name, rank FROM classification_levels "
                    "WHERE name = %s ORDER BY (user_id IS NULL) DESC LIMIT 1",
                    (name,),
                )
            else:
                cur.execute("SELECT NULL::text, 'PUBLIC', 0")
            row = cur.fetchone()
            if row:
                resolved = {"id": row[0], "name": row[1], "rank": int(row[2])}
        conn.close()
    except Exception as exc:
        logger.warning("classification resolve failed (%s/%s): %s", level_id, name, exc)

    if resolved is None:
        if name and name.upper() in _SYSTEM_BY_NAME:
            resolved = {"id": None, "name": name.upper(), "rank": _SYSTEM_BY_NAME[name.upper()]}
        else:
            resolved = dict(_DEFAULT)

    if key:
        _cache[key] = resolved
    return resolved


def make_label(resolved: dict, source_job: str, owner: str) -> dict:
    """Build one provenance label record for an element."""
    return {
        "rank": int(resolved.get("rank", 0)),
        "level_id": resolved.get("id"),
        "level_name": resolved.get("name", "PUBLIC"),
        "source_job": source_job,
        "ingested_by": owner,
        "ingested_at": datetime.now(timezone.utc).isoformat(),
    }


def encode_label(label: dict) -> str:
    """Serialize a single label as a compact JSON string (Neo4j list element)."""
    return json.dumps(label, separators=(",", ":"))
