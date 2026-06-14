-- OIDC replay/CSRF hardening: bind a nonce to each pending OAuth state.
--
-- The nonce is generated in oidc_authorize, sent to the IdP in the auth
-- request, and verified inside the (now JWKS-validated) id_token in
-- oidc_callback — proving the id_token was minted for THIS login attempt.
-- The state value is additionally bound to the initiating browser via an
-- HttpOnly cookie checked at the callback.

ALTER TABLE oidc_states ADD COLUMN IF NOT EXISTS nonce TEXT;
