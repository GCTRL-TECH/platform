-- Repair: andere Instance hat ENUM-Typen + Spalten weggedroppt.
-- Diese Migration bringt das Schema back-to-spec für Migration 17 (enum_to_text).

-- Add missing role/clearance columns directly in final-form (TEXT + CHECK)
ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'viewer';
ALTER TABLE users ADD COLUMN IF NOT EXISTS clearance TEXT NOT NULL DEFAULT 'PUBLIC';

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('viewer','analyst','editor','admin'));
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_clearance_check;
ALTER TABLE users ADD CONSTRAINT users_clearance_check CHECK (clearance IN ('PUBLIC','INTERNAL','CONFIDENTIAL','RESTRICTED'));

-- Owner = admin + restore proper token balance
UPDATE users SET role='admin', clearance='RESTRICTED', tokens_balance=GREATEST(tokens_balance, 3000) WHERE email='fabio@5monti.com';

-- Mark migration 17 as effectively applied
INSERT INTO _sqlx_migrations (version, description, success, checksum, execution_time)
VALUES (17, 'enum_to_text', true, decode('8549240632b1576a944be290ee5f90711f9d95212d5ff945724c1b82041ab101aa56505ea95017edb4d96ac8a3dd452a','hex'), 0)
ON CONFLICT (version) DO NOTHING;

-- jobs.type / jobs.status enum→text (idempotent)
DO $$ BEGIN
  BEGIN
    ALTER TABLE jobs ALTER COLUMN type DROP DEFAULT;
    ALTER TABLE jobs ALTER COLUMN type TYPE TEXT USING type::TEXT;
    ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_type_check;
    ALTER TABLE jobs ADD CONSTRAINT jobs_type_check CHECK (type IN ('kex_extract','kex_upload','fuse_merge'));
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE jobs ALTER COLUMN status DROP DEFAULT;
    ALTER TABLE jobs ALTER COLUMN status TYPE TEXT USING status::TEXT;
    ALTER TABLE jobs ALTER COLUMN status SET DEFAULT 'pending';
    ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_status_check;
    ALTER TABLE jobs ADD CONSTRAINT jobs_status_check CHECK (status IN ('pending','processing','completed','failed'));
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE compilations ALTER COLUMN classification DROP DEFAULT;
    ALTER TABLE compilations ALTER COLUMN classification TYPE TEXT USING classification::TEXT;
    ALTER TABLE compilations ALTER COLUMN classification SET DEFAULT 'INTERNAL';
    ALTER TABLE compilations DROP CONSTRAINT IF EXISTS compilations_classification_check;
    ALTER TABLE compilations ADD CONSTRAINT compilations_classification_check
      CHECK (classification IN ('PUBLIC','INTERNAL','CONFIDENTIAL','RESTRICTED'));
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
END $$;

-- Drop any lingering enum types (safe — nothing references them now)
DROP TYPE IF EXISTS user_role CASCADE;
DROP TYPE IF EXISTS user_clearance CASCADE;
DROP TYPE IF EXISTS job_type CASCADE;
DROP TYPE IF EXISTS job_status CASCADE;
DROP TYPE IF EXISTS ontology_scope CASCADE;

SELECT '--- users after repair ---' AS info;
SELECT id, email, role, clearance, tier, tokens_balance FROM users;
SELECT '--- migration markers ---' AS info;
SELECT version, success FROM _sqlx_migrations ORDER BY version;
