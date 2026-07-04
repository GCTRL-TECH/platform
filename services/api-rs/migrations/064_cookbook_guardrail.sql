-- Wave 5: Cookbook (hardware-aware model tuning) + guardrail auto-fallback.
--
-- agent_model / rag_model: per-user purpose model prefs for the Pi agent chat
-- and Talk-to-Graph RAG, mirroring the existing embedding/relation/distill
-- columns on user_model_prefs. NULL = use the engine's existing fallback chain
-- (resolve_for_user), so existing installs are untouched.
ALTER TABLE user_model_prefs ADD COLUMN agent_model TEXT, ADD COLUMN rag_model TEXT;

-- guardrail_state: singleton row (id=1) tracking the runtime health-guardrail's
-- consecutive-failure counter and the last auto-revert (if any). Mirrors the
-- runtime_config singleton pattern (056_runtime_config.sql).
CREATE TABLE guardrail_state (
  id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  consecutive_failures INT NOT NULL DEFAULT 0,
  last_probe_at TIMESTAMPTZ, last_error TEXT,
  reverted_at TIMESTAMPTZ, reverted_from JSONB
);
INSERT INTO guardrail_state (id) VALUES (1) ON CONFLICT DO NOTHING;

-- guardrail_events: notify-only log for the guardrail (runtime reverts,
-- degraded-job spikes). Surfaced via GET /api/infra/guardrail and dismissed via
-- POST /api/infra/guardrail/events/:id/dismiss.
CREATE TABLE guardrail_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  kind TEXT NOT NULL,
  detail JSONB NOT NULL DEFAULT '{}',
  dismissed BOOLEAN NOT NULL DEFAULT false
);
