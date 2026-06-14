-- Replace hardcoded classification TEXT+CHECK with a flexible table.
-- System levels (user_id IS NULL) map to ISO 27001 / TISAX / BSI Grundschutz.
-- Users can add custom levels (user_id = their UUID).

CREATE TABLE IF NOT EXISTS classification_levels (
  id           UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id      UUID         REFERENCES users(id) ON DELETE CASCADE,
  name         VARCHAR(100) NOT NULL,
  display_name VARCHAR(255) NOT NULL,
  rank         INTEGER      NOT NULL,
  color        VARCHAR(20)  NOT NULL DEFAULT '#6b7280',
  description  TEXT,
  icon         VARCHAR(50),
  is_system    BOOLEAN      NOT NULL DEFAULT false,
  is_active    BOOLEAN      NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE NULLS NOT DISTINCT (user_id, name)
);

CREATE INDEX IF NOT EXISTS idx_classification_levels_user ON classification_levels(user_id);
CREATE INDEX IF NOT EXISTS idx_classification_levels_rank ON classification_levels(rank);

INSERT INTO classification_levels (id, user_id, name, display_name, rank, color, description, is_system)
VALUES
  ('00000000-0000-0000-0000-000000000001', NULL, 'PUBLIC',               'Public',               0,   '#22c55e', 'No sensitivity — can be shared externally', true),
  ('00000000-0000-0000-0000-000000000002', NULL, 'INTERNAL',             'Internal',             100, '#3b82f6', 'For employees only — not for external distribution', true),
  ('00000000-0000-0000-0000-000000000003', NULL, 'CONFIDENTIAL',         'Confidential',         200, '#f59e0b', 'Restricted to specific teams or roles', true),
  ('00000000-0000-0000-0000-000000000004', NULL, 'STRICTLY_CONFIDENTIAL','Strictly Confidential',300, '#ef4444', 'Highest sensitivity — legal, financial, or personal data', true)
ON CONFLICT DO NOTHING;

-- FK column on compilations (backfill existing rows from old text column)
ALTER TABLE compilations
  ADD COLUMN IF NOT EXISTS classification_level_id UUID REFERENCES classification_levels(id);

UPDATE compilations
SET classification_level_id = CASE classification
  WHEN 'PUBLIC'       THEN '00000000-0000-0000-0000-000000000001'::uuid
  WHEN 'INTERNAL'     THEN '00000000-0000-0000-0000-000000000002'::uuid
  WHEN 'CONFIDENTIAL' THEN '00000000-0000-0000-0000-000000000003'::uuid
  WHEN 'RESTRICTED'   THEN '00000000-0000-0000-0000-000000000004'::uuid
  ELSE                     '00000000-0000-0000-0000-000000000002'::uuid
END
WHERE classification_level_id IS NULL;

-- Numeric clearance rank on users (backfill from existing clearance text)
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS clearance_rank INTEGER NOT NULL DEFAULT 100;

UPDATE users SET clearance_rank = CASE clearance
  WHEN 'PUBLIC'       THEN 0
  WHEN 'INTERNAL'     THEN 100
  WHEN 'CONFIDENTIAL' THEN 200
  WHEN 'RESTRICTED'   THEN 300
  ELSE 100
END;

-- Classification FK on jobs so ingest can tag source-level sensitivity
ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS classification_level_id UUID REFERENCES classification_levels(id);
