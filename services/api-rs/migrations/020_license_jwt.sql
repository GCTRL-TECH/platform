-- 020_license_jwt.sql
-- Server-to-server token sync: persist the license JWT issued by license-api,
-- and mark each token_usage row as either synced or pending sync.

ALTER TABLE licenses ADD COLUMN IF NOT EXISTS license_jwt TEXT;
ALTER TABLE licenses ADD COLUMN IF NOT EXISTS license_jwt_updated_at TIMESTAMPTZ;

ALTER TABLE token_usage
  ADD COLUMN IF NOT EXISTS synced_to_license_api BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_token_usage_unsynced
  ON token_usage (user_id, created_at)
  WHERE synced_to_license_api = false;
