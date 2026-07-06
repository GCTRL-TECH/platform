-- P2: per-purpose RUNTIME selection.
--
-- 055 made the per-purpose MODEL pickable (embedding/relation/distill, later
-- agent/rag). Only `embedding` carried its own provider+base_url; the rest were
-- model-name-only and silently assumed Ollama (or inherited whatever the global
-- runtime happened to be). This adds provider + base_url to every remaining
-- purpose so each can point at its OWN runtime — bundled Ollama, native Ollama,
-- Ollama cloud, vLLM, llama.cpp, or an external OpenAI-compatible endpoint —
-- independently of the others.
--
-- NULL provider = "inherit the global runtime" (today's behavior). Existing
-- installs are untouched: every column defaults NULL, so nothing changes until a
-- user explicitly overrides a purpose.
ALTER TABLE user_model_prefs
  ADD COLUMN IF NOT EXISTS relation_provider TEXT,
  ADD COLUMN IF NOT EXISTS relation_base_url TEXT,
  ADD COLUMN IF NOT EXISTS distill_provider  TEXT,
  ADD COLUMN IF NOT EXISTS distill_base_url  TEXT,
  ADD COLUMN IF NOT EXISTS agent_provider    TEXT,
  ADD COLUMN IF NOT EXISTS agent_base_url    TEXT,
  ADD COLUMN IF NOT EXISTS rag_provider      TEXT,
  ADD COLUMN IF NOT EXISTS rag_base_url      TEXT;
