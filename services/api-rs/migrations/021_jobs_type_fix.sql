-- Expand the jobs type CHECK constraint to include new connector-based job types.
-- The original constraint (migration 017) only covered kex_extract, kex_upload, fuse_merge.
-- SharePoint, Obsidian and future connector ingestion jobs need these additional types.

ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_type_check;

ALTER TABLE jobs ADD CONSTRAINT jobs_type_check CHECK (
  type IN (
    'kex_extract',
    'kex_upload',
    'fuse_merge',
    'kex_connector',
    'kex_url',
    'kex_sharepoint',
    'kex_obsidian'
  )
);
