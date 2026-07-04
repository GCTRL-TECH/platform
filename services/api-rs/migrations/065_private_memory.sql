-- Private Memory: per-compilation privacy mode + local cloak map.
--
-- Three modes (default 'open' = today's behaviour, zero change unless toggled):
--   open        — unchanged, content may reach any configured LLM (local or cloud).
--   local_only  — content from this graph must NEVER reach a cloud LLM; a request
--                 whose context involves this graph is refused when the target is cloud.
--   cloaked     — cloud LLMs are allowed, but entities/PII in the outgoing context
--                 are deterministically pseudonymized first (Person-7, [AMOUNT-2], ...);
--                 the answer is de-cloaked before the user/agent sees it. The mapping
--                 never leaves the local DB.
ALTER TABLE compilations ADD COLUMN privacy_mode TEXT NOT NULL DEFAULT 'open'
  CHECK (privacy_mode IN ('open','cloaked','local_only'));

-- cloak_maps: per-compilation stable entity -> pseudonym mapping. Looked up/upserted
-- by privacy::cloak so the same entity always gets the same pseudonym across calls
-- (stability is required for a de-cloak roundtrip and for a coherent conversation).
CREATE TABLE cloak_maps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  compilation_id UUID NOT NULL REFERENCES compilations(id) ON DELETE CASCADE,
  entity_key TEXT NOT NULL,       -- canonical lowercased surface or uri
  pseudonym TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (compilation_id, entity_key),
  UNIQUE (compilation_id, pseudonym)
);

CREATE INDEX idx_cloak_maps_compilation_id ON cloak_maps(compilation_id);
