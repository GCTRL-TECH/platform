-- Extend api_keys with clearance scoping and expiry.
-- A key with max_clearance_rank=0 can only see PUBLIC data regardless of the
-- user's actual clearance — enforced at the auth middleware layer.

ALTER TABLE api_keys
  ADD COLUMN IF NOT EXISTS max_clearance_rank INTEGER NOT NULL DEFAULT 100,
  ADD COLUMN IF NOT EXISTS max_clearance_level VARCHAR(100) DEFAULT 'INTERNAL',
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

-- Pre-key value (raw, not hashed) is stored transiently in app memory.
-- The stored key_hash is SHA-256. key_prefix holds the first 12 chars of
-- the raw key so users can identify which key is which in the UI.
ALTER TABLE api_keys
  ADD COLUMN IF NOT EXISTS key_prefix VARCHAR(20);
