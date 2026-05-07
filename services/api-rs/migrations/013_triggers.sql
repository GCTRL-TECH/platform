CREATE TYPE trigger_type AS ENUM ('cron', 'change_detection');
CREATE TYPE trigger_module AS ENUM ('kex', 'fuse', 'compilation');
CREATE TYPE trigger_status AS ENUM ('active', 'paused', 'error');

CREATE TABLE triggers (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  module trigger_module NOT NULL,
  type trigger_type NOT NULL,
  status trigger_status NOT NULL DEFAULT 'active',
  cron_schedule VARCHAR(100),
  config JSONB NOT NULL DEFAULT '{}',
  last_run_at TIMESTAMPTZ,
  next_run_at TIMESTAMPTZ,
  last_error TEXT,
  run_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_triggers_user ON triggers(user_id);
CREATE INDEX idx_triggers_status ON triggers(status);
CREATE INDEX idx_triggers_next_run ON triggers(next_run_at) WHERE status = 'active';

ALTER TABLE jobs ADD COLUMN trigger_id UUID REFERENCES triggers(id) ON DELETE SET NULL;
