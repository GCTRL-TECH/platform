-- OIDC CSRF protection.
--
-- The OAuth `state` parameter was generated in oidc_authorize but never
-- persisted or validated in oidc_callback, leaving the SSO login flow open to
-- CSRF / code-injection. This table holds each issued state as a single-use,
-- short-lived token. oidc_authorize inserts it; oidc_callback consumes it
-- (DELETE … RETURNING) and rejects the login if it's absent or expired.

CREATE TABLE IF NOT EXISTS oidc_states (
  state      TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_oidc_states_created ON oidc_states(created_at);
