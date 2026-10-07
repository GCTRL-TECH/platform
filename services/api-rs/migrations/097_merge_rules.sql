-- 097: merge rules — the readable rule the fusion applies per entity type.
--
-- Until now the Stage-2 rule lived only in fuse code (trigram floor on the
-- name plus equal type). This table holds a rule per owner and coarse entity
-- type, optionally per compilation, in two forms: `rule` (structured: operator
-- and up to two leaves {measure, property, threshold}) and `ls`, the same rule
-- as the LIMES link specification the worker hands to the resolver.
--
-- Lifecycle: a rule is `proposed` (written by a person in their own words, by
-- the threshold learner from review decisions, or by the LIMES learner), becomes
-- `active` through one click, which retires the previously active rule of the
-- same scope and type. The worker only reads `active` rows. Nothing is
-- applied without that click.

CREATE TABLE IF NOT EXISTS merge_rules (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    compilation_id  UUID REFERENCES compilations(id) ON DELETE CASCADE,
    entity_type     TEXT NOT NULL,
    rule            JSONB NOT NULL,
    ls              TEXT NOT NULL,
    origin          TEXT NOT NULL CHECK (origin IN ('default', 'human', 'learned')),
    status          TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'active', 'retired')),
    evidence        JSONB NOT NULL DEFAULT '{}'::jsonb,
    source_text     TEXT,
    version         INTEGER NOT NULL DEFAULT 1,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    decided_at      TIMESTAMPTZ,
    decided_by      UUID REFERENCES users(id) ON DELETE SET NULL
);

-- At most one active rule per owner, scope and type (NULL compilation = global).
CREATE UNIQUE INDEX IF NOT EXISTS uq_merge_rules_active
    ON merge_rules (user_id, COALESCE(compilation_id, '00000000-0000-0000-0000-000000000000'::uuid), entity_type)
    WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_merge_rules_owner
    ON merge_rules (user_id, status, created_at DESC);
