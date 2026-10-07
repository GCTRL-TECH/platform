# Removing knowledge from a knowledge base

Every piece of knowledge in GCTRL enters through a job: a KEX extraction, an agent `store`, a file ingest, a connector sync. This document explains how a job's contribution is tracked, how to take it out again (from one knowledge base or from everywhere), who may do that, and what stays behind.

## The short version

- Every job records who sent it: `jobs.api_key_id` (the access token) and `jobs.user_id` (the account). Web logins have no token.
- Every graph element and every text chunk knows which jobs produced it. Nodes and relationships carry `_source_jobs`, chunks carry `job_id`, Qdrant points carry `job_id` in their payload. Fused graphs carry the same list on their merged nodes and merged relationships.
- "Remove from this knowledge base" takes the job out of that knowledge base's `source_job_ids`. If no other knowledge base still uses the job, GCTRL purges the job completely.
- "Delete everywhere" purges the job from all knowledge bases, the graph, the chunks and the vectors in one step.
- Elements that other jobs also produced survive with one contributor less. Nothing shared disappears.

## How a job is tracked

| Store | Field | Written by |
|---|---|---|
| Postgres `jobs` | `api_key_id`, `user_id`, `source_document_id`, `input.fileName` | API on every ingest route and MCP tool |
| Postgres `compilations` | `source_job_ids` | KEX linking, FUSE, `link_job_to_compilation` |
| Neo4j raw nodes and relationships | `_source_jobs` (list), `_source_job` (last contributor) | `services/kex/src/kg_builder.py` |
| Neo4j merged nodes and relationships (`:Merged`) | `_source_jobs` = union of all member lists, `_compilation` | `services/fuse/src/merger.py` |
| Postgres `text_chunks` | `job_id`, `source_document_id` | KEX worker, fact log |
| Qdrant payload | `job_id`, `source_job`, `compilation_id` | `services/kex/src/vector_store.py` |

The API exposes this on `GET /kex/jobs` (filters `search`, `token`, `kb`, `all`) and `GET /kex/jobs/:id` (provenance, chunk sample, graph footprint with exclusive counts). The footprint is the preview the UI shows before any removal.

## The two operations

### Remove from one knowledge base

`POST /kex/jobs/:id/unlink { compilationId }`

1. GCTRL removes the job from that knowledge base's `source_job_ids`.
2. If the knowledge base is fused (it has `:Merged` nodes), GCTRL queues a FUSE refresh. The merger first deletes the old merged elements of that knowledge base and rebuilds them from the remaining sources.
3. If no knowledge base references the job any more, GCTRL runs "delete everywhere" for it.

The UI offers this in the job detail (one button per knowledge base), in the FUSE job detail ("Remove from this graph") and in the knowledge base's source list. `PUT /kg/compilations/:id` with a shorter `sourceJobIds` list runs the same logic for every removed job.

### Delete everywhere

`DELETE /kex/jobs/:id`, or the MCP tool `delete_extraction { jobId }`

1. Unlink the job from every knowledge base.
2. Graph: `purge_jobs` drops the job from every `_source_jobs` list, relationships first, then nodes. Elements whose list becomes empty are deleted. This covers raw and merged elements alike.
3. Chunks: delete `text_chunks` rows of the job, then the Qdrant points by `job_id` filter.
4. Source documents: delete `source_documents` rows that no other job references.
5. Dossiers: mark `entity_dossiers` whose entity lost this job as stale, so the next read rebuilds them.
6. Write a `knowledge_corrections` row of kind `job_removed` with job, token and user.
7. Delete the job row.

## Who may remove what

| Caller | Sees in the job list | May remove |
|---|---|---|
| Scoped access token (for example an Anvil personal key) | Only jobs sent with that token | Only those jobs, and only in knowledge bases where the token has a read-write grant |
| Account owner (web login) | All jobs of the account | All of them |
| Admin role (web login) with `all=1` | Jobs of every user | All of them |

A read-only grant (`api_key_grants.read_only`) blocks removal in that knowledge base the same way it blocks writes. The MCP gateway applies the same rules, so an agent can only undo what it (or its token) added.

## What stays behind, by design

- **Shared facts.** A node or relationship that two jobs produced keeps the other job's membership. Only exclusive elements disappear.
- **Property values on shared nodes.** KEX writes node properties with `n += $props`, so the last job wins. Removing that job does not restore the earlier values. A re-extraction of the remaining sources fixes this.
- **Wiki pages.** Distilled wiki pages cite nodes and chunks, but GCTRL does not rebuild them on removal. Run the wiki's distill trigger again.
- **Conflicts and co-activation.** `fact_conflicts` and `memory_coactivation` rows that point to deleted elements are cleaned by the nightly sweep, not synchronously.
- **Audit trail.** The `knowledge_corrections` row and the audit log keep the fact that something was removed, by whom, and when.

## Legacy data

Merged relationships written before this change carry no `_source_jobs`. The nightly sweep in `services/api-rs/src/background/mod.rs` deletes merged elements whose knowledge base no longer contains any of their sources, and a FUSE refresh rewrites a knowledge base with full lists. Raw elements have carried `_source_jobs` since the provenance release and need no migration.
