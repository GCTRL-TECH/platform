-- Adds the reported_version column to the licenses table.
-- Stores the agent's self-reported instance version (sent on each heartbeat).
-- Idempotent: safe to run multiple times. Applied automatically on container
-- boot by src/db/migrate.ts; this file exists for manual application on the VPS.
ALTER TABLE licenses ADD COLUMN IF NOT EXISTS reported_version text;
