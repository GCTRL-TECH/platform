-- Add 'obsidian' to the trigger_module enum so Obsidian folder/REST vaults can
-- be scheduled (cron) or heartbeat-driven (change_detection) re-ingest.
--
-- Postgres 12+ permits ALTER TYPE ... ADD VALUE inside a transaction as long as
-- the new value is not *used* in the same transaction (we only declare it here).
-- Migration 006 already adds an enum value this way without a --no-transaction
-- directive, so the same pattern is safe here.
ALTER TYPE trigger_module ADD VALUE IF NOT EXISTS 'obsidian';
