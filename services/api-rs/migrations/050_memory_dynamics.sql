-- A4 MEMORY DYNAMICS — heat on chunks, decay/eviction (soft-archive), trust feedback.
--
-- Builds on A2/A3 (entity_dossiers already carries heat/trust/access_count/
-- last_accessed). This migration extends the SAME dynamics down to the COLD tier
-- (text_chunks) and adds a soft-archive flag so the maintenance worker can evict
-- without hard-deleting knowledge.
--
-- HEAT on chunks: every chunk that is actually returned by retrieval and used in
-- an answer gets heat += 1 / access_count += 1 / last_accessed = NOW() (bumped in
-- a cheap batch UPDATE keyed by id, mirroring bump_dossier_heat).
--
-- DECAY / EVICTION: a background maintenance tick (api-rs background/mod.rs) decays
-- heat (×0.95) on idle items, PROMOTES hot/high-degree non-dossiered entities into
-- dossiers, and soft-ARCHIVES cold non-pinned dossiers/chunks (archived = true) so
-- retrieval can skip them. Pinned dossiers are NEVER archived. Nothing is hard-
-- deleted — archived rows stay queryable and can be revived if accessed again.

-- ── text_chunks: heat columns (HOT/COLD memory signal for the chunk tier) ──────
ALTER TABLE text_chunks
    ADD COLUMN IF NOT EXISTS heat          REAL        NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS access_count  INTEGER     NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS last_accessed TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS archived      BOOLEAN     NOT NULL DEFAULT false;

-- The maintenance worker scans chunks by (user, heat) to find decay/evict
-- candidates; retrieval may filter archived. A partial index keeps the
-- "live, non-archived" working set cheap to scan.
CREATE INDEX IF NOT EXISTS idx_text_chunks_user_heat
    ON text_chunks (user_id, heat)
    WHERE archived = false;

-- ── entity_dossiers: soft-archive flag (eviction without data loss) ────────────
ALTER TABLE entity_dossiers
    ADD COLUMN IF NOT EXISTS archived BOOLEAN NOT NULL DEFAULT false;

-- The decay worker scans dossiers by (user, heat) for the live set; the existing
-- idx_entity_dossiers_heat covers (user_id, heat). Add a partial index so the hot-
-- block lookup + decay scan skip archived rows without a seq-scan.
CREATE INDEX IF NOT EXISTS idx_entity_dossiers_live
    ON entity_dossiers (user_id, lower(entity_name))
    WHERE archived = false;
