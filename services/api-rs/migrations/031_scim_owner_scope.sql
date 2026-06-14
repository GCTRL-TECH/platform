-- SCIM cross-tenant isolation.
--
-- Prior to this, every SCIM token could list/read/update/delete ALL
-- SSO-provisioned users in the system (cross-tenant IDOR): the queries only
-- filtered on `sso_provider IS NOT NULL`, never on which SCIM owner provisioned
-- the row. `provisioned_by` pins each SCIM-provisioned user to the owner of the
-- SCIM token that created it, and every SCIM SELECT/UPDATE/DELETE now scopes to
-- it.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS provisioned_by UUID REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_users_provisioned_by ON users(provisioned_by);
