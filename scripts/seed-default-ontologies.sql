-- scripts/seed-default-ontologies.sql
--
-- Backfill: ensure every existing user has a "General Knowledge" default
-- ontology so KEX/FUSE work out of the box. Idempotent on re-run because
-- it only targets users where default_ontology_id IS NULL.
--
-- Usage:
--   psql "$DATABASE_URL" -f scripts/seed-default-ontologies.sql
--
-- Depends on migrations 007 (ontologies tables) and 014 (users.default_ontology_id).

DO $$
DECLARE
    u RECORD;
    new_ontology_id UUID;
BEGIN
    FOR u IN SELECT id FROM users WHERE default_ontology_id IS NULL LOOP
        new_ontology_id := uuid_generate_v4();

        INSERT INTO ontologies (id, user_id, name, description, scope, source, entity_type_count)
        VALUES (
            new_ontology_id,
            u.id,
            'General Knowledge',
            'Default ontology with common entity types — covers people, organizations, places, dates, and concepts',
            'private',
            'system',
            10
        )
        ON CONFLICT (user_id, name) DO NOTHING;

        -- If the user already had a "General Knowledge" ontology, reuse it
        -- instead of leaving them without a default pointer.
        SELECT id INTO new_ontology_id
        FROM ontologies
        WHERE user_id = u.id AND name = 'General Knowledge'
        LIMIT 1;

        INSERT INTO ontology_entity_types (ontology_id, qid, name, aliases, color, confidence_threshold) VALUES
            (new_ontology_id, 'Q5',        'Person',       ARRAY['individual','human','name'],                       '#6366f1', 0.3),
            (new_ontology_id, 'Q43229',    'Organization', ARRAY['company','corporation','agency','institution'],    '#f59e0b', 0.3),
            (new_ontology_id, 'Q17334923', 'Location',     ARRAY['place','city','country','region','address'],       '#10b981', 0.3),
            (new_ontology_id, 'Q205892',   'Date',         ARRAY['time','datetime','period','year'],                 '#ec4899', 0.3),
            (new_ontology_id, 'Q2424752',  'Product',      ARRAY['item','goods','service'],                          '#8b5cf6', 0.3),
            (new_ontology_id, 'Q1656682',  'Event',        ARRAY['happening','occurrence','meeting'],                '#ef4444', 0.3),
            (new_ontology_id, 'Q1368',     'Money',        ARRAY['currency','price','amount','value'],               '#22c55e', 0.3),
            (new_ontology_id, 'Q49848',    'Document',     ARRAY['file','paper','contract','report'],                '#06b6d4', 0.3),
            (new_ontology_id, 'Q151885',   'Concept',      ARRAY['idea','topic','subject'],                          '#94a3b8', 0.3),
            (new_ontology_id, 'Q9158',     'Email',        ARRAY['emailaddress'],                                    '#f97316', 0.3)
        ON CONFLICT (ontology_id, name) DO NOTHING;

        UPDATE users SET default_ontology_id = new_ontology_id WHERE id = u.id;
    END LOOP;
END $$;

-- Seed default workspace (folder + first compilation) for any user who has none.
DO $$
DECLARE
    u RECORD;
    new_folder_id UUID;
BEGIN
    FOR u IN
        SELECT id FROM users
        WHERE NOT EXISTS (SELECT 1 FROM compilations c WHERE c.user_id = users.id)
    LOOP
        new_folder_id := uuid_generate_v4();

        INSERT INTO kg_folders (id, user_id, name, position)
        VALUES (new_folder_id, u.id, 'My Workspace', 0)
        ON CONFLICT DO NOTHING;

        INSERT INTO compilations (id, user_id, name, description, classification, folder_id)
        VALUES (
            uuid_generate_v4(), u.id,
            'My First Knowledge Base',
            'Default knowledge graph — extractions land here unless you create a new one',
            'INTERNAL',
            new_folder_id
        )
        ON CONFLICT DO NOTHING;
    END LOOP;
END $$;
