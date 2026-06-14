-- SSO configuration per organization/user
-- Supports OIDC (OpenID Connect) providers: Okta, Azure AD, Keycloak, Google Workspace

CREATE TABLE IF NOT EXISTS sso_configs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE, -- admin who configured it
  provider VARCHAR(50) NOT NULL, -- 'okta', 'azure', 'keycloak', 'google'
  issuer_url TEXT NOT NULL,       -- OIDC discovery URL
  client_id TEXT NOT NULL,
  client_secret TEXT NOT NULL,
  redirect_uri TEXT,
  scopes TEXT[] NOT NULL DEFAULT ARRAY['openid','email','profile'],
  default_role VARCHAR(50) NOT NULL DEFAULT 'viewer',
  default_clearance_rank INTEGER NOT NULL DEFAULT 100,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- SSO-linked identity on each user
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS sso_provider VARCHAR(50),
  ADD COLUMN IF NOT EXISTS sso_subject TEXT,   -- `sub` claim from the IdP token
  ADD COLUMN IF NOT EXISTS sso_attributes JSONB; -- arbitrary claims from IdP

CREATE INDEX IF NOT EXISTS idx_users_sso ON users(sso_provider, sso_subject);

-- SCIM provisioning tokens (separate from API keys, specific to SCIM v2)
CREATE TABLE IF NOT EXISTS scim_tokens (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE, -- admin owner
  token_hash VARCHAR(255) NOT NULL UNIQUE,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
