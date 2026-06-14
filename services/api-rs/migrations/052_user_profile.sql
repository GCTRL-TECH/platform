-- A6 — USER-PROFILE / personalization memory (GDPR-aware, OPT-IN).
--
-- Distils durable, stable user facts/preferences (role, expertise, working style,
-- recurring context) from STANDARD-mode conversation history only (migration 016
-- `conversations`/`messages`; incognito turns never reach `persist_turn`, so they
-- never land in `messages` and can never be a distillation source — the DSGVO split
-- stays structurally intact). When `enabled`, the distilled summary is injected as a
-- TRUST TIER 1 hot block into the RAG/agent prompt so answers are personalized.
--
-- GDPR posture:
--   • `enabled` DEFAULT false — personalization is strictly OPT-IN. No profile is
--     ever built or injected until the user explicitly turns it on.
--   • One row per user (PK = user_id). `DELETE FROM user_profile WHERE user_id=$1`
--     is the right-to-be-forgotten erase (wipes facts + summary in one shot).
--   • ON DELETE CASCADE from users → account deletion wipes the profile too.
CREATE TABLE IF NOT EXISTS user_profile (
    user_id     UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    -- Stable facts as a structured list: [{category, fact}] e.g.
    -- [{"category":"role","fact":"CTO / solo developer"},
    --  {"category":"preference","fact":"prefers concise, autonomous answers"}].
    facts       JSONB       NOT NULL DEFAULT '[]'::jsonb,
    -- Short prose summary injected as the hot block.
    summary     TEXT        NOT NULL DEFAULT '',
    -- OPT-IN gate. false until the user enables personalization in Settings.
    enabled     BOOLEAN     NOT NULL DEFAULT false,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
