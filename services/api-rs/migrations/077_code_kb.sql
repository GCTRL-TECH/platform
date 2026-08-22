-- Codebase KBs: a code graph is a compilation of type CODE, written by `kex_code`
-- jobs (async, queued on kex:jobs like kex_extract). Postgres has no "extend
-- CHECK", so the whole jobs_type_check list is re-declared (mirrors 045 + kex_code).
-- The fresh enum value is NOT used inside this migration (PG forbids using a value
-- added in the same transaction) — the API only writes 'CODE' at request time.

ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_type_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_type_check CHECK (
  type IN (
    'kex_extract',
    'kex_upload',
    'fuse_merge',
    'kex_connector',
    'kex_url',
    'kex_sharepoint',
    'kex_obsidian',
    'distill_wiki',
    'kex_code'
  )
);

ALTER TYPE compilation_type ADD VALUE IF NOT EXISTS 'CODE';
