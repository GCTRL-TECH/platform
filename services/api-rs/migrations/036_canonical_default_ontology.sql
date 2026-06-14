-- One canonical, SHARED "General Knowledge" default ontology.
--
-- Before: every registered user got their OWN private copy named
-- "General Knowledge" (35+ duplicate rows). Admins, whose ontology list returns
-- ALL users' ontologies, saw the whole pile — looking like "a new ontology per
-- extraction". KEX never actually created ontologies; the duplicates came from
-- the per-user registration seed.
--
-- After: a single shared ontology that everyone uses as their default and that
-- KEX EXTENDS in place (adds newly-seen entity types, never removes) when no
-- other ontology is explicitly selected. Per-user custom ontologies still exist
-- for bespoke schemas. Entity *data* stays access-controlled per user in Neo4j;
-- only the type vocabulary is shared.

-- A system-owned ontology has no specific user owner.
ALTER TABLE ontologies ALTER COLUMN user_id DROP NOT NULL;

-- Canonical shared default (fixed id so the seed + KEX can reference it).
INSERT INTO ontologies (id, user_id, name, description, scope, source, entity_type_count)
VALUES ('00000000-0000-0000-0000-0000000000a1', NULL, 'General Knowledge',
        'Shared default ontology — common entity types (people, organizations, places, dates, concepts). KEX extends this in place when no other ontology is selected.',
        'public', 'system', 10)
ON CONFLICT (id) DO NOTHING;

-- Base entity types for the canonical ontology (id auto-generated).
INSERT INTO ontology_entity_types (ontology_id, qid, name, aliases, color, confidence_threshold) VALUES
  ('00000000-0000-0000-0000-0000000000a1', 'Q5',        'Person',       ARRAY['individual','human','name'],            '#6366f1', 0.3),
  ('00000000-0000-0000-0000-0000000000a1', 'Q43229',    'Organization', ARRAY['company','corporation','agency','institution'], '#f59e0b', 0.3),
  ('00000000-0000-0000-0000-0000000000a1', 'Q17334923', 'Location',     ARRAY['place','city','country','region','address'],    '#10b981', 0.3),
  ('00000000-0000-0000-0000-0000000000a1', 'Q205892',   'Date',         ARRAY['time','datetime','period','year'],      '#ec4899', 0.3),
  ('00000000-0000-0000-0000-0000000000a1', 'Q2424752',  'Product',      ARRAY['item','goods','service'],               '#8b5cf6', 0.3),
  ('00000000-0000-0000-0000-0000000000a1', 'Q1656682',  'Event',        ARRAY['happening','occurrence','meeting'],     '#ef4444', 0.3),
  ('00000000-0000-0000-0000-0000000000a1', 'Q1368',     'Money',        ARRAY['currency','price','amount','value'],    '#22c55e', 0.3),
  ('00000000-0000-0000-0000-0000000000a1', 'Q49848',    'Document',     ARRAY['file','paper','contract','report'],     '#06b6d4', 0.3),
  ('00000000-0000-0000-0000-0000000000a1', 'Q151885',   'Concept',      ARRAY['idea','topic','subject'],               '#94a3b8', 0.3),
  ('00000000-0000-0000-0000-0000000000a1', 'Q9158',     'Email',        ARRAY['emailaddress'],                         '#f97316', 0.3)
ON CONFLICT (ontology_id, name) DO NOTHING;

-- Repoint any compilation that referenced a soon-to-be-deleted ontology to the
-- canonical one (compilations.ontology_id FK is RESTRICT, so this must run first).
UPDATE compilations
   SET ontology_id = '00000000-0000-0000-0000-0000000000a1'
 WHERE ontology_id IS NOT NULL
   AND ontology_id <> '00000000-0000-0000-0000-0000000000a1';

-- Drop all the old duplicate per-user ontologies (entity types / match rules /
-- learned weights cascade; parent/review refs SET NULL).
DELETE FROM ontologies WHERE id <> '00000000-0000-0000-0000-0000000000a1';

-- Point every existing user's default at the canonical ontology.
UPDATE users SET default_ontology_id = '00000000-0000-0000-0000-0000000000a1';
