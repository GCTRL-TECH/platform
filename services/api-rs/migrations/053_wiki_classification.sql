-- Wiki page classification (compliance layer for the WIKI compilation type).
--
-- Until now wiki_pages carried no classification, so a distilled page derived
-- from CONFIDENTIAL source entities/chunks was readable by anyone who could read
-- the (possibly INTERNAL) WIKI compilation. This migration gives every page its
-- own clearance rank so per-page enforcement can hide pages above a caller's
-- clearance — in the page list, the wiki graph, and wiki-served RAG answers.
--
-- min_rank mirrors the Neo4j `_min_rank` convention: a page's rank is the MAX
-- (most restrictive) rank over every contributing entity + grounding chunk.
-- class_labels is the union of the contributing classification labels.
-- classification_level_id is an optional FK to the canonical level for display.
--
-- Existing pages default to min_rank=0 (PUBLIC); the next distill run repopulates
-- the real ranks from the source graph + chunks.

ALTER TABLE wiki_pages
  ADD COLUMN min_rank INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN class_labels TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN classification_level_id UUID REFERENCES classification_levels(id) ON DELETE SET NULL;

-- Page-level clearance filtering hits this on every list / graph / RAG-match read.
CREATE INDEX idx_wiki_pages_min_rank ON wiki_pages(compilation_id, min_rank);
