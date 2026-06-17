-- Per-user, per-purpose model selection so the embedding / relation-extraction /
-- distill / chat models are configurable from the UI instead of being hardcoded
-- in the kex/fuse env. NULL on any column means "use the recommended default"
-- (nomic-embed-text / qwen2.5:7b / llama3.2) — so existing installs keep working
-- with zero config and the defaults stay our fast local setup.
CREATE TABLE IF NOT EXISTS user_model_prefs (
  user_id            UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  -- KEX embedding. Kept LOCAL by default (cloud embeddings burn tokens + add
  -- latency on high volume). provider/base override allow a cloud embedder as a
  -- deliberate alternative; NULL = the user's configured Ollama, local.
  embedding_model    TEXT,
  embedding_provider TEXT,
  embedding_base_url TEXT,
  -- KEX relation extraction model + FUSE wiki-distillation model. NULL = default.
  relation_model     TEXT,
  distill_model      TEXT,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
