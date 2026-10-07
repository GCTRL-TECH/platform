-- 091: merge trail — one row per entity link the FUSE merge acted on.
--
-- Until now a merge recorded only counts: which nodes were fused, by which
-- matcher and at what similarity was thrown away after clustering, so a single
-- merge could neither be explained nor undone. This table keeps that evidence.
--
-- It is a SNAPSHOT of the compilation's latest merge (the fuse worker replaces
-- the compilation's rows on every run), not a history. Raw source nodes are
-- never touched by a merge, so `source_uri` / `target_uri` stay resolvable.
--
-- `methods` lists every matcher that found the pair (resolver, resolver_review,
-- resolver_fallback, smart, canonical, embedding-*, apoc, human); `score` is
-- the best confidence among them; `limes_score` / `band` are set when LIMES
-- itself scored the pair (band = the LIMES output file: accepted | review).

CREATE TABLE IF NOT EXISTS merge_links (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    compilation_id  UUID NOT NULL REFERENCES compilations(id) ON DELETE CASCADE,
    user_id         UUID REFERENCES users(id) ON DELETE SET NULL,
    source_uri      TEXT NOT NULL,
    target_uri      TEXT NOT NULL,
    source_name     TEXT NOT NULL DEFAULT '',
    target_name     TEXT NOT NULL DEFAULT '',
    entity_type     TEXT NOT NULL DEFAULT '',
    methods         TEXT[] NOT NULL DEFAULT '{}',
    score           REAL,
    limes_score     REAL,
    band            TEXT CHECK (band IN ('accepted', 'review')),
    merged_uri      TEXT NOT NULL DEFAULT '',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (compilation_id, source_uri, target_uri)
);

CREATE INDEX IF NOT EXISTS idx_merge_links_merged
    ON merge_links (compilation_id, merged_uri);
