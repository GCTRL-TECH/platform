-- Compilation type (RAW vs WIKI) + wiki_pages table.
--
-- RAW compilations are the existing graph compilations (KEX/FUSE output).
-- WIKI compilations are a *distilled* human-readable view derived from a single
-- RAW source compilation. A WIKI compilation references its source via
-- `wiki_source_compilation_id` and holds zero graph data of its own — instead it
-- owns rows in `wiki_pages` produced by a `distill_wiki` job.
--
-- Note on enums: the project converted job_type to a TEXT column with a CHECK
-- constraint (migration 017), so we extend `jobs_type_check` rather than an enum.
-- The new `trigger_module` value ('distill') is added in a SEPARATE migration
-- (046) because Postgres forbids using a freshly-added enum value in the same
-- transaction; keeping it isolated keeps every migration txn-safe.

CREATE TYPE compilation_type AS ENUM ('RAW', 'WIKI');

ALTER TABLE compilations
  ADD COLUMN type compilation_type NOT NULL DEFAULT 'RAW',
  ADD COLUMN wiki_source_compilation_id UUID REFERENCES compilations(id) ON DELETE SET NULL,
  ADD COLUMN last_distill_at TIMESTAMPTZ,
  ADD COLUMN page_count INTEGER NOT NULL DEFAULT 0;

CREATE INDEX idx_compilations_type ON compilations(type);

-- Extend the jobs type CHECK to allow the distillation job type.
-- (Mirrors the existing constraint from migration 021, plus 'distill_wiki'.)
ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_type_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_type_check CHECK (
  type IN (
    'kex_extract',
    'kex_upload',
    'fuse_merge',
    'kex_connector',
    'kex_url',
    'kex_sharepoint',
    'kex_obsidian',
    'distill_wiki'
  )
);

-- Human-readable wiki pages distilled from a WIKI compilation's RAW source.
-- `kind` distinguishes page types (e.g. 'entity', 'overview', 'topic').
-- `citations` carries provenance back to source nodes/chunks. `content_hash`
-- lets the distiller skip re-writing unchanged pages on incremental refresh.
CREATE TABLE wiki_pages (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  compilation_id UUID NOT NULL REFERENCES compilations(id) ON DELETE CASCADE,
  kind VARCHAR(20) NOT NULL,
  slug VARCHAR(512) NOT NULL,
  title VARCHAR(512) NOT NULL,
  entity_uri TEXT,
  body_md TEXT NOT NULL,
  citations JSONB NOT NULL DEFAULT '[]',
  content_hash TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  last_distilled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(compilation_id, slug)
);

CREATE INDEX idx_wiki_pages_comp ON wiki_pages(compilation_id);
