-- P2a — grounded nodes: explicit entity<->chunk linkage.
--
-- text_chunks.entity_mentions already carries {name,type,label} per mention, but
-- has no stable entity identifier — looking up "which chunks ground entity X" was
-- a lossy name search. entity_uris holds the graph URI (kg_builder's
-- `databorg:{user12}/{type}/{slug}` scheme) for every mention that resolved to a
-- node actually written to the graph (pruned/isolated mentions are excluded), so
-- a node's grounding chunks can be found with `entity_uris @> ARRAY[uri]` /
-- `entity_uris && ARRAY[uri1, uri2, ...]` (GIN-indexed for that lookup).
ALTER TABLE text_chunks ADD COLUMN IF NOT EXISTS entity_uris TEXT[] DEFAULT '{}';
CREATE INDEX IF NOT EXISTS idx_text_chunks_entity_uris ON text_chunks USING GIN (entity_uris);
