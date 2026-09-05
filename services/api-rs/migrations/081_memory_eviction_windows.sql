-- Memory governance: eviction was too eager and left the HOT tier empty.
--
-- background/mod.rs evicted (soft-archived) any non-pinned dossier and any
-- once-used chunk whose heat had decayed below 0.5 after ONE idle hour. With
-- decay x0.95 per 600s tick that is ~8h for a freshly promoted dossier and ~3.5h
-- for a chunk that grounded exactly one answer - i.e. every night. Archived
-- dossiers are invisible to fetch_dossier_row (archived = false), so the next
-- get_dossier reported "no dossier" and rebuilt it through the LLM; archived
-- chunks drop out of lexical retrieval (kex _scope_sql). Seen on a live
-- instance: 1 dossier live, 46 archived, 1141 chunks archived.
--
-- The worker now evicts dossiers only after 7 idle days and chunks after 30.
-- This migration (1) records WHY a row was archived so eviction can be told
-- apart from A5 dedup (whose duplicates must stay archived - their vectors are
-- gone), and (2) revives everything the old policy evicted.

ALTER TABLE text_chunks     ADD COLUMN IF NOT EXISTS archived_reason TEXT;
ALTER TABLE entity_dossiers ADD COLUMN IF NOT EXISTS archived_reason TEXT;

-- Dossiers were only ever archived by eviction (pinned rows never are).
UPDATE entity_dossiers
   SET archived = false, archived_reason = NULL, updated_at = NOW()
 WHERE archived = true AND archived_reason IS NULL;

-- Chunks: eviction required last_accessed IS NOT NULL; dedup never touched it.
-- A dedup duplicate that had also been accessed is revived too - the cost is a
-- near-duplicate passage in lexical results, the alternative is lost knowledge.
UPDATE text_chunks
   SET archived = false, archived_reason = NULL
 WHERE archived = true AND archived_reason IS NULL AND last_accessed IS NOT NULL;
