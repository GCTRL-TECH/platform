-- Folder hygiene: put every existing knowledge base where the new placement rules say it
-- belongs, and retire the "My Workspace" seed.
--
-- Ordering matters and is not cosmetic:
--   1. cycles first  — the recursive folder count added in this release walks parents, and
--                      a cyclic tree predates the cycle check that now rejects one.
--   2. Inbox before deleting My Workspace — the seeded KB has to leave the folder before
--      the folder can qualify as empty.
--
-- Idempotent throughout: every INSERT is guarded by NOT EXISTS, every UPDATE by a WHERE
-- that stops matching once applied. Re-running changes nothing.

-- ── 1. Break self-referencing folders ────────────────────────────────────────
UPDATE kg_folders SET parent_folder_id = NULL WHERE parent_folder_id = id;

-- ── 2. Global/Inbox, and the default sink moved into it ──────────────────────
-- "My First Knowledge Base" is seeded per registration, but `resolve_default_compilation`
-- picks the OLDEST non-system compilation — so on a shared instance one user's seed silently
-- became the landing spot for every untargeted ingest of everyone. Filing it under
-- Users/<name> would label that person's folder with other people's imports; it belongs in a
-- neutral inbox, named for what it actually is.
INSERT INTO kg_folders (id, user_id, name, parent_folder_id)
SELECT uuid_generate_v4(), c.user_id, 'Global', NULL
FROM (SELECT DISTINCT user_id FROM compilations WHERE name = 'My First Knowledge Base') c
WHERE NOT EXISTS (
  SELECT 1 FROM kg_folders f
  WHERE f.user_id = c.user_id AND f.name = 'Global' AND f.parent_folder_id IS NULL
);

INSERT INTO kg_folders (id, user_id, name, parent_folder_id)
SELECT uuid_generate_v4(), g.user_id, 'Inbox', g.id
FROM kg_folders g
WHERE g.name = 'Global' AND g.parent_folder_id IS NULL
  AND EXISTS (SELECT 1 FROM compilations c WHERE c.user_id = g.user_id AND c.name = 'My First Knowledge Base')
  AND NOT EXISTS (
    SELECT 1 FROM kg_folders f WHERE f.user_id = g.user_id AND f.name = 'Inbox' AND f.parent_folder_id = g.id
  );

UPDATE compilations c
SET folder_id = i.id,
    name = 'Standard-Wissensbasis (unsortiert)',
    description = COALESCE(c.description, '') ||
      CASE WHEN COALESCE(c.description, '') = '' THEN '' ELSE E'\n' END ||
      'Sammelpunkt für Importe ohne gewähltes Ziel — kann Material mehrerer Nutzer enthalten.',
    updated_at = NOW()
FROM kg_folders i
JOIN kg_folders g ON g.id = i.parent_folder_id AND g.name = 'Global' AND g.parent_folder_id IS NULL
WHERE i.name = 'Inbox'
  AND i.user_id = c.user_id
  AND c.name = 'My First Knowledge Base';

-- ── 3. Retire "My Workspace" — but only where it is genuinely empty ──────────
DELETE FROM kg_folders f
WHERE f.name = 'My Workspace'
  AND NOT EXISTS (SELECT 1 FROM compilations c WHERE c.folder_id = f.id)
  AND NOT EXISTS (SELECT 1 FROM kg_folders k WHERE k.parent_folder_id = f.id);

-- ── 4. Repair graphs pointing at someone else's folder ──────────────────────
-- Possible until this release: the move endpoint never checked that the target folder
-- belonged to the caller, and such a graph renders in neither the root nor any folder.
-- Runs BEFORE the sweep below so the same pass re-files them.
UPDATE compilations c
SET folder_id = NULL, updated_at = NOW()
FROM kg_folders f
WHERE f.id = c.folder_id AND f.user_id <> c.user_id;

-- ── 5. Unfiled graphs go to their owner's Users/<localpart> ──────────────────
-- System compilations (the non-deletable "Knowledge Wiki") legitimately live at the root.
INSERT INTO kg_folders (id, user_id, name, parent_folder_id)
SELECT uuid_generate_v4(), c.user_id, 'Users', NULL
FROM (SELECT DISTINCT user_id FROM compilations
      WHERE folder_id IS NULL AND COALESCE(is_system, false) = false) c
WHERE NOT EXISTS (
  SELECT 1 FROM kg_folders f
  WHERE f.user_id = c.user_id AND f.name = 'Users' AND f.parent_folder_id IS NULL
);

INSERT INTO kg_folders (id, user_id, name, parent_folder_id)
SELECT uuid_generate_v4(), r.user_id, r.localpart, r.users_folder
FROM (
  SELECT DISTINCT c.user_id,
         NULLIF(split_part(COALESCE(u.email, ''), '@', 1), '') AS localpart,
         f.id AS users_folder
  FROM compilations c
  JOIN users u ON u.id = c.user_id
  JOIN kg_folders f ON f.user_id = c.user_id AND f.name = 'Users' AND f.parent_folder_id IS NULL
  WHERE c.folder_id IS NULL AND COALESCE(c.is_system, false) = false
) r
WHERE r.localpart IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM kg_folders f2
    WHERE f2.user_id = r.user_id AND f2.name = r.localpart AND f2.parent_folder_id = r.users_folder
  );

UPDATE compilations c
SET folder_id = uf.id, updated_at = NOW()
FROM users u
JOIN kg_folders root ON root.user_id = u.id AND root.name = 'Users' AND root.parent_folder_id IS NULL
JOIN kg_folders uf   ON uf.user_id = u.id AND uf.parent_folder_id = root.id
                    AND uf.name = split_part(COALESCE(u.email, ''), '@', 1)
WHERE c.user_id = u.id
  AND c.folder_id IS NULL
  AND COALESCE(c.is_system, false) = false;
