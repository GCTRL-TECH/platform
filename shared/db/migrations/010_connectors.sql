-- OAuth Connectors for external data sources (Google, Microsoft, Slack, GitHub)

CREATE TYPE connector_provider AS ENUM ('google', 'microsoft', 'slack', 'github');

CREATE TABLE oauth_connectors (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider connector_provider NOT NULL,
  label VARCHAR(255) NOT NULL,
  access_token TEXT NOT NULL,
  refresh_token TEXT,
  token_expires_at TIMESTAMPTZ,
  scopes JSONB DEFAULT '[]',
  provider_account_id VARCHAR(255),
  provider_email VARCHAR(255),
  metadata JSONB DEFAULT '{}',
  is_active BOOLEAN DEFAULT true,
  last_sync_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_oauth_connectors_user ON oauth_connectors(user_id);
CREATE INDEX idx_oauth_connectors_provider ON oauth_connectors(provider);

CREATE TABLE connector_sync_jobs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  connector_id UUID NOT NULL REFERENCES oauth_connectors(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_type VARCHAR(50) NOT NULL,
  source_id VARCHAR(500) NOT NULL,
  source_name VARCHAR(1000),
  kex_job_id UUID REFERENCES jobs(id),
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  error TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_connector_sync_jobs_connector ON connector_sync_jobs(connector_id);
CREATE INDEX idx_connector_sync_jobs_user ON connector_sync_jobs(user_id);
CREATE INDEX idx_connector_sync_jobs_status ON connector_sync_jobs(status);
