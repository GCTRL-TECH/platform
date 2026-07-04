-- P6 FILE-ASSET INDEX — searchable metadata for EVERY file a connector sees.
--
-- Connectors (Google Drive / SharePoint) previously SKIPPED non-extractable
-- files (CAD .dwg/.step, images, archives) silently. When the operator enables
-- `index_unsupported_files` (per provider, in connector_configs.extra), every
-- listed file gets a metadata row here — path, name, size, modified time,
-- first/last seen — so an agent can answer "where is the rim CAD file and when
-- was it last seen?". Relatedness to parsed documents is resolved at QUERY time
-- (siblings in the same folder_path), not stored as edges.
--
-- `extractable=true` rows are the parsed documents themselves (they also carry
-- their kex_job_id), which is what powers the query-time sibling join.

CREATE TABLE file_assets (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  connector_id  UUID REFERENCES oauth_connectors(id) ON DELETE SET NULL,
  source        VARCHAR(50),
  path          TEXT NOT NULL,
  folder_path   TEXT,
  name          TEXT NOT NULL,
  ext           VARCHAR(20),
  size_bytes    BIGINT,
  modified_at   TIMESTAMPTZ,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  extractable   BOOLEAN NOT NULL DEFAULT false,
  kex_job_id    UUID REFERENCES jobs(id) ON DELETE SET NULL,
  UNIQUE (user_id, path)
);

CREATE INDEX idx_file_assets_user ON file_assets(user_id);
-- Sibling join for query-time relatedness ("parsed docs in the same folder").
CREATE INDEX idx_file_assets_user_folder ON file_assets(user_id, folder_path);

-- Trigram indexes power fuzzy find_file (name/path similarity). Best-effort:
-- pg_trgm may not be installed in every environment (mirrors 048), so guard the
-- whole block — find_file falls back to ILIKE when similarity() is unavailable.
DO $$
BEGIN
  BEGIN
    CREATE EXTENSION IF NOT EXISTS pg_trgm;
    CREATE INDEX IF NOT EXISTS idx_file_assets_name_trgm
      ON file_assets USING GIN (name gin_trgm_ops);
    CREATE INDEX IF NOT EXISTS idx_file_assets_path_trgm
      ON file_assets USING GIN (path gin_trgm_ops);
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'pg_trgm unavailable (%) — find_file falls back to ILIKE; non-fatal', SQLERRM;
  END;
END $$;

-- Scheduled connector re-sync: allow google_drive / microsoft triggers alongside
-- the existing obsidian + distill modules (executed by background::run_cron_tick).
ALTER TYPE trigger_module ADD VALUE IF NOT EXISTS 'google_drive';
ALTER TYPE trigger_module ADD VALUE IF NOT EXISTS 'microsoft';
