-- Default, non-deletable, multi-source, auto-maintained "Knowledge Wiki".
--
-- This migration turns the WIKI distillation feature into a first-class default
-- component that exists in every installation:
--
--   1. `is_system` flag on compilations → marks a compilation as a built-in that
--      the delete handler refuses to remove (mirrors the canonical default
--      ontology's fixed-id 403 protection). The frontend hides the delete control.
--
--   2. `wiki_sources` link table → a WIKI compilation may distil from MULTIPLE
--      RAW source graphs (the user picks them). The legacy single-source column
--      `wiki_source_compilation_id` is kept working for back-compat and is treated
--      as the "single source" case (the distiller unions both).
--
--   3. Backfill → every EXISTING user gets exactly one default "Knowledge Wiki"
--      (type=WIKI, is_system=true) plus an active `distill` cron trigger that
--      re-distills it on a schedule (every 10 minutes). New users get the same in
--      `auth.rs::register`.
--
-- Idempotent: re-running creates no duplicates (guards on is_system + a WHERE NOT
-- EXISTS, and the trigger insert is keyed on the wiki's compilation id in config).

-- ── 1. System flag ────────────────────────────────────────────────────────────
ALTER TABLE compilations
  ADD COLUMN IF NOT EXISTS is_system BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_compilations_is_system
  ON compilations(is_system) WHERE is_system = TRUE;

-- ── 2. Multi-source link table ────────────────────────────────────────────────
-- (wiki_compilation_id, source_compilation_id) — both reference compilations.
-- The wiki side is the WIKI comp; the source side must be a RAW comp owned by the
-- same user (validated in the API layer; FK guarantees referential integrity).
CREATE TABLE IF NOT EXISTS wiki_sources (
  wiki_compilation_id   UUID NOT NULL REFERENCES compilations(id) ON DELETE CASCADE,
  source_compilation_id UUID NOT NULL REFERENCES compilations(id) ON DELETE CASCADE,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (wiki_compilation_id, source_compilation_id)
);

CREATE INDEX IF NOT EXISTS idx_wiki_sources_wiki ON wiki_sources(wiki_compilation_id);

-- Migrate any existing legacy single-source links into the new table so the
-- distiller's union logic sees them uniformly. (No-op on a fresh install.)
INSERT INTO wiki_sources (wiki_compilation_id, source_compilation_id)
SELECT id, wiki_source_compilation_id
  FROM compilations
 WHERE type = 'WIKI' AND wiki_source_compilation_id IS NOT NULL
ON CONFLICT DO NOTHING;

-- ── 3. Backfill: one default Knowledge Wiki per existing user ──────────────────
-- Create a WIKI compilation named "Knowledge Wiki" (is_system) for every user who
-- does not already own a system wiki. wiki_source_compilation_id is left NULL —
-- the user wires sources later via PUT /wiki/sources; distillation simply writes
-- 0 pages until a source is selected.
INSERT INTO compilations
    (id, user_id, name, description, classification, type, is_system, cron_schedule, cron_mode)
SELECT gen_random_uuid(), u.id, 'Knowledge Wiki',
       'Your automatically maintained, LLM-distilled knowledge wiki. Pick which graphs feed it; it re-distils itself on a schedule.',
       'INTERNAL', 'WIKI'::compilation_type, TRUE, '*/10 * * * *', 'incremental'
  FROM users u
 WHERE NOT EXISTS (
     SELECT 1 FROM compilations c
      WHERE c.user_id = u.id AND c.type = 'WIKI' AND c.is_system = TRUE
 );

-- ── 4. Backfill: an active distill trigger for every default Knowledge Wiki ────
-- The cron executor (background::run_cron_tick) picks up active `distill` triggers
-- and enqueues a distill_wiki job. config.compilationId ties the trigger to its
-- wiki. Guard prevents a duplicate trigger for the same wiki.
INSERT INTO triggers
    (id, user_id, name, module, type, status, cron_schedule, config, next_run_at)
SELECT gen_random_uuid(), c.user_id, 'Auto-distill: Knowledge Wiki',
       'distill'::trigger_module, 'cron'::trigger_type, 'active',
       '*/10 * * * *',
       jsonb_build_object('compilationId', c.id::text),
       NOW()
  FROM compilations c
 WHERE c.type = 'WIKI' AND c.is_system = TRUE
   AND NOT EXISTS (
       SELECT 1 FROM triggers t
        WHERE t.module = 'distill'
          AND t.config->>'compilationId' = c.id::text
   );
