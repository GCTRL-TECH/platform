-- Stop the runaway auto-distill: the per-user default trigger was seeded as a
-- `cron */10 * * * *`, and cron-kind distill triggers fire on schedule WITHOUT
-- the wiki_has_new_content staleness check (that guard only applies to
-- change_detection). Result: every idle Knowledge Wiki re-distilled every 10
-- minutes — ~600 pointless LLM jobs/hour across ~100 users, 236k distill_wiki
-- rows on the dev box.
--
-- Convert ONLY the auto-seeded defaults (matched by name + the default schedule)
-- to change_detection heartbeats: checked every executor tick, enqueue only when
-- a source graph actually gained content. User-created custom cron triggers keep
-- their scheduled-regeneration semantics untouched.

UPDATE triggers
SET type = 'change_detection'::trigger_type,
    cron_schedule = NULL,
    updated_at = NOW()
WHERE module = 'distill'::trigger_module
  AND type = 'cron'::trigger_type
  AND cron_schedule = '*/10 * * * *'
  AND name = 'Auto-distill: Knowledge Wiki';
