-- PII detection log: stores detected PII entity type counts (never actual values).
-- Linked to the job that generated them.
-- DSGVO-compliant: type+count only, raw PII values never stored.

CREATE TABLE IF NOT EXISTS pii_findings (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  job_id UUID REFERENCES jobs(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entity_types JSONB NOT NULL DEFAULT '[]', -- [{type, count}]
  total_count INTEGER NOT NULL DEFAULT 0,
  was_redacted BOOLEAN NOT NULL DEFAULT false,
  language VARCHAR(10) DEFAULT 'en',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pii_findings_job ON pii_findings(job_id);
CREATE INDEX IF NOT EXISTS idx_pii_findings_user ON pii_findings(user_id);
CREATE INDEX IF NOT EXISTS idx_pii_findings_created ON pii_findings(created_at);
