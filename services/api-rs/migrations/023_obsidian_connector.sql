-- Obsidian local vault connector — not OAuth; store vault URL and API token.

CREATE TABLE IF NOT EXISTS obsidian_vaults (
  id           UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id      UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label        VARCHAR(255) NOT NULL DEFAULT 'Obsidian Vault',
  vault_url    TEXT         NOT NULL DEFAULT 'https://127.0.0.1:27124',
  api_token    TEXT,
  is_active    BOOLEAN      NOT NULL DEFAULT true,
  last_sync_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_obsidian_vaults_user ON obsidian_vaults(user_id);
