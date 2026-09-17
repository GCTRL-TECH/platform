"""Hard job scope for /search — the knowledge-base boundary of chunk retrieval.

Owner + clearance decide WHOSE chunks and HOW SENSITIVE; they say nothing about
WHICH knowledge base. A KB-scoped access token (api-rs `api_keys.kb_scoped`) may
only read the compilations it was granted, and api-rs expresses that as the union
of their `source_job_ids`. `compilation_id` cannot carry this: it is frequently
NULL on chunks (which is why the compilation filter in /search is only a SOFT
preference with an owner-corpus fallback), whereas `job_id` is always written.

Contract of `SearchReq.job_ids`:
  * None  → no job scope (JWT session / unrestricted token) — behaviour unchanged.
  * []    → the caller may see nothing → /search answers {"chunks": []} at once.
  * [...] → HARD allow-list, enforced in EVERY channel (dense, lexical, the
            whole-corpus fallback, the Hebbian neighbour pull-in) and once more on
            the final list. Nothing — no fallback, no soft preference — re-admits
            a chunk from another job.

Params are deliberately left un-annotated: this module is Cython-compiled in the
prod image, where a `list`/`dict` annotation is an EXACT type check that rejects
subclasses (a past release blocker).
"""

import uuid


def normalize_job_ids(job_ids):
    """None stays None (= unscoped). Anything else becomes a de-duplicated list of
    canonical lowercase UUID strings; entries that are not UUIDs are dropped (they
    can match no chunk, and would otherwise make the `::uuid[]` cast fail the
    whole lexical query). An all-invalid list therefore normalizes to [] = deny."""
    if job_ids is None:
        return None
    out = []
    seen = set()
    for j in job_ids:
        try:
            canon = str(uuid.UUID(str(j).strip()))
        except (ValueError, AttributeError, TypeError):
            continue
        if canon not in seen:
            seen.add(canon)
            out.append(canon)
    return out


def denies_all(job_ids) -> bool:
    """True when a job scope is present but empty — nothing is visible."""
    return job_ids is not None and len(job_ids) == 0


def sql_clause(job_ids, column="job_id", param="jobs"):
    """(clause, params) to AND into a text_chunks query, or (None, {}) when
    unscoped. `text_chunks.job_id` is a UUID column; a NULL job_id never satisfies
    `= ANY(...)`, so chunks without a job are excluded under a scope (fail closed)."""
    if job_ids is None:
        return None, {}
    return f"{column} = ANY(%({param})s::uuid[])", {param: [str(j) for j in job_ids]}


def qdrant_condition(job_ids):
    """Qdrant must-condition on the `job_id` payload key (stored as the job's UUID
    string by vector_store / backfill_vectors), or None when unscoped. A point
    without a job_id payload cannot match MatchAny → excluded under a scope."""
    if job_ids is None:
        return None
    from qdrant_client.models import FieldCondition, MatchAny
    return FieldCondition(key="job_id", match=MatchAny(any=[str(j) for j in job_ids]))


def filter_chunks(chunks, job_ids):
    """Final guard over an already-retrieved chunk list: keep only chunks whose
    `job_id` is in the allow-list. Unscoped → the input is returned untouched."""
    if job_ids is None:
        return chunks
    allowed = set(str(j) for j in job_ids)
    return [c for c in chunks if str(c.get("job_id") or "").lower() in allowed]
