-- 092: merge review — the few doubtful entity merges a human may confirm or split.
--
-- The fusion keeps merging on its own. After each run the fuse worker writes at
-- most a handful of PENDING rows here (below the acceptance threshold, found by
-- one matcher only, the sole link holding a cluster together). A person can
-- answer "same" / "not_same" / dismiss on the conflicts tab; the answer binds
-- every later merge of that compilation (must-link / cannot-link) and feeds the
-- decision memory (conflict_resolutions, kind 'entity_merge').
--
-- `review_queue` (migration 008) was built for exactly this and never used; it
-- gains the merge evidence and a unique key per pair.

ALTER TABLE review_queue
    ADD COLUMN IF NOT EXISTS score       REAL,
    ADD COLUMN IF NOT EXISTS limes_score REAL,
    ADD COLUMN IF NOT EXISTS band        TEXT,
    ADD COLUMN IF NOT EXISTS methods     TEXT[] NOT NULL DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS merged_uri  TEXT,
    ADD COLUMN IF NOT EXISTS context     JSONB NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS decided_by  UUID REFERENCES users(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- status: pending | resolved | dismissed | auto_resolved; decision: same | not_same
ALTER TABLE review_queue DROP CONSTRAINT IF EXISTS review_queue_status_check;
ALTER TABLE review_queue ADD CONSTRAINT review_queue_status_check
    CHECK (status IN ('pending', 'resolved', 'dismissed', 'auto_resolved'));
ALTER TABLE review_queue DROP CONSTRAINT IF EXISTS review_queue_decision_check;
ALTER TABLE review_queue ADD CONSTRAINT review_queue_decision_check
    CHECK (decision IS NULL OR decision IN ('same', 'not_same'));

-- One row per unordered pair and compilation (the writer orders a < b).
CREATE UNIQUE INDEX IF NOT EXISTS uq_review_queue_pair
    ON review_queue (user_id, compilation_id, entity_a_uri, entity_b_uri);
CREATE INDEX IF NOT EXISTS idx_review_queue_pending
    ON review_queue (user_id, status, created_at DESC);

-- The decision memory learns merge decisions like fact and classification ones.
ALTER TABLE conflict_resolutions DROP CONSTRAINT IF EXISTS conflict_resolutions_conflict_kind_check;
ALTER TABLE conflict_resolutions ADD CONSTRAINT conflict_resolutions_conflict_kind_check
    CHECK (conflict_kind IN ('classification', 'fact', 'entity_merge'));
