-- 093: the relation registry learns the one everyday "which is current?" case
-- it was missing — a person's CURRENT employer.
--
-- Fact-conflict detection (migration 061, kex/fuse conflicts.py) fires only
-- for relations listed here. The seed covered leadership and places; the
-- most common update in the documents people re-upload (CVs, team pages,
-- org charts) is a change of employer, and that relation was left out
-- because "people hold multiple jobs". The KEX vocabulary (relvocab.py)
-- settles that: `works_at` means the CURRENT employer by definition — a past
-- one is extracted as `worked_at`. So two `works_at` values for one person
-- are either an update (the newer document wins, the old value is marked
-- superseded) or an extraction error, which is exactly what the conflict
-- page should show.
--
-- Still deliberately NOT functional: has_role (people carry several titles at
-- once — CTO and co-founder), worked_at (history by definition), member_of,
-- manages, located_in for persons, and every technology relation.

INSERT INTO relation_registry (relation, functional, key_side, key_type, scope_note, enabled) VALUES
  ('works_at', true, 'head', 'person',
   'One CURRENT employer per person (person->org, keyed by the HEAD person). The KEX vocabulary extracts past employment as worked_at, so a second works_at value is an update from a newer document or an extraction error.',
   true)
ON CONFLICT (relation) DO NOTHING;
