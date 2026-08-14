"""Cypher fragments for job-scoped access to the graph.

A node or edge carries two provenance properties:

* ``_source_job``  - the LAST job that touched it. Display and lineage only.
* ``_source_jobs`` - every job that contributed to it. Authoritative for
  scoping and for deletion: an element is garbage exactly when this list is
  empty, because compilation membership resolves
  compilation -> ``source_job_ids`` -> ``_source_jobs``.

Nodes are URI-merged across jobs, so testing ``_source_job`` alone answers the
wrong question ("who touched it last?" instead of "does it belong to me?"). Use
:func:`job_scope` for every membership test.

Mirrors ``services/api-rs/src/services/neo4j.rs`` - keep the two in step.
"""


def source_jobs_expr(alias: str) -> str:
    """Full job membership of ``alias`` as a list.

    The inner CASE is the fallback for elements written before ``_source_jobs``
    existed; migration 075 backfills them, but queries must stay correct while
    that is still running.
    """
    return (
        f"coalesce({alias}._source_jobs, "
        f"CASE WHEN {alias}._source_job IS NULL THEN [] ELSE [{alias}._source_job] END)"
    )


def job_scope(alias: str, param: str = "job_ids") -> str:
    """Predicate: does ``alias`` belong to any job in ``$param``?"""
    return f"any(__sj IN {source_jobs_expr(alias)} WHERE __sj IN ${param})"
