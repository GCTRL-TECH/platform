-- Extend audit_log for DSGVO-compliant data-access auditing:
-- record what clearance level was used, what classification was accessed,
-- and whether access was granted or denied.

ALTER TABLE audit_log
  ADD COLUMN IF NOT EXISTS clearance_level_used  VARCHAR(100),
  ADD COLUMN IF NOT EXISTS classification_accessed VARCHAR(100),
  ADD COLUMN IF NOT EXISTS access_granted         BOOLEAN,
  ADD COLUMN IF NOT EXISTS denial_reason          TEXT;

CREATE INDEX IF NOT EXISTS idx_audit_clearance  ON audit_log(clearance_level_used);
CREATE INDEX IF NOT EXISTS idx_audit_granted    ON audit_log(access_granted) WHERE access_granted = false;
CREATE INDEX IF NOT EXISTS idx_audit_user_time  ON audit_log(user_id, created_at DESC);
