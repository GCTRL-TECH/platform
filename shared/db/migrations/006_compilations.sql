CREATE TABLE compilations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  source_job_ids UUID[] DEFAULT '{}',
  classification user_clearance NOT NULL DEFAULT 'PUBLIC',
  version INTEGER NOT NULL DEFAULT 1,
  cron_schedule VARCHAR(100),
  cron_mode VARCHAR(20) DEFAULT 'incremental',
  last_refresh_at TIMESTAMPTZ,
  node_count INTEGER NOT NULL DEFAULT 0,
  edge_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_compilations_user ON compilations(user_id);
CREATE INDEX idx_compilations_classification ON compilations(classification);

CREATE TABLE compilation_acl (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  compilation_id UUID NOT NULL REFERENCES compilations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permission VARCHAR(20) NOT NULL DEFAULT 'read',
  granted_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(compilation_id, user_id)
);

CREATE INDEX idx_compilation_acl_compilation ON compilation_acl(compilation_id);
CREATE INDEX idx_compilation_acl_user ON compilation_acl(user_id);

ALTER TYPE job_type ADD VALUE IF NOT EXISTS 'fuse_merge';
