-- Data retention policies per classification level.
-- When a compilation's classification level has a retention policy,
-- the background cleanup task deletes expired data automatically.

CREATE TABLE IF NOT EXISTS retention_policies (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  classification_level_id UUID REFERENCES classification_levels(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE, -- NULL = system default
  retention_days INTEGER, -- NULL = keep forever (no expiry)
  action VARCHAR(20) NOT NULL DEFAULT 'delete' CHECK (action IN ('delete', 'archive', 'notify')),
  notify_email TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(classification_level_id, user_id)
);

-- System defaults aligned with ISO 27001 / TISAX recommendations
INSERT INTO retention_policies (classification_level_id, user_id, retention_days, action) VALUES
  ('00000000-0000-0000-0000-000000000001', NULL, NULL,  'delete'), -- PUBLIC: indefinite
  ('00000000-0000-0000-0000-000000000002', NULL, 1825, 'delete'), -- INTERNAL: 5 years
  ('00000000-0000-0000-0000-000000000003', NULL, 730,  'delete'), -- CONFIDENTIAL: 2 years
  ('00000000-0000-0000-0000-000000000004', NULL, 365,  'delete')  -- STRICTLY_CONFIDENTIAL: 1 year
ON CONFLICT DO NOTHING;

-- Track when compilations/jobs expire
ALTER TABLE compilations ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

-- Function to compute expiry date when classification is set
CREATE OR REPLACE FUNCTION set_compilation_expiry() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.classification_level_id IS NOT NULL THEN
    SELECT NOW() + (rp.retention_days || ' days')::INTERVAL
    INTO NEW.expires_at
    FROM retention_policies rp
    WHERE rp.classification_level_id = NEW.classification_level_id
      AND rp.user_id IS NULL
      AND rp.retention_days IS NOT NULL
    LIMIT 1;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_compilation_expiry
  BEFORE INSERT OR UPDATE OF classification_level_id ON compilations
  FOR EACH ROW EXECUTE FUNCTION set_compilation_expiry();
