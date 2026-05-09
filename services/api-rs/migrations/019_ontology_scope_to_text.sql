-- Convert the ontology_scope ENUM column to TEXT with a CHECK constraint so the
-- Rust API can bind plain String values without explicit ::ontology_scope casts
-- at every query site. Mirrors the pattern from migration 017_enum_to_text.sql.

ALTER TABLE ontologies ALTER COLUMN scope DROP DEFAULT;

ALTER TABLE ontologies
  ALTER COLUMN scope TYPE TEXT USING scope::TEXT,
  ALTER COLUMN scope SET DEFAULT 'private',
  ADD CONSTRAINT ontologies_scope_check CHECK (scope IN ('private','shared','public'));

DROP TYPE IF EXISTS ontology_scope CASCADE;
