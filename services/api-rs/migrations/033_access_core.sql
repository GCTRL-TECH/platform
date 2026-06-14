-- Phase 1 — Security Core: per-element classification, scoped tokens, conflicts.
--
-- This migration adds the relational scaffolding for:
--   * per-graph grants on access tokens (api_key_grants)
--   * surfaced merge/re-ingest classification conflicts (classification_conflicts)
--   * chunk-level classification on text_chunks
--
-- The Neo4j per-element labels (_class_labels / _min_rank / _class_conflict) are
-- written by the KEX + FUSE workers; this file only covers Postgres state.
-- All statements are additive / idempotent.

-- ── Per-graph grants on access tokens ────────────────────────────────────────
-- A grant lets a token reach a specific compilation even when the compilation's
-- (or an element's) classification rank exceeds the token's base clearance.
-- granted_rank (nullable) optionally caps the element rank reachable via the
-- grant; NULL means "full access to this compilation regardless of element rank".
CREATE TABLE IF NOT EXISTS api_key_grants (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  api_key_id     UUID NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  compilation_id UUID NOT NULL REFERENCES compilations(id) ON DELETE CASCADE,
  granted_rank   INTEGER,           -- NULL = no per-element cap within this grant
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (api_key_id, compilation_id)
);

CREATE INDEX IF NOT EXISTS idx_api_key_grants_key  ON api_key_grants(api_key_id);
CREATE INDEX IF NOT EXISTS idx_api_key_grants_comp ON api_key_grants(compilation_id);

-- ── Classification conflicts ─────────────────────────────────────────────────
-- Raised when a merge (or re-ingest) produces an element carrying two or more
-- distinct classification labels. We never auto-escalate; instead we record the
-- conflict, attach a suggestion (LIMES + Ollama, filled by the resolver), and
-- let an admin decide. `element_key` is the Neo4j element identity (node uri or
-- edge signature) so the resolver can re-locate and act on it.
CREATE TABLE IF NOT EXISTS classification_conflicts (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  compilation_id UUID REFERENCES compilations(id) ON DELETE CASCADE,
  element_kind   VARCHAR(10) NOT NULL CHECK (element_kind IN ('node','edge')),
  element_key    TEXT NOT NULL,
  labels         JSONB NOT NULL DEFAULT '[]',   -- the conflicting label set
  suggestion     JSONB,                          -- {action, rank?, rationale, matchScore?}
  status         VARCHAR(12) NOT NULL DEFAULT 'open'
                   CHECK (status IN ('open','resolved','dismissed')),
  resolved_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  resolved_at    TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (compilation_id, element_kind, element_key)
);

CREATE INDEX IF NOT EXISTS idx_class_conflicts_comp   ON classification_conflicts(compilation_id);
CREATE INDEX IF NOT EXISTS idx_class_conflicts_status ON classification_conflicts(status);

-- ── Chunk-level classification ───────────────────────────────────────────────
-- Each chunk carries the classification it was ingested with so retrieval (RAG,
-- /kex/chunks, vector pre-filter) can gate by the caller's effective clearance.
-- min_rank is the denormalized most-permissive rank across class_labels; for a
-- freshly-ingested chunk this equals the single ingest label's rank.
ALTER TABLE text_chunks ADD COLUMN IF NOT EXISTS classification_level_id UUID REFERENCES classification_levels(id);
ALTER TABLE text_chunks ADD COLUMN IF NOT EXISTS min_rank    INTEGER NOT NULL DEFAULT 0;
ALTER TABLE text_chunks ADD COLUMN IF NOT EXISTS class_labels JSONB  NOT NULL DEFAULT '[]';

CREATE INDEX IF NOT EXISTS idx_text_chunks_min_rank ON text_chunks(min_rank);
