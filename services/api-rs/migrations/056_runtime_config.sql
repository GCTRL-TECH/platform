-- Global operator-level runtime configuration — a SINGLETON table (only ever one
-- row, enforced by the CHECK constraint).  NULL provider means "unset" → the
-- resolution chain falls back to the bundled Ollama default, so behaviour is
-- identical to today when no row is present.
CREATE TABLE IF NOT EXISTS runtime_config (
  id             INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  provider       TEXT,          -- NULL / empty = unset → Ollama fallback (no row needed)
  base_url       TEXT,
  model          TEXT,
  api_key        TEXT,          -- AES-256-GCM sealed (crypto::seal), nullable
  embedding_mode TEXT NOT NULL DEFAULT 'pinned',  -- 'pinned' | 'advanced'
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- No default row is inserted — absence of a row equals "unset" so existing
-- installs keep their current Ollama behaviour with zero config change.
