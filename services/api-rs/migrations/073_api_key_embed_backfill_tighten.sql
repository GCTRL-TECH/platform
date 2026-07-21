-- Corrective for migration 072's backfill (which matched embed tokens by mint-name
-- ONLY). A manually-named read-write "Embed: ..." colleague token could have been
-- wrongly hidden. Un-hide anything that isn't the actual embed shape (read-only +
-- kb-scoped + at least one grant) — a genuine iframe embed always has all three.
-- Cannot edit 072 in place: sqlx checksums applied migrations, so tightening ships
-- as this follow-up. Idempotent; a no-op on fresh installs where 072 already ran.

UPDATE api_keys
SET embed = false
WHERE embed = true
  AND NOT (
        read_only = true
    AND kb_scoped = true
    AND EXISTS (SELECT 1 FROM api_key_grants g WHERE g.api_key_id = api_keys.id)
  );
