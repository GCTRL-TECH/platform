-- Add 'distill' to the trigger_module enum so WIKI compilations can be
-- scheduled (cron) to re-distill their RAW source into wiki_pages.
--
-- Kept in its own migration file (separate transaction) because Postgres does
-- not allow a newly added enum value to be *used* in the same transaction it was
-- created in. We only declare it here. This mirrors migration 040, which added
-- 'obsidian' to the same enum.
ALTER TYPE trigger_module ADD VALUE IF NOT EXISTS 'distill';
