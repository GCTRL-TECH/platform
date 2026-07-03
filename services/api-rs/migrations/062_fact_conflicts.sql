-- P3 — Fact conflicts: two (or more) sources assert DIFFERENT values for a
-- functional relation of the same key entity — "10 files talk about the same
-- thing, which is current?". Rows are written by KEX write-time detection and
-- the FUSE post-merge scan (services/*/src/conflicts.py), read by
-- GET /api/classification/conflicts (kind='fact') and resolved via
-- POST /api/kg/conflicts/:id/resolve.
--
-- Design decisions:
--   key_uri / key_name : the "one value per" anchor entity (see
--                        relation_registry.key_side). key_name is denormalised
--                        because resolution writes knowledge_corrections rows
--                        and Cypher deletes, both of which are name-based.
--   tails    : JSONB array of ALL current competing values, rebuilt in full on
--              every re-evaluation (never appended) so re-running detection is
--              idempotent. Each entry: { value, uri, sourceDoc,
--              sourceDocModifiedAt, assertedAt, confidence, trust, authority }.
--   authority_winner : the value (entity name) of the edge ranked "current" by
--              the recency-authority ordering:
--              _source_doc_modified_at DESC -> asserted_at DESC ->
--              dossier trust DESC -> confidence DESC.
--   UNIQUE(user_id, relation, key_uri) : upsert semantics — re-evaluation
--              updates the same row, never duplicates it.
--   Status transitions on re-evaluation: 'dismissed' STAYS dismissed (the user
--              said "not a conflict"); 'resolved' reopens to 'open' — resolution
--              deletes the losing edges + blocks them via knowledge_corrections,
--              so detection firing again means a genuinely NEW conflicting
--              assertion arrived.
--   resolved_correction_id : the knowledge_corrections row written when the
--              user accepted/picked a winner (losing edges recorded as
--              action='delete' so re-extraction cannot resurrect them).
--   valid_from / valid_to : reserved for a later bitemporal phase (facts valid
--              during an interval, e.g. "CEO from 2024 to 2026"); always NULL
--              in P3.

CREATE TABLE IF NOT EXISTS fact_conflicts (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  compilation_id         UUID REFERENCES compilations(id) ON DELETE SET NULL,
  relation               TEXT NOT NULL,
  key_uri                TEXT NOT NULL,
  key_name               TEXT NOT NULL DEFAULT '',
  key_side               TEXT NOT NULL CHECK (key_side IN ('head', 'tail')),
  tails                  JSONB NOT NULL DEFAULT '[]'::jsonb,
  authority_winner       TEXT,
  status                 TEXT NOT NULL DEFAULT 'open'
                           CHECK (status IN ('open', 'resolved', 'dismissed')),
  resolved_correction_id UUID REFERENCES knowledge_corrections(id) ON DELETE SET NULL,
  first_detected_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_evaluated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  valid_from             TIMESTAMPTZ,
  valid_to               TIMESTAMPTZ,
  UNIQUE (user_id, relation, key_uri)
);

-- The review queue reads "my open conflicts, newest first".
CREATE INDEX IF NOT EXISTS idx_fact_conflicts_user_status
  ON fact_conflicts (user_id, status, first_detected_at DESC);
