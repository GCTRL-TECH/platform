-- Per-user LLM provider connections for the Pi agent and Talk-to-Graph RAG.
--
-- Each row is one (user, provider) connection. The agent and RAG layer resolve a
-- target provider/model from this table at request time (see services/llm.rs):
-- the user's requested provider if active, else their active provider, else the
-- local Ollama default.
--
-- provider ∈ {ollama, openai, anthropic, openrouter}.
--   - ollama rows may have a NULL api_key and a custom base_url (local, no key).
--   - cloud rows store api_key encrypted at rest via services/crypto.rs
--     (`v1:<nonce>:<ciphertext>`); decrypted on use, masked/omitted on read.

CREATE TABLE IF NOT EXISTS user_llm_providers (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL,
  provider      TEXT NOT NULL,
  api_key       TEXT,
  base_url      TEXT,
  default_model TEXT,
  is_active     BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, provider)
);

CREATE INDEX IF NOT EXISTS idx_user_llm_providers_user ON user_llm_providers (user_id);
