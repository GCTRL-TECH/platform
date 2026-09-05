-- HEBBIAN MEMORY — use strengthens, disuse forgets (services/hebb.rs, kex/src/hebb.py).
--
-- Before: heat was a flat +1 on the chat path only, decayed x0.95 per 600 s tick
-- (a half-life of ~2.3 h) and never reached retrieval ranking. Both live
-- instances showed 0 hot / 0 warm chunks and an empty HOT tier.
--
-- Now every read path reinforces (rank- and signal-weighted), every use lengthens
-- the item's own half-life (consolidation), the items of one retrieval are wired
-- together (co-activation) and KEX gives reinforced/associated chunks a bounded
-- rank bonus at search time.

-- Per-item half-life: fresh knowledge halves in a week; each use multiplies the
-- half-life by 1.5 up to 180 days. The governance cycle decays heat with
-- 0.5 ^ (tick / half_life_secs) instead of a fixed factor.
ALTER TABLE text_chunks
    ADD COLUMN IF NOT EXISTS half_life_secs INTEGER NOT NULL DEFAULT 604800;
ALTER TABLE entity_dossiers
    ADD COLUMN IF NOT EXISTS half_life_secs INTEGER NOT NULL DEFAULT 604800;

-- "Cells that fire together wire together": an unordered pair (a < b) of chunks
-- that were returned in the same retrieval. weight follows the bounded Hebbian
-- rule w += eta * (1 - w); the cycle decays it with a 30-day half-life and prunes
-- faded pairs. Per user: a pair never crosses an owner boundary.
CREATE TABLE IF NOT EXISTS memory_coactivation (
    user_id    UUID        NOT NULL,
    a          UUID        NOT NULL,
    b          UUID        NOT NULL,
    weight     REAL        NOT NULL DEFAULT 0,
    fired      INTEGER     NOT NULL DEFAULT 0,
    last_fired TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, a, b)
);

-- Search looks up neighbours from either side of a pair.
CREATE INDEX IF NOT EXISTS idx_memory_coactivation_b
    ON memory_coactivation (user_id, b);
