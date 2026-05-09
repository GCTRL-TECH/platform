-- Connector OAuth app configurations (client ID/secret per provider)
-- Stored in DB so admins can configure via frontend without restart

CREATE TABLE connector_configs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  provider VARCHAR(50) NOT NULL UNIQUE,
  client_id TEXT NOT NULL,
  client_secret TEXT NOT NULL,
  extra JSONB DEFAULT '{}',
  is_active BOOLEAN DEFAULT true,
  updated_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_connector_configs_provider ON connector_configs(provider);
