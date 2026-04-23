-- Job batches: group multiple KEX jobs from folder syncs etc.

CREATE TABLE job_batches (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(500) NOT NULL,
  source VARCHAR(100),
  source_metadata JSONB DEFAULT '{}',
  total_jobs INTEGER NOT NULL DEFAULT 0,
  completed_jobs INTEGER NOT NULL DEFAULT 0,
  failed_jobs INTEGER NOT NULL DEFAULT 0,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_job_batches_user ON job_batches(user_id);
CREATE INDEX idx_job_batches_status ON job_batches(status);

ALTER TABLE jobs ADD COLUMN batch_id UUID REFERENCES job_batches(id) ON DELETE SET NULL;
CREATE INDEX idx_jobs_batch ON jobs(batch_id) WHERE batch_id IS NOT NULL;
