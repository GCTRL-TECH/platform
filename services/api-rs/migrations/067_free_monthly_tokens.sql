-- Free monthly token grant: every user gets 1,000,000 tokens per month at no cost.
--
-- `users.tokens_balance` is the authoritative enforcement balance the whole
-- platform debits (KEX -5, FUSE -10, kg -3, agent -5/-10). The separate
-- `licenses` table (paid license-server model, reconciled by heartbeat) is left
-- untouched. A daily background tick tops each user back up to the 1M floor once
-- their rolling one-month window elapses (see background::spawn_all).

-- New signups default to the full monthly grant.
ALTER TABLE users ALTER COLUMN tokens_balance SET DEFAULT 1000000;

-- Track when each user last received their free monthly grant (per-user window).
ALTER TABLE users ADD COLUMN IF NOT EXISTS tokens_granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- Backfill every existing user up to the 1M floor. GREATEST never reduces a
-- larger balance (e.g. a manual admin top-up or a heavier paid grant).
UPDATE users
SET tokens_balance   = GREATEST(tokens_balance, 1000000),
    tokens_granted_at = NOW();
