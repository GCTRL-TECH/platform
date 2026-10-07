"""Which source jobs a merge may read: only the NEWEST version of every file.

KEX keeps a version chain per ingested file (`source_documents`: same path,
new content hash → version+1, the old row loses `latest`). Until now FUSE
merged every job a compilation ever collected, so an updated file contributed
twice — its old facts next to its new ones — and the merged graph could not
tell which was current. This module drops the jobs that belong to a superseded
file version before the merge starts.

A job without a source document (raw text stores, old data) is always kept:
there is no newer version it could have been replaced by.

Fail-safe: when Postgres cannot be asked, every job is kept — a merge over
stale versions beats no merge at all, and the log says what happened.
"""

import logging

logger = logging.getLogger(__name__)


def split_latest(job_rows, requested):
    """Pure: decide which requested jobs survive.

    ``job_rows`` are ``(job_id, source_document_id, latest, path)`` tuples as
    read from Postgres (``latest``/``path`` None when the job has no source
    document). ``requested`` is the ordered list of job ids the merge asked
    for. Returns ``(kept, dropped)``: ``kept`` preserves the request order,
    ``dropped`` lists ``{job, path}`` for the log and the job result.

    A job absent from ``job_rows`` (unknown to Postgres) is kept: this filter
    only removes what it can PROVE is an older version.
    """
    status = {}
    for job_id, doc_id, latest, path in job_rows:
        status[str(job_id)] = (doc_id, latest, path)
    kept = []
    dropped = []
    for job_id in requested:
        row = status.get(str(job_id))
        if row is None:
            kept.append(job_id)
            continue
        doc_id, latest, path = row
        if doc_id is not None and latest is False:
            dropped.append({"job": str(job_id), "path": path or ""})
        else:
            kept.append(job_id)
    return kept, dropped


def latest_source_jobs(pg_url, job_ids):
    """The subset of ``job_ids`` whose file version is still the latest.

    Returns ``(kept, dropped)`` like :func:`split_latest`. Never raises.
    """
    if not job_ids:
        return list(job_ids), []
    try:
        import psycopg2
        conn = psycopg2.connect(pg_url, connect_timeout=5)
        try:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT j.id::text, j.source_document_id::text, sd.latest, sd.path
                    FROM jobs j
                    LEFT JOIN source_documents sd ON sd.id = j.source_document_id
                    WHERE j.id::text = ANY(%s)
                    """,
                    ([str(j) for j in job_ids],),
                )
                rows = cur.fetchall()
        finally:
            conn.close()
    except Exception as exc:  # noqa: BLE001 — fail-safe by contract
        logger.warning("sources: could not check file versions, merging all jobs: %s", exc)
        return list(job_ids), []

    kept, dropped = split_latest(rows, job_ids)
    if dropped:
        logger.info(
            "sources: %d of %d source jobs belong to superseded file versions and are left out: %s",
            len(dropped), len(job_ids),
            ", ".join(f"{d['job'][:8]} ({d['path']})" for d in dropped[:10]),
        )
    if not kept and job_ids:
        # Every job superseded can only mean the version data is inconsistent
        # (a latest row must exist for each path). Merge everything rather
        # than nothing, and say so.
        logger.warning("sources: all %d jobs look superseded — version data inconsistent, merging all", len(job_ids))
        return list(job_ids), []
    return kept, dropped
