-- P3 — Relation registry: which relations are FUNCTIONAL, i.e. expected to
-- carry exactly ONE current value per key entity. Fact-conflict detection
-- (KEX write-time + FUSE post-merge) only ever fires for relations listed
-- here with functional = true AND enabled = true — everything else is
-- multi-valued by default and can never produce a false conflict.
--
-- Design decisions (P3, precision-critical — a false conflict destroys user
-- trust faster than a missed one, so the seed is deliberately conservative):
--
--   relation  : canonical lowercase name as in the KEX relation vocabulary
--               (services/kex/src/relvocab.py). Detection matches edges by the
--               sanitised Neo4j type (ceo_of -> CEO_OF), mirroring
--               kg_builder._safe_rel_type.
--   key_side  : which end of the edge is the "one value per" anchor.
--               'tail' = one head per tail (ceo_of: person->org, but the ORG
--                        has one CEO — the conflict key is the tail).
--               'head' = one tail per head (located_in: the ORG has one HQ —
--                        the conflict key is the head).
--   key_type  : optional coarse-type constraint on the KEY node (matched
--               against coalesce(n.coarse_type, n.type)). NULL = any type.
--               This is how "located_in is functional FOR ORGANIZATIONS ONLY"
--               is enforced without free-text parsing.
--   scope_note: human-readable rationale for reviewers/UI.
--   enabled   : kill switch per relation (no redeploy needed to silence one).
--
-- Seeded INCLUSIONS (each expects ONE current value per key):
--   ceo_of        (tail, organization) — an org has exactly one current CEO.
--   heads         (tail, organization) — a unit/group has one current head.
--   reports_to    (head, person)       — a person has one direct manager.
--   located_in    (head, organization) — an ORG has one HQ/location. Persons
--                                        and technologies may legitimately
--                                        relate to many locations -> key_type
--                                        restricts detection to organizations.
--   headquartered_in (head, organization) — not in the KEX vocab today (its
--                                        surface forms normalise to located_in)
--                                        but merged/imported graphs may carry
--                                        it verbatim; unambiguous, so seeded.
--   born_in       (head, person)       — one birthplace per person (immutable;
--                                        a conflict is an extraction error or
--                                        a homonym — exactly what to surface).
--   spin_off_of   (head, organization) — an org is a spin-off of ONE parent.
--   version_of    (head, NULL)         — reserved: not emitted by the KEX
--                                        vocabulary yet; seeded so imported
--                                        graphs are covered the moment the
--                                        relation appears.
--
-- Deliberate EXCLUSIONS (round 1 — would create false conflicts):
--   works_at / worked_at — people hold multiple concurrent/successive jobs.
--   founded / co_founder_of — an org has many founders AND a founder founds
--                             many orgs: not functional on either side.
--   member_of, manages, professor_at, studied_at — inherently multi-valued.
--   has_role, has_degree, has_skill, speaks, lived_in — multi-valued
--                             person attributes.
--   hosted_on, uses, built_with, part_of — technology relations are
--                             many-to-many in practice.

CREATE TABLE IF NOT EXISTS relation_registry (
  relation   TEXT PRIMARY KEY,
  functional BOOLEAN NOT NULL DEFAULT true,
  key_side   TEXT NOT NULL CHECK (key_side IN ('head', 'tail')),
  key_type   TEXT,
  scope_note TEXT,
  enabled    BOOLEAN NOT NULL DEFAULT true
);

INSERT INTO relation_registry (relation, functional, key_side, key_type, scope_note, enabled) VALUES
  ('ceo_of',           true, 'tail', 'organization', 'One current CEO per organization. Direction is person->org, so the conflict key is the TAIL org.', true),
  ('heads',            true, 'tail', 'organization', 'One current head per unit/group (person->org, keyed by the tail org). Same shape as ceo_of.', true),
  ('reports_to',       true, 'head', 'person',       'One direct manager per person (person->person, keyed by the HEAD person).', true),
  ('located_in',       true, 'head', 'organization', 'ORGANIZATIONS ONLY: an org has one HQ/base. Persons/technologies may have many locations, so key_type gates detection to orgs.', true),
  ('headquartered_in', true, 'head', 'organization', 'One HQ per organization. Not emitted by the KEX vocab (normalises to located_in) but merged/imported graphs may carry it verbatim.', true),
  ('born_in',          true, 'head', 'person',       'One birthplace per person — immutable fact; a second value is an extraction error or homonym.', true),
  ('spin_off_of',      true, 'head', 'organization', 'An organization is a spin-off of exactly one parent organization.', true),
  ('version_of',       true, 'head', NULL,           'Reserved: one canonical parent per version. Not in the KEX vocabulary yet; covers imported graphs.', true)
ON CONFLICT (relation) DO NOTHING;
