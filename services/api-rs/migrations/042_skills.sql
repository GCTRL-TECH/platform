-- Agent skills system for the Pi harness.
--
-- An "agent skill" is a labelled block of guidance (and/or a tool set) that is
-- folded into the agent's system prompt at request time. There are three kinds:
--   * builtin  : the hard-wired GCTRL knowledge tools. locked=true, always on,
--                cannot be disabled by anyone.
--   * curated  : popular default prompt-packs we ship (RAG Expert, DB Engineer).
--                Enabled by default, but a user may opt out per-user.
--   * github   : a skill a user added from a public GitHub repo (fetched SKILL.md
--                / manifest.json). These rows are user-scoped (user_id = owner).
--
-- System/global rows have user_id = NULL. A user's effective skill set is the
-- system rows (honouring agent_skill_prefs for curated ones) plus that user's own
-- github rows. `manifest` holds the prompt-pack: { prompt: "..." } for curated /
-- github skills (or the raw fetched text under prompt for github).

CREATE TABLE IF NOT EXISTS agent_skills (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID,                         -- NULL = system/global skill
  slug        TEXT NOT NULL,
  name        TEXT NOT NULL,
  description TEXT,
  kind        TEXT NOT NULL,                -- 'builtin' | 'curated' | 'github'
  repo_url    TEXT,
  manifest    JSONB,
  locked      BOOLEAN NOT NULL DEFAULT false,
  enabled     BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- System slugs are globally unique; a user's github slugs are unique per user.
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_skills_system_slug
  ON agent_skills (slug) WHERE user_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_skills_user_slug
  ON agent_skills (user_id, slug) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_agent_skills_user ON agent_skills (user_id);

-- Per-user enable/disable overrides for system curated skills. A locked skill is
-- never honoured here (the route rejects toggling it). Absence of a row means the
-- system skill's own `enabled` default applies.
CREATE TABLE IF NOT EXISTS agent_skill_prefs (
  user_id UUID NOT NULL,
  slug    TEXT NOT NULL,
  enabled BOOLEAN NOT NULL,
  PRIMARY KEY (user_id, slug)
);

-- ── Seed system skills (user_id = NULL) ──────────────────────────────────────

-- gctrl-mcp: the hard-wired GCTRL knowledge tools. Locked, always on.
INSERT INTO agent_skills (user_id, slug, name, description, kind, locked, enabled, manifest)
SELECT NULL, 'gctrl-mcp', 'GCTRL Knowledge Tools',
  'Built-in agent tools over the GCTRL knowledge layer: list_graphs, search_entities, get_entity, search_chunks, list_conflicts, list_sources, check_balance, create_extraction (ingest), fuse_graphs (merge). Every call is clearance-filtered to the caller.',
  'builtin', true, true,
  '{"prompt": null}'::jsonb
WHERE NOT EXISTS (SELECT 1 FROM agent_skills WHERE user_id IS NULL AND slug = 'gctrl-mcp');

-- rag-expert: curated prompt-pack making the agent strong at RAG answering.
INSERT INTO agent_skills (user_id, slug, name, description, kind, locked, enabled, manifest)
SELECT NULL, 'rag-expert', 'RAG Expert',
  'Retrieval-augmented answering discipline: ground answers in retrieved evidence, cite chunks, prefer graph facts, reason across multiple hops.',
  'curated', false, true,
  jsonb_build_object('prompt',
$pp$You are operating in RAG-Expert mode. Answer strictly from evidence you have retrieved, never from unverified memory.

- Before answering any factual question, retrieve first: call search_chunks for source passages and, when the question concerns specific things or their relationships, also call search_entities / get_entity for graph facts.
- Ground every claim in what you retrieved. Prefer structured graph facts over free text when both are available; when they conflict, surface the conflict rather than guessing.
- Cite your sources inline. Refer to the chunk or entity each claim came from so the user can trace it.
- For multi-hop questions, decompose the question, retrieve for each hop, then connect the pieces explicitly instead of leaping to a conclusion.
- If retrieval returns nothing relevant, say so plainly and state what is missing. Do not fabricate citations or fill gaps with assumptions.
- Keep answers tight: lead with the answer, then the supporting evidence.$pp$::text
  )
WHERE NOT EXISTS (SELECT 1 FROM agent_skills WHERE user_id IS NULL AND slug = 'rag-expert');

-- database-engineer: curated prompt-pack for data modelling and query shaping.
INSERT INTO agent_skills (user_id, slug, name, description, kind, locked, enabled, manifest)
SELECT NULL, 'database-engineer', 'Database Engineer',
  'Data-modelling and query guidance: schema design, normalization, indexing, and careful, safe SQL/Cypher.',
  'curated', false, true,
  jsonb_build_object('prompt',
$pp$You are operating in Database-Engineer mode for data-modelling and query questions.

- Model data deliberately: identify entities, their keys, and the relationships between them before proposing tables or graph patterns. Default to normalized designs; denormalize only with a stated reason (read pattern, hot path).
- Be explicit about keys and constraints: primary keys, foreign keys, uniqueness, and nullability. Call out where an index would matter for the queries discussed.
- When shaping queries, prefer set-based, sargable expressions; avoid SELECT * for anything but inspection; project only the columns needed; and make filtering and join conditions explicit.
- For graph data, think in node labels, relationship types, and direction; bound traversals with limits and use parameters rather than string-built queries.
- Treat any data-changing or destructive operation with care: scope it, prefer transactions, and state the blast radius before suggesting it. Never propose dropping or truncating without an explicit guard.
- When trade-offs exist (normalization vs. read speed, index vs. write cost), name them briefly so the user can choose.$pp$::text
  )
WHERE NOT EXISTS (SELECT 1 FROM agent_skills WHERE user_id IS NULL AND slug = 'database-engineer');
