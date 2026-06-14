-- A7 MEMORY GOVERNANCE CYCLE — run-summary persistence.
--
-- The memory-maintenance worker (api-rs background/mod.rs) was a loose set of
-- decay/promote/evict passes. A7 consolidates them into ONE ordered cycle
--   decay → dedup → promote → evict → dossier-refresh
-- and records a structured summary of every run here, so the Memory Health panel
-- can show "when did maintenance last run, and what did it do".
--
-- This is an append-only audit/log table (not single-row): each run inserts one
-- row. The health endpoint reads the most recent row. Bounded growth is handled
-- by a cheap retention prune in the worker (keep the last N rows).
--
-- Counts are per-step so the panel can render a breakdown. `trigger` distinguishes
-- the 600s scheduled cycle from an operator-pressed "Run maintenance now". `summary`
-- carries the full structured payload (same shape the endpoint returns) for forward
-- compat without a migration every time we add a metric.

CREATE TABLE IF NOT EXISTS memory_cycle_runs (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    started_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at   TIMESTAMPTZ,
    duration_ms   BIGINT      NOT NULL DEFAULT 0,
    trigger       TEXT        NOT NULL DEFAULT 'scheduled',  -- 'scheduled' | 'manual'

    -- Per-step counts.
    decayed_dossiers INTEGER NOT NULL DEFAULT 0,
    decayed_chunks   INTEGER NOT NULL DEFAULT 0,
    deduped_chunks   INTEGER NOT NULL DEFAULT 0,  -- duplicates archived by the dedup pass
    promoted         INTEGER NOT NULL DEFAULT 0,  -- entities promoted to dossiers
    evicted_dossiers INTEGER NOT NULL DEFAULT 0,
    evicted_chunks   INTEGER NOT NULL DEFAULT 0,

    -- Full structured payload (mirrors the /memory/health "lastRun" shape).
    summary JSONB NOT NULL DEFAULT '{}'::jsonb
);

-- The health endpoint always reads the single most-recent run.
CREATE INDEX IF NOT EXISTS idx_memory_cycle_runs_started
    ON memory_cycle_runs (started_at DESC);
