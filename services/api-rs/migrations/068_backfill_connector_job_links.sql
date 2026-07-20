-- Backfill connector / Obsidian-vault ingests that never linked into their graph.
--
-- These paths recorded their intended target in jobs.input->>'compilationId' but
-- never added the job to compilation.source_job_ids — the ONLY entity->graph
-- mapping (Neo4j nodes are per-owner, not per-compilation). So a job could COMPLETE
-- yet its nodes never appear in the chosen graph. The code now links at enqueue
-- (routes::kex::link_owned_job); this repairs already-completed jobs in place.
--
-- Compared as text (c.id::text) to avoid casting untrusted JSON to uuid.

UPDATE compilations c
SET source_job_ids = ARRAY(
        SELECT DISTINCT x
        FROM unnest(
            c.source_job_ids || COALESCE(ARRAY(
                SELECT j.id
                FROM jobs j
                WHERE j.user_id = c.user_id
                  AND j.type IN ('kex_obsidian', 'kex_connector')
                  AND j.input->>'compilationId' = c.id::text
                  AND NOT (j.id = ANY(c.source_job_ids))
            ), ARRAY[]::uuid[])
        ) x
    ),
    updated_at = NOW()
WHERE EXISTS (
    SELECT 1 FROM jobs j
    WHERE j.user_id = c.user_id
      AND j.type IN ('kex_obsidian', 'kex_connector')
      AND j.input->>'compilationId' = c.id::text
      AND NOT (j.id = ANY(c.source_job_ids))
);
