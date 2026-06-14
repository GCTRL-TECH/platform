-- SEC-2: account deactivation / SCIM deprovisioning enforcement.
--
-- Adds users.is_active. SCIM PATCH/PUT with `active=false` now actually
-- deprovisions: is_active is set false, the user's api_keys are revoked
-- (deleted), and the auth middleware + login reject any request from an
-- inactive user (401/403). Refresh tokens are stateless JWTs, so the next
-- access-token refresh / API call is blocked by the is_active check.
--
-- Defaults to true so all existing accounts stay active.
--
-- NOTE (SEC-3): the secret-vault encrypted-columns set (see 038_secret_vault.sql)
-- is extended by this change to also cover:
--   sso_configs.client_secret
-- which is now sealed via crypto::seal on write (routes/sso.rs create_sso_config),
-- decrypted via crypto::open at the OIDC token exchange, and backfill-encrypted on
-- boot by crypto::backfill_encrypt_secrets. (Documented here rather than editing
-- 038 to avoid breaking the checksum of an already-applied migration.)

ALTER TABLE users ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true;
