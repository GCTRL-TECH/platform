-- External infrastructure overrides for swappable bundled services.
--
-- GCTRL ships with a bundled stack (Neo4j, Qdrant, Ollama, Postgres, Redis).
-- This table lets an operator point GCTRL at an EXTERNAL instance of a swappable
-- service instead of the bundled one. One row per service.
--
-- `secret` is sealed at rest via services/crypto.rs (`v1:<nonce>:<ciphertext>`),
-- same scheme as user_llm_providers.api_key and connector_configs.client_secret.
-- It is decrypted on use and never returned to the client (a boolean `hasSecret`
-- is surfaced instead).
--
-- Apply semantics are honest, not magical:
--   - ollama / qdrant overrides can take effect for new outbound HTTP requests.
--   - postgres / neo4j connection pools are established at boot, so saving an
--     override here is persisted but requires a GCTRL restart to take effect.
-- The UI documents this per service.

CREATE TABLE IF NOT EXISTS service_overrides (
  service    TEXT PRIMARY KEY,
  url        TEXT,
  username   TEXT,
  secret     TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
