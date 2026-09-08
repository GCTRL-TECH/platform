-- CONFLICT DECISION MEMORY (learning loop, stage 1) — services/conflict_memory.rs
--
-- Every HUMAN conflict resolution (classification suggest/resolve, fact resolve)
-- leaves one row: WHAT kind of conflict it was (a normalised `signature`, never
-- the data itself) and HOW it was decided (`chosen`). The next conflict with the
-- same signature gets the majority decision as its suggestion, with counters
-- (support = rows for that signature, confidence = majority share). Above a
-- configurable threshold (GCTRL_CONFLICT_AUTO_MIN_SUPPORT, default 5, AND a
-- majority of >= 80 %) the ingest hook applies the decision itself and marks
-- the conflict `auto_resolved`. This is a counter-based decision memory, not a
-- trained model: no features are weighted, nothing generalises beyond an
-- identical signature. Automatic resolutions are never recorded here (they
-- would reinforce themselves).
--
--   conflict_kind  'classification' | 'fact'
--   signature      classification:<node|edge>:<sorted level names>
--                  fact:<relation>:<key_side>
--   chosen         classification: keep | dismiss | remove_label:<rank>
--                  fact: dismiss | accept_winner | keep_higher_confidence |
--                        pick_other (a value choice that does not generalise —
--                        counted in the majority, never auto-applied)
--   features       JSONB context of the decision (label names, tail count, …)
--   decided_by     the human who decided (nulls out with the account)
--   compilation_id the graph the conflict lived in (nulls out with the graph)

CREATE TABLE IF NOT EXISTS conflict_resolutions (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conflict_kind  TEXT NOT NULL CHECK (conflict_kind IN ('classification', 'fact')),
    signature      TEXT NOT NULL,
    chosen         TEXT NOT NULL,
    features       JSONB NOT NULL DEFAULT '{}'::jsonb,
    decided_by     UUID REFERENCES users(id) ON DELETE SET NULL,
    compilation_id UUID REFERENCES compilations(id) ON DELETE SET NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The lookup is always "all decisions for these signatures", grouped by chosen.
CREATE INDEX IF NOT EXISTS idx_conflict_resolutions_signature
    ON conflict_resolutions (conflict_kind, signature);

-- Both conflict tables gain the `auto_resolved` status. classification_conflicts
-- (migration 033) declared status as VARCHAR(12), which is one character short
-- of 'auto_resolved'; widen to TEXT like fact_conflicts. Inline CHECKs carry
-- Postgres' default name <table>_<column>_check.
ALTER TABLE classification_conflicts
    ALTER COLUMN status TYPE TEXT;
ALTER TABLE classification_conflicts
    DROP CONSTRAINT IF EXISTS classification_conflicts_status_check;
ALTER TABLE classification_conflicts
    ADD CONSTRAINT classification_conflicts_status_check
    CHECK (status IN ('open', 'resolved', 'dismissed', 'auto_resolved'));

ALTER TABLE fact_conflicts
    DROP CONSTRAINT IF EXISTS fact_conflicts_status_check;
ALTER TABLE fact_conflicts
    ADD CONSTRAINT fact_conflicts_status_check
    CHECK (status IN ('open', 'resolved', 'dismissed', 'auto_resolved'));
