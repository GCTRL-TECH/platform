-- P2b SOURCE DOCUMENT IDENTITY + VERSION CHAINS.
--
-- Every ingested document gets a stable identity keyed on (user_id, path).
-- Re-ingesting the SAME content (same sha256) just touches last_ingested_at.
-- CHANGED content creates version+1 in a chain (supersedes the prior row,
-- flips its `latest` flag off). This lets a later phase rank fact authority
-- by source recency (`modified_at`) instead of just extraction recency.
--
-- `path` is the FULL source path/URL where known (not just the file name);
-- callers that only have a bare name/sourceRef fall back to it, and direct
-- text extraction with no sourceRef falls back to `text:<preview>`.

CREATE TABLE IF NOT EXISTS source_documents (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            UUID NOT NULL,
  connector_id       UUID,
  path               TEXT NOT NULL,
  name               TEXT,
  content_hash       CHAR(64) NOT NULL, -- sha256 hex
  version            INT NOT NULL DEFAULT 1,
  supersedes         UUID,              -- previous version's id
  latest             BOOLEAN NOT NULL DEFAULT true,
  modified_at        TIMESTAMPTZ,       -- source-side mtime when known, else first_ingested_at
  first_ingested_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_ingested_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  valid_from         TIMESTAMPTZ,       -- reserved (temporal upgrade later)
  valid_to           TIMESTAMPTZ,       -- reserved (temporal upgrade later)
  UNIQUE (user_id, path, version)
);

CREATE INDEX IF NOT EXISTS idx_source_documents_lookup
  ON source_documents (user_id, path) WHERE latest;

ALTER TABLE jobs        ADD COLUMN IF NOT EXISTS source_document_id UUID;
ALTER TABLE text_chunks ADD COLUMN IF NOT EXISTS source_document_id UUID;
