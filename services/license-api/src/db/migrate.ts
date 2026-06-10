/**
 * Idempotent schema bootstrap for the license-api.
 *
 * Runs on every container start (chained before `node dist/index.js`).
 * Creates every table the code expects and ALTER-adds every column that
 * might be missing on older deployments. All operations use
 * `IF NOT EXISTS` clauses so the script is safe to re-run.
 *
 * This is a deliberately minimal alternative to drizzle-kit migrations —
 * the live DB doesn't have a recorded migration history, so we'd have to
 * either backfill one (risky) or reset (catastrophic). Instead, we keep
 * the desired schema declared in one place and reconcile it on boot.
 *
 * To add a new column: append an ALTER TABLE ... ADD COLUMN IF NOT EXISTS
 * line below. To add a new table: append the full CREATE TABLE IF NOT EXISTS.
 */
import { Pool } from 'pg';

const STATEMENTS: string[] = [
  // ── Extensions ──────────────────────────────────────────────────────────
  `CREATE EXTENSION IF NOT EXISTS "pgcrypto"`,

  // ── users ───────────────────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS users (
     id                     UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
     email                  TEXT         NOT NULL UNIQUE,
     password_hash          TEXT         NOT NULL,
     name                   TEXT         NOT NULL DEFAULT '',
     role                   TEXT         NOT NULL DEFAULT 'viewer',
     tier                   TEXT         NOT NULL DEFAULT 'free',
     credits_balance        INTEGER      NOT NULL DEFAULT 3000,
     overdraft_limit        INTEGER      NOT NULL DEFAULT 0,
     stripe_customer_id     TEXT,
     stripe_subscription_id TEXT,
     email_verified         BOOLEAN      NOT NULL DEFAULT false,
     suspended              BOOLEAN      NOT NULL DEFAULT false,
     created_at             TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
     updated_at             TIMESTAMPTZ  NOT NULL DEFAULT NOW()
   )`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS name TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'viewer'`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS tier TEXT NOT NULL DEFAULT 'free'`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS credits_balance INTEGER NOT NULL DEFAULT 3000`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS overdraft_limit INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT false`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS suspended BOOLEAN NOT NULL DEFAULT false`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`,

  // ── licenses ────────────────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS licenses (
     id                     UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
     user_id                UUID         NOT NULL REFERENCES users(id),
     license_key            TEXT         NOT NULL UNIQUE,
     hardware_fingerprint   TEXT,
     status                 TEXT         NOT NULL DEFAULT 'inactive',
     tier                   TEXT         NOT NULL DEFAULT 'free',
     grace_period_ends_at   TIMESTAMPTZ,
     seat_reassignments     INTEGER      NOT NULL DEFAULT 0,
     last_reassignment_at   TIMESTAMPTZ,
     activated_at           TIMESTAMPTZ,
     last_heartbeat_at      TIMESTAMPTZ,
     created_at             TIMESTAMPTZ  NOT NULL DEFAULT NOW()
   )`,
  `ALTER TABLE licenses ADD COLUMN IF NOT EXISTS hardware_fingerprint TEXT`,
  `ALTER TABLE licenses ADD COLUMN IF NOT EXISTS grace_period_ends_at TIMESTAMPTZ`,
  `ALTER TABLE licenses ADD COLUMN IF NOT EXISTS seat_reassignments INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE licenses ADD COLUMN IF NOT EXISTS last_reassignment_at TIMESTAMPTZ`,
  `ALTER TABLE licenses ADD COLUMN IF NOT EXISTS activated_at TIMESTAMPTZ`,
  `ALTER TABLE licenses ADD COLUMN IF NOT EXISTS last_heartbeat_at TIMESTAMPTZ`,

  // ── token_usage (THE drift that caused the crashloop) ───────────────────
  `CREATE TABLE IF NOT EXISTS token_usage (
     id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
     user_id         UUID         NOT NULL REFERENCES users(id),
     license_id      UUID         REFERENCES licenses(id),
     action          TEXT         NOT NULL,
     chars_processed INTEGER,
     credits_spent   INTEGER      NOT NULL,
     is_overdraft    BOOLEAN      NOT NULL DEFAULT false,
     created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
   )`,
  `ALTER TABLE token_usage ADD COLUMN IF NOT EXISTS license_id UUID REFERENCES licenses(id)`,
  `ALTER TABLE token_usage ADD COLUMN IF NOT EXISTS chars_processed INTEGER`,
  `ALTER TABLE token_usage ADD COLUMN IF NOT EXISTS is_overdraft BOOLEAN NOT NULL DEFAULT false`,

  // ── subscriptions ───────────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS subscriptions (
     id                       UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
     user_id                  UUID         NOT NULL REFERENCES users(id),
     stripe_subscription_id   TEXT         NOT NULL UNIQUE,
     stripe_price_id          TEXT         NOT NULL,
     tier                     TEXT         NOT NULL,
     status                   TEXT         NOT NULL,
     current_period_end       TIMESTAMPTZ  NOT NULL,
     cancel_at_period_end     BOOLEAN      NOT NULL DEFAULT false,
     created_at               TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
     updated_at               TIMESTAMPTZ  NOT NULL DEFAULT NOW()
   )`,

  // ── audit_log ───────────────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS audit_log (
     id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
     admin_id        UUID         REFERENCES users(id),
     action          TEXT         NOT NULL,
     target_user_id  UUID         REFERENCES users(id),
     payload         JSONB,
     created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
   )`,

  // ── app_versions ────────────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS app_versions (
     id               UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
     version          TEXT         NOT NULL,
     channel          TEXT         NOT NULL DEFAULT 'stable',
     update_required  BOOLEAN      NOT NULL DEFAULT false,
     changelog        TEXT,
     rollout_percent  INTEGER      NOT NULL DEFAULT 100,
     created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
   )`,

  // ── indexes ─────────────────────────────────────────────────────────────
  `CREATE INDEX IF NOT EXISTS idx_licenses_user_id        ON licenses(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_token_usage_user_id     ON token_usage(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_token_usage_license_id  ON token_usage(license_id)`,
  `CREATE INDEX IF NOT EXISTS idx_token_usage_created_at  ON token_usage(created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_audit_log_created_at    ON audit_log(created_at DESC)`,
];

async function main() {
  const conn = process.env['DATABASE_URL'];
  if (!conn) {
    console.error('[migrate] DATABASE_URL not set — refusing to start.');
    process.exit(1);
  }

  const pool = new Pool({ connectionString: conn });
  let applied = 0;
  let failed = 0;
  const errors: string[] = [];

  try {
    for (const [i, sql] of STATEMENTS.entries()) {
      try {
        await pool.query(sql);
        applied++;
      } catch (err) {
        // Most failures are benign: column-already-exists with a non-matching
        // type, or a CHECK constraint that already references the column.
        // We log and continue so a single bad statement can't block boot.
        failed++;
        const msg = (err as Error)?.message ?? String(err);
        errors.push(`#${i}: ${sql.slice(0, 80).replace(/\s+/g, ' ')}... → ${msg}`);
      }
    }
  } finally {
    await pool.end();
  }

  console.log(`[migrate] ${applied} ok, ${failed} skipped`);
  if (errors.length > 0) {
    console.warn(`[migrate] non-fatal warnings:`);
    for (const e of errors) console.warn(`  ${e}`);
  }
  // Exit successfully even with some warnings — the app should still boot
  // and self-recover after the canonical statements created the missing columns.
}

main().catch((err) => {
  console.error('[migrate] fatal:', err);
  process.exit(1);
});
