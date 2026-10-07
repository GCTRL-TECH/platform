-- Per-grant origin: who last set this grant, a human or a sync (2026-10-07).
--
-- Anvil's hourly personal-key sweep POSTs every (key, compilation) grant it derives from
-- room membership, with `readOnly` following the member's room role. Since 088 that POST
-- is an upsert that overwrites `read_only` — so a grant an admin set BY HAND in the GCTRL
-- settings UI (e.g. "give this colleague write access to the shared KB") was silently
-- flipped back to read-only within the hour, and a hand-revoked grant came back.
--
-- `source` records who owns the grant:
--   'manual'  - set by a person in the GCTRL UI, which sends `source: "manual"` explicitly.
--               Never changed or removed by a managed sweep; a manual post always wins and
--               marks the grant manual.
--   'managed' - everything else: an automated sync (Anvil), a script, or a client that
--               does not know the field. A managed post only touches managed grants.
-- Default 'managed', for the column and for a POST without `source`: Anvil has several
-- grant writers besides the sweep (room KB on creation, onboarding, code grants) that
-- predate this field, and every grant that exists before this migration was set by one of
-- them or by the sweep. Freezing those would stop the sweep from revoking a grant when a
-- member leaves a room. A person who wants a grant protected sets it in the UI once.
ALTER TABLE api_key_grants
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'managed';

ALTER TABLE api_key_grants
  DROP CONSTRAINT IF EXISTS api_key_grants_source_check;
ALTER TABLE api_key_grants
  ADD CONSTRAINT api_key_grants_source_check CHECK (source IN ('manual', 'managed'));
