-- Obsidian "folder vault" support: a vault that lives as a directory mounted
-- into the API container (no REST API / token). Distinguished from REST vaults
-- by `kind`. Folder vaults have no vault_url / api_token, so widen those columns.

ALTER TABLE obsidian_vaults ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'rest';
ALTER TABLE obsidian_vaults ADD COLUMN IF NOT EXISTS folder_path TEXT;

ALTER TABLE obsidian_vaults ALTER COLUMN vault_url DROP NOT NULL;
ALTER TABLE obsidian_vaults ALTER COLUMN api_token DROP NOT NULL;
