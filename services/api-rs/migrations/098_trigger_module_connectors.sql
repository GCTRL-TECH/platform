-- 098: scheduled connector syncs can be created.
--
-- The cron executor (background/mod.rs run_cron_tick) has run triggers with
-- module 'google_drive' (Drive folder re-sync) and 'microsoft' (SharePoint
-- library re-sync) for a while, but the trigger_module enum never carried
-- those values, so no such trigger could be stored and the API refused them.
-- Since the same release, a re-sync only extracts files that are new or
-- changed (same modified time or same content = existing extraction reused),
-- which is what makes a regular schedule affordable.

ALTER TYPE trigger_module ADD VALUE IF NOT EXISTS 'google_drive';
ALTER TYPE trigger_module ADD VALUE IF NOT EXISTS 'microsoft';
