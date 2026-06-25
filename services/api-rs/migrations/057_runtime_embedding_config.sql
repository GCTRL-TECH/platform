-- Add per-runtime embedding config columns to the singleton runtime_config table.
-- These are set when embedding_mode is switched to 'advanced' via POST /api/infra/reindex.
-- NULL = unset → worker uses its env defaults (backward compatible).
ALTER TABLE runtime_config
    ADD COLUMN IF NOT EXISTS embedding_model    TEXT,
    ADD COLUMN IF NOT EXISTS embedding_base     TEXT,
    ADD COLUMN IF NOT EXISTS embedding_provider TEXT;

COMMENT ON COLUMN runtime_config.embedding_model    IS 'Advanced embedding model name (e.g. text-embedding-3-small). NULL = use worker default.';
COMMENT ON COLUMN runtime_config.embedding_base     IS 'Embedding endpoint base URL. NULL = use worker default.';
COMMENT ON COLUMN runtime_config.embedding_provider IS 'Embedding provider (ollama|openai|nim). NULL = use worker default.';
