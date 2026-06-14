-- Add SharePoint-specific columns to oauth_connectors and a table for
-- multi-tenant Azure AD configurations.

ALTER TABLE oauth_connectors
  ADD COLUMN IF NOT EXISTS tenant_id VARCHAR(255),
  ADD COLUMN IF NOT EXISTS sharepoint_url TEXT;

CREATE TABLE IF NOT EXISTS sharepoint_tenant_configs (
  id                 UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id            UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id          VARCHAR(255) NOT NULL,
  tenant_name        VARCHAR(255),
  client_id          TEXT         NOT NULL,
  client_secret      TEXT         NOT NULL,
  sharepoint_root_url TEXT        NOT NULL,
  is_active          BOOLEAN      NOT NULL DEFAULT true,
  created_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, tenant_id)
);

CREATE INDEX IF NOT EXISTS idx_sharepoint_tenants_user ON sharepoint_tenant_configs(user_id);
