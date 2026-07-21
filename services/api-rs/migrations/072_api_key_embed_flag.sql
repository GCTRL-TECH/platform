-- Embed tokens are auto-minted, read-only, kb-scoped throwaway keys for iframe
-- graph embeds (GCTRL's EmbedShareDialog → "Embed: <graph>", and Anvil's
-- embed-token route → "Anvil embed <ISO>", the latter with a 15-min expiry).
-- They flooded the Access-Token management list (dozens per user) though they are
-- not colleague tokens. Mark them so list_keys can hide them and a nightly task
-- can prune the expired ones (auth already rejects expired keys; nothing pruned
-- them, so the table grew unbounded).

ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS embed BOOLEAN NOT NULL DEFAULT false;

-- Backfill existing throwaway embed keys from both sources by their minting name.
UPDATE api_keys
SET embed = true
WHERE embed = false
  AND (name LIKE 'Anvil embed%' OR name LIKE 'Embed: %');
