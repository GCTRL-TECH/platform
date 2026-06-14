-- A2 ENTITY DOSSIERS — the HOT memory tier.
--
-- A dossier is a compiled, authoritative per-entity memory: a concise LLM
-- synthesis (reusing the distiller's local-Ollama per-entity pass), the entity's
-- relations as structured key_facts (with confidence), the origin files it was
-- extracted from, and a timeline of any dated facts. Dossiers are injected as a
-- HOT, top-of-prompt block before retrieved chunks (A3) so "who is X / where does
-- X come from" is answered directly, never hedged.
--
-- Auto-built for the top-degree ("god node") entities of a compilation during
-- distillation, and on-demand when a query references an entity that has no
-- dossier yet. Owner-scoped (user_id) + UNIQUE on (user_id, entity_uri) so a
-- rebuild upserts in place rather than fanning out copies.
--
-- A4 forward-compat: heat / trust / access_count / last_accessed already live
-- here. A3 bumps heat+access_count+last_accessed on every injection; A4 will add
-- a decay/eviction worker that reads these columns. trust defaults to 0.8
-- (dossier is high-trust but below an explicitly user-pinned fact).

CREATE TABLE IF NOT EXISTS entity_dossiers (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       UUID NOT NULL,
    entity_uri    TEXT NOT NULL,
    entity_name   TEXT NOT NULL,
    summary       TEXT NOT NULL DEFAULT '',
    key_facts     JSONB NOT NULL DEFAULT '[]'::jsonb,
    origin_files  TEXT[] NOT NULL DEFAULT '{}',
    timeline      JSONB NOT NULL DEFAULT '[]'::jsonb,
    trust         REAL NOT NULL DEFAULT 0.8,
    pinned        BOOLEAN NOT NULL DEFAULT false,
    heat          REAL NOT NULL DEFAULT 0,
    access_count  INTEGER NOT NULL DEFAULT 0,
    last_accessed TIMESTAMPTZ,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, entity_uri)
);

-- Hot-block lookup is by (user_id, entity_name) — A3 resolves the query's entity
-- name to a dossier. A case-insensitive functional index keeps "Fabio" / "fabio"
-- resolving to the same dossier without an ILIKE seq-scan.
CREATE INDEX IF NOT EXISTS idx_entity_dossiers_user_name
    ON entity_dossiers (user_id, lower(entity_name));

-- A4 decay worker will scan by heat; pinned dossiers are never evicted.
CREATE INDEX IF NOT EXISTS idx_entity_dossiers_heat
    ON entity_dossiers (user_id, heat);
