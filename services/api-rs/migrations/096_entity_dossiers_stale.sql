-- Migration 096 — dossiers can go stale when their sources are removed.
--
-- Removing an extraction job (DELETE /kex/jobs/:id, unlink from the last
-- knowledge base) deletes the graph nodes that only this job produced. A dossier
-- compiled from those nodes still states the facts, with nothing left to ground
-- them. Instead of deleting the dossier (it may still be pinned or hold facts
-- from other sources), the removal marks it stale; the next distillation /
-- maintenance cycle rebuilds or evicts it.
ALTER TABLE entity_dossiers
    ADD COLUMN IF NOT EXISTS stale BOOLEAN NOT NULL DEFAULT false;
