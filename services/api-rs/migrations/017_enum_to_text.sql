-- Convert ENUM columns to TEXT with CHECK constraints so the Rust API
-- can bind plain String values without explicit ::enum casts at every query site.

ALTER TABLE users ALTER COLUMN role DROP DEFAULT;
ALTER TABLE users ALTER COLUMN clearance DROP DEFAULT;
ALTER TABLE jobs  ALTER COLUMN status DROP DEFAULT;
ALTER TABLE compilations ALTER COLUMN classification DROP DEFAULT;

ALTER TABLE users
  ALTER COLUMN role TYPE TEXT USING role::TEXT,
  ALTER COLUMN role SET DEFAULT 'viewer',
  ADD CONSTRAINT users_role_check CHECK (role IN ('viewer','analyst','editor','admin'));

ALTER TABLE users
  ALTER COLUMN clearance TYPE TEXT USING clearance::TEXT,
  ALTER COLUMN clearance SET DEFAULT 'PUBLIC',
  ADD CONSTRAINT users_clearance_check CHECK (clearance IN ('PUBLIC','INTERNAL','CONFIDENTIAL','RESTRICTED'));

ALTER TABLE jobs
  ALTER COLUMN type TYPE TEXT USING type::TEXT,
  ADD CONSTRAINT jobs_type_check CHECK (type IN ('kex_extract','kex_upload','fuse_merge'));

ALTER TABLE jobs
  ALTER COLUMN status TYPE TEXT USING status::TEXT,
  ALTER COLUMN status SET DEFAULT 'pending',
  ADD CONSTRAINT jobs_status_check CHECK (status IN ('pending','processing','completed','failed'));

ALTER TABLE compilations
  ALTER COLUMN classification TYPE TEXT USING classification::TEXT,
  ALTER COLUMN classification SET DEFAULT 'INTERNAL',
  ADD CONSTRAINT compilations_classification_check CHECK (classification IN ('PUBLIC','INTERNAL','CONFIDENTIAL','RESTRICTED'));

DROP TYPE IF EXISTS user_role CASCADE;
DROP TYPE IF EXISTS user_clearance CASCADE;
DROP TYPE IF EXISTS job_type CASCADE;
DROP TYPE IF EXISTS job_status CASCADE;
