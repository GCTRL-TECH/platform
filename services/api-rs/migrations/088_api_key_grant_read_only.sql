-- Per-grant read-only bit (Option B of the Anvil personal-key visibility fix, 2026-09-08).
--
-- Until now `api_keys.read_only` was the ONLY read/write switch, and it is key-wide. A
-- colleague's personal (read-write) key therefore could not be granted a knowledge base
-- "for reading only": the moment the grant existed, the key could also write into it.
-- Anvil worked around that with a separate read-only key per (room, member) — which is
-- exactly why a shared room never showed up under the member's personal token.
--
-- `read_only = true` on a grant means: this key may SEE the compilation (list, query,
-- search, graph reads — unchanged) but every mutation targeting it is refused
-- (`enforce_kb_write_scope`, chunk mutations, default-target linking). Default false keeps
-- every existing grant read-write, so nothing changes for keys minted before this.
ALTER TABLE api_key_grants
  ADD COLUMN IF NOT EXISTS read_only BOOLEAN NOT NULL DEFAULT false;
