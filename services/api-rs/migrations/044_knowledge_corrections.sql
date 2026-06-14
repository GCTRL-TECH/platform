-- Knowledge corrections: a persistent record of falsehoods a user has fixed in
-- the knowledge graph, so re-extraction never re-introduces them ("remember").
--
-- When a user (or the Pi agent on their behalf) spots a wrong relationship —
-- e.g. `Fabio -[co_founder_of]-> Codex` that is simply false — the API deletes
-- the edge from Neo4j immediately AND records the correction here. The KEX
-- relation writer (kg_builder.py) consults this table and SKIPs any
-- (head, rel_type, tail) the user has marked `action='delete'`, so the next
-- extraction of the same source can't recreate the falsehood.
--
-- element_kind: 'edge' (a relationship triple) or 'node' (an entity).
-- action:       'delete' (remove + never re-add), 'rename', or 'flag' (advisory).
-- For nodes, rel_type/tail are NULL and `head` is the node name.

CREATE TABLE IF NOT EXISTS knowledge_corrections (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  compilation_id UUID REFERENCES compilations(id) ON DELETE SET NULL,
  element_kind   TEXT NOT NULL DEFAULT 'edge',   -- 'edge' | 'node'
  head           TEXT NOT NULL,
  rel_type       TEXT,
  tail           TEXT,
  action         TEXT NOT NULL DEFAULT 'delete',  -- 'delete' | 'rename' | 'flag'
  reason         TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The KEX worker looks up corrections by user + triple on every relation write,
-- so index the lookup shape.
CREATE INDEX IF NOT EXISTS idx_knowledge_corrections_lookup
  ON knowledge_corrections (user_id, head, rel_type, tail)
  WHERE action = 'delete';

CREATE INDEX IF NOT EXISTS idx_knowledge_corrections_user
  ON knowledge_corrections (user_id, created_at DESC);
