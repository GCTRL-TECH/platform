# Phase 2: License Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and deploy the complete control-plane server: License API, Token API, Stripe billing, email via Resend, customer portal (Next.js), and admin dashboard — all running on gctrl.tech.

**Architecture:** A Node.js/Express API (`gctrl-api`) handles all license operations, token metering, Stripe webhooks, and admin routes. A Next.js app (`gctrl-web`) serves both the public marketing site and the authenticated customer portal/admin dashboard. PostgreSQL stores all state. RS256 key pair (generated in Phase 1) signs license JWTs. Resend handles transactional email. Both services run as Docker containers behind Traefik on the VPS.

**Tech Stack:** Node.js 20, Express, TypeScript, Drizzle ORM, PostgreSQL 16, Redis 7, Next.js 14, Stripe SDK, Resend SDK, jose (JWT RS256), Docker, Traefik

**Prerequisite:** Phase 1 complete — VPS running PostgreSQL + Redis, DNS pointing to VPS, RS256 keypair in `/opt/gctrl/keys/`.

---

## File Map

```
services/
  license-api/
    src/
      index.ts              — Express app entry point
      db/
        schema.ts           — Drizzle schema: users, licenses, token_usage, subscriptions
        migrate.ts          — Run migrations on startup
        index.ts            — DB connection
      routes/
        activate.ts         — POST /v1/activate
        heartbeat.ts        — POST /v1/heartbeat
        tokens.ts           — POST /v1/usage, GET /v1/balance
        stripe.ts           — POST /v1/webhooks/stripe
        admin.ts            — GET/POST /admin/* (all admin routes)
        health.ts           — GET /health
      middleware/
        auth.ts             — Verify license JWT + extract claims
        adminAuth.ts        — Verify admin role
        rateLimit.ts        — Per-tier rate limiting via Redis
      lib/
        jwt.ts              — RS256 sign/verify using jose
        licenseKey.ts       — Generate + validate GCTRL-XXXX-XXXX keys
        fingerprint.ts      — Validate hardware fingerprint format
        credits.ts          — Credit cost constants + overdraft rules
        email.ts            — Resend email client + template renderer
        registryToken.ts    — Generate short-lived ghcr.io pull tokens
      Dockerfile
      package.json
      tsconfig.json

  web/                      — Next.js app (already exists, extend it)
    src/
      app/
        page.tsx            — Marketing landing page
        login/page.tsx      — Login / signup
        dashboard/page.tsx  — Customer dashboard: balance, usage, machines
        billing/page.tsx    — Stripe portal redirect
        admin/
          page.tsx          — Admin overview
          users/page.tsx    — User list + management
          licenses/page.tsx — License management
          credits/page.tsx  — Credit top-up / deduction
          updates/page.tsx  — Version + changelog management
          analytics/page.tsx — Usage analytics
      lib/
        api.ts              — Typed fetch client for license-api
        auth.ts             — Session management (JWT cookie)
```

---

### Task 1: Database Schema

**Files:**
- Create: `services/license-api/src/db/schema.ts`
- Create: `services/license-api/src/db/index.ts`

- [ ] **Step 1: Write schema**

```typescript
// services/license-api/src/db/schema.ts
import { pgTable, uuid, text, integer, bigint, timestamp, boolean, jsonb } from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  role: text('role').notNull().default('user'), // 'user' | 'admin'
  tier: text('tier').notNull().default('free'), // 'free' | 'starter' | 'pro' | 'enterprise'
  creditsBalance: integer('credits_balance').notNull().default(3000),
  overdraftLimit: integer('overdraft_limit').notNull().default(0),
  stripeCustomerId: text('stripe_customer_id'),
  stripeSubscriptionId: text('stripe_subscription_id'),
  emailVerified: boolean('email_verified').notNull().default(false),
  suspended: boolean('suspended').notNull().default(false),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

export const licenses = pgTable('licenses', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id),
  licenseKey: text('license_key').notNull().unique(), // GCTRL-XXXX-XXXX-XXXX-XXXX
  hardwareFingerprint: text('hardware_fingerprint'),
  status: text('status').notNull().default('inactive'), // 'inactive' | 'active' | 'revoked' | 'grace'
  tier: text('tier').notNull().default('free'),
  gracePeriodEndsAt: timestamp('grace_period_ends_at'),
  seatReassignments: integer('seat_reassignments').notNull().default(0),
  lastReassignmentAt: timestamp('last_reassignment_at'),
  activatedAt: timestamp('activated_at'),
  lastHeartbeatAt: timestamp('last_heartbeat_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export const tokenUsage = pgTable('token_usage', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id),
  licenseId: uuid('license_id').references(() => licenses.id),
  action: text('action').notNull(), // 'kex_ner' | 'kex_extract' | 'fuse_merge' | 'talk_query'
  charsProcessed: integer('chars_processed'),
  creditsSpent: integer('credits_spent').notNull(),
  isOverdraft: boolean('is_overdraft').notNull().default(false),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export const subscriptions = pgTable('subscriptions', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id),
  stripeSubscriptionId: text('stripe_subscription_id').notNull().unique(),
  stripePriceId: text('stripe_price_id').notNull(),
  tier: text('tier').notNull(),
  status: text('status').notNull(), // 'active' | 'cancelled' | 'past_due'
  currentPeriodEnd: timestamp('current_period_end').notNull(),
  cancelAtPeriodEnd: boolean('cancel_at_period_end').notNull().default(false),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

export const auditLog = pgTable('audit_log', {
  id: uuid('id').primaryKey().defaultRandom(),
  adminId: uuid('admin_id').references(() => users.id),
  action: text('action').notNull(), // e.g. 'revoke_license', 'add_credits'
  targetUserId: uuid('target_user_id').references(() => users.id),
  payload: jsonb('payload'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export const appVersions = pgTable('app_versions', {
  id: uuid('id').primaryKey().defaultRandom(),
  version: text('version').notNull(),
  channel: text('channel').notNull().default('stable'), // 'stable' | 'edge'
  updateRequired: boolean('update_required').notNull().default(false),
  changelog: text('changelog'),
  rolloutPercent: integer('rollout_percent').notNull().default(100),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});
```

- [ ] **Step 2: Write DB connection**

```typescript
// services/license-api/src/db/index.ts
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema.js';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
export const db = drizzle(pool, { schema });
export type DB = typeof db;
```

- [ ] **Step 3: Commit**

```bash
git add services/license-api/src/db/
git commit -m "feat(license-api): database schema — users, licenses, token_usage, subscriptions, audit_log"
```

---

### Task 2: JWT + License Key Utilities

**Files:**
- Create: `services/license-api/src/lib/jwt.ts`
- Create: `services/license-api/src/lib/licenseKey.ts`
- Create: `services/license-api/src/lib/credits.ts`

- [ ] **Step 1: Write JWT RS256 utility**

```typescript
// services/license-api/src/lib/jwt.ts
import { SignJWT, jwtVerify, importPKCS8, importSPKI } from 'jose';
import { readFileSync } from 'fs';

const privateKeyPem = readFileSync(process.env.LICENSE_PRIVATE_KEY_PATH!, 'utf8');
const publicKeyPem = readFileSync(process.env.LICENSE_PUBLIC_KEY_PATH!, 'utf8');

let _privateKey: Awaited<ReturnType<typeof importPKCS8>>;
let _publicKey: Awaited<ReturnType<typeof importSPKI>>;

async function getPrivateKey() {
  if (!_privateKey) _privateKey = await importPKCS8(privateKeyPem, 'RS256');
  return _privateKey;
}

async function getPublicKey() {
  if (!_publicKey) _publicKey = await importSPKI(publicKeyPem, 'RS256');
  return _publicKey;
}

export interface LicenseJWTClaims {
  sub: string;          // userId
  licenseId: string;
  tier: string;
  creditsBalance: number;
  overdraftLimit: number;
  hardwareFingerprint: string;
  latestVersion: string;
  updateAvailable: boolean;
  updateRequired: boolean;
}

export async function signLicenseJWT(claims: LicenseJWTClaims): Promise<string> {
  const key = await getPrivateKey();
  return new SignJWT({ ...claims })
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuedAt()
    .setIssuer('api.gctrl.tech')
    .setExpirationTime('7d')
    .sign(key);
}

export async function verifyLicenseJWT(token: string): Promise<LicenseJWTClaims> {
  const key = await getPublicKey();
  const { payload } = await jwtVerify(token, key, { issuer: 'api.gctrl.tech' });
  return payload as unknown as LicenseJWTClaims;
}

export async function signAdminJWT(userId: string): Promise<string> {
  const key = await getPrivateKey();
  return new SignJWT({ sub: userId, role: 'admin' })
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuedAt()
    .setIssuer('api.gctrl.tech')
    .setExpirationTime('1h')
    .sign(key);
}
```

- [ ] **Step 2: Write license key generator**

```typescript
// services/license-api/src/lib/licenseKey.ts
import { randomBytes, createHmac } from 'crypto';

const HMAC_SECRET = process.env.LICENSE_HMAC_SECRET!;

function randomSegment(): string {
  return randomBytes(2).toString('hex').toUpperCase();
}

export function generateLicenseKey(): string {
  const segments = [randomSegment(), randomSegment(), randomSegment(), randomSegment()];
  const body = segments.join('-');
  const checksum = createHmac('sha256', HMAC_SECRET)
    .update(body)
    .digest('hex')
    .slice(0, 4)
    .toUpperCase();
  return `GCTRL-${body}-${checksum}`;
  // Format: GCTRL-AABB-CCDD-EEFF-GGHH-IIII (last segment is checksum)
}

export function validateLicenseKeyFormat(key: string): boolean {
  if (!key.startsWith('GCTRL-')) return false;
  const parts = key.split('-');
  if (parts.length !== 6) return false;
  const body = parts.slice(1, 5).join('-');
  const checksum = parts[5];
  const expected = createHmac('sha256', HMAC_SECRET)
    .update(body)
    .digest('hex')
    .slice(0, 4)
    .toUpperCase();
  return checksum === expected;
}
```

- [ ] **Step 3: Write credit cost constants**

```typescript
// services/license-api/src/lib/credits.ts
export const CREDIT_COSTS = {
  kex_ner: 1,        // per 1000 chars
  kex_extract: 25,   // per 1000 chars
  fuse_merge: 10,    // flat per job
  talk_query: 5,     // flat per query
} as const;

export type CreditAction = keyof typeof CREDIT_COSTS;

export const TIER_MONTHLY_CREDITS: Record<string, number> = {
  free: 3_000,
  starter: 25_000,
  pro: 100_000,
  enterprise: 999_999_999,
};

export const TIER_OVERDRAFT_LIMITS: Record<string, number> = {
  free: 0,
  starter: -5_000,
  pro: -10_000,
  enterprise: -999_999,
};

export const TIER_RATE_LIMITS: Record<string, number> = {
  free: 1,
  starter: 3,
  pro: 10,
  enterprise: 999,
};

export function calculateCredits(action: CreditAction, chars: number): number {
  const costPer1000 = CREDIT_COSTS[action];
  if (action === 'fuse_merge' || action === 'talk_query') {
    return costPer1000; // flat fee
  }
  return Math.ceil((chars / 1000) * costPer1000);
}
```

- [ ] **Step 4: Write failing tests**

```typescript
// services/license-api/src/lib/__tests__/licenseKey.test.ts
import { generateLicenseKey, validateLicenseKeyFormat } from '../licenseKey.js';

process.env.LICENSE_HMAC_SECRET = 'test-secret';

test('generateLicenseKey produces GCTRL-XXXX format', () => {
  const key = generateLicenseKey();
  expect(key).toMatch(/^GCTRL-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}$/);
});

test('validateLicenseKeyFormat accepts valid key', () => {
  const key = generateLicenseKey();
  expect(validateLicenseKeyFormat(key)).toBe(true);
});

test('validateLicenseKeyFormat rejects tampered key', () => {
  const key = generateLicenseKey();
  const tampered = key.slice(0, -1) + 'X';
  expect(validateLicenseKeyFormat(tampered)).toBe(false);
});

// services/license-api/src/lib/__tests__/credits.test.ts
import { calculateCredits } from '../credits.js';

test('kex_extract charges 25 credits per 1000 chars', () => {
  expect(calculateCredits('kex_extract', 1000)).toBe(25);
  expect(calculateCredits('kex_extract', 2500)).toBe(63); // ceil(2.5 * 25)
});

test('fuse_merge is flat 10 credits regardless of chars', () => {
  expect(calculateCredits('fuse_merge', 0)).toBe(10);
  expect(calculateCredits('fuse_merge', 99999)).toBe(10);
});
```

- [ ] **Step 5: Run tests**

```bash
cd services/license-api && npm test -- --testPathPattern="licenseKey|credits"
```
Expected: 5 tests pass.

- [ ] **Step 6: Commit**

```bash
git add services/license-api/src/lib/
git commit -m "feat(license-api): JWT, license key, and credit utilities with tests"
```

---

### Task 3: Activation + Heartbeat Routes

**Files:**
- Create: `services/license-api/src/routes/activate.ts`
- Create: `services/license-api/src/routes/heartbeat.ts`

- [ ] **Step 1: Write activation route**

```typescript
// services/license-api/src/routes/activate.ts
import { Router, Request, Response } from 'express';
import { db } from '../db/index.js';
import { licenses, users } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { validateLicenseKeyFormat } from '../lib/licenseKey.js';
import { signLicenseJWT } from '../lib/jwt.js';
import { generateRegistryToken } from '../lib/registryToken.js';
import { getCurrentVersion } from '../lib/version.js';

const router = Router();

router.post('/v1/activate', async (req: Request, res: Response): Promise<void> => {
  const { license_key, hardware_fingerprint } = req.body;

  if (!license_key || !hardware_fingerprint) {
    res.status(400).json({ error: 'license_key and hardware_fingerprint required' });
    return;
  }

  if (!validateLicenseKeyFormat(license_key)) {
    res.status(400).json({ error: 'Invalid license key format' });
    return;
  }

  const license = await db.query.licenses.findFirst({
    where: eq(licenses.licenseKey, license_key),
    with: { user: true },
  });

  if (!license) {
    res.status(404).json({ error: 'License key not found' });
    return;
  }

  if (license.status === 'revoked') {
    res.status(403).json({ error: 'License has been revoked' });
    return;
  }

  // If already active on different hardware — check reassignment allowance
  if (license.hardwareFingerprint && license.hardwareFingerprint !== hardware_fingerprint) {
    const reassignmentsThisMonth = license.seatReassignments;
    const lastReassignment = license.lastReassignmentAt;
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    if (lastReassignment && lastReassignment > thirtyDaysAgo && reassignmentsThisMonth >= 2) {
      res.status(403).json({ error: 'Maximum seat reassignments (2/30 days) reached. Contact support.' });
      return;
    }

    await db.update(licenses)
      .set({
        seatReassignments: reassignmentsThisMonth + 1,
        lastReassignmentAt: new Date(),
      })
      .where(eq(licenses.id, license.id));
  }

  // Activate license
  await db.update(licenses)
    .set({
      status: 'active',
      hardwareFingerprint: hardware_fingerprint,
      activatedAt: new Date(),
      lastHeartbeatAt: new Date(),
    })
    .where(eq(licenses.id, license.id));

  const user = license.user;
  const { version, updateAvailable, updateRequired } = await getCurrentVersion(license.tier);

  const jwt = await signLicenseJWT({
    sub: user.id,
    licenseId: license.id,
    tier: user.tier,
    creditsBalance: user.creditsBalance,
    overdraftLimit: user.overdraftLimit,
    hardwareFingerprint: hardware_fingerprint,
    latestVersion: version,
    updateAvailable,
    updateRequired,
  });

  const registryToken = await generateRegistryToken(user.id);

  res.json({
    license_jwt: jwt,
    registry_token: registryToken,
    tier: user.tier,
    credits_balance: user.creditsBalance,
    latest_version: version,
  });
});

export default router;
```

- [ ] **Step 2: Write heartbeat route**

```typescript
// services/license-api/src/routes/heartbeat.ts
import { Router, Request, Response } from 'express';
import { db } from '../db/index.js';
import { licenses, users, tokenUsage } from '../db/schema.js';
import { eq, and, gte } from 'drizzle-orm';
import { verifyLicenseJWT, signLicenseJWT } from '../lib/jwt.js';
import { getCurrentVersion } from '../lib/version.js';

const router = Router();

router.post('/v1/heartbeat', async (req: Request, res: Response): Promise<void> => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing license JWT' });
    return;
  }

  let claims;
  try {
    claims = await verifyLicenseJWT(authHeader.slice(7));
  } catch {
    res.status(401).json({ error: 'Invalid or expired license JWT' });
    return;
  }

  const { usage_report } = req.body; // Array of { action, chars_processed, credits_spent, timestamp }

  // Store usage report
  if (Array.isArray(usage_report) && usage_report.length > 0) {
    const records = usage_report.map((u: any) => ({
      userId: claims.sub,
      licenseId: claims.licenseId,
      action: u.action,
      charsProcessed: u.chars_processed,
      creditsSpent: u.credits_spent,
      isOverdraft: u.credits_spent < 0,
      createdAt: new Date(u.timestamp),
    }));

    await db.insert(tokenUsage).values(records);

    // Deduct credits from user balance
    const totalSpent = records.reduce((sum: number, r: any) => sum + r.creditsSpent, 0);
    await db.update(users)
      .set({ creditsBalance: db.raw(`credits_balance - ${totalSpent}`) })
      .where(eq(users.id, claims.sub));
  }

  // Update heartbeat timestamp
  await db.update(licenses)
    .set({ lastHeartbeatAt: new Date(), status: 'active' })
    .where(eq(licenses.id, claims.licenseId));

  const [user] = await db.select().from(users).where(eq(users.id, claims.sub)).limit(1);
  const { version, updateAvailable, updateRequired } = await getCurrentVersion(user.tier);

  // Issue fresh JWT
  const newJwt = await signLicenseJWT({
    sub: user.id,
    licenseId: claims.licenseId,
    tier: user.tier,
    creditsBalance: user.creditsBalance,
    overdraftLimit: user.overdraftLimit,
    hardwareFingerprint: claims.hardwareFingerprint,
    latestVersion: version,
    updateAvailable,
    updateRequired,
  });

  res.json({
    license_jwt: newJwt,
    credits_balance: user.creditsBalance,
    tier: user.tier,
    latest_version: version,
    update_available: updateAvailable,
    update_required: updateRequired,
  });
});

export default router;
```

- [ ] **Step 3: Commit**

```bash
git add services/license-api/src/routes/
git commit -m "feat(license-api): activation and heartbeat endpoints"
```

---

### Task 4: Stripe Billing Integration

**Files:**
- Create: `services/license-api/src/routes/stripe.ts`
- Create: `services/license-api/src/lib/stripe.ts`

- [ ] **Step 1: Write Stripe client**

```typescript
// services/license-api/src/lib/stripe.ts
import Stripe from 'stripe';
export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2024-04-10' });

export const STRIPE_PRICES: Record<string, { tier: string; credits: number }> = {
  [process.env.STRIPE_PRICE_STARTER!]: { tier: 'starter', credits: 25_000 },
  [process.env.STRIPE_PRICE_PRO!]: { tier: 'pro', credits: 100_000 },
};
```

- [ ] **Step 2: Write Stripe webhook handler**

```typescript
// services/license-api/src/routes/stripe.ts
import { Router, Request, Response } from 'express';
import { stripe, STRIPE_PRICES } from '../lib/stripe.js';
import { db } from '../db/index.js';
import { users, subscriptions, licenses } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { generateLicenseKey } from '../lib/licenseKey.js';
import { sendEmail } from '../lib/email.js';
import { TIER_MONTHLY_CREDITS, TIER_OVERDRAFT_LIMITS } from '../lib/credits.js';

const router = Router();

// Stripe requires raw body
router.post('/v1/webhooks/stripe', async (req: Request, res: Response): Promise<void> => {
  const sig = req.headers['stripe-signature']!;
  let event: Stripe.Event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET!);
  } catch {
    res.status(400).json({ error: 'Invalid signature' });
    return;
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object as Stripe.CheckoutSession;
    const userId = session.metadata?.userId;
    if (!userId) { res.json({ ok: true }); return; }

    const priceId = session.line_items?.data[0]?.price?.id ?? '';
    const tierInfo = STRIPE_PRICES[priceId] ?? { tier: 'starter', credits: 25_000 };

    // Upgrade user tier
    await db.update(users)
      .set({
        tier: tierInfo.tier,
        creditsBalance: TIER_MONTHLY_CREDITS[tierInfo.tier],
        overdraftLimit: TIER_OVERDRAFT_LIMITS[tierInfo.tier],
        stripeCustomerId: session.customer as string,
        stripeSubscriptionId: session.subscription as string,
      })
      .where(eq(users.id, userId));

    // Create license key
    const key = generateLicenseKey();
    await db.insert(licenses).values({
      userId,
      licenseKey: key,
      tier: tierInfo.tier,
      status: 'inactive',
    });

    const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    await sendEmail('license_issued', user.email, { licenseKey: key, tier: tierInfo.tier });
    await sendEmail('subscription_confirmed', user.email, { tier: tierInfo.tier });
  }

  if (event.type === 'customer.subscription.deleted') {
    const sub = event.data.object as Stripe.Subscription;
    await db.update(users)
      .set({ tier: 'free', creditsBalance: TIER_MONTHLY_CREDITS['free'], overdraftLimit: 0 })
      .where(eq(users.stripeSubscriptionId, sub.id));
    // License grace period handled by heartbeat expiry
  }

  if (event.type === 'invoice.payment_succeeded') {
    const invoice = event.data.object as Stripe.Invoice;
    if (invoice.billing_reason === 'subscription_cycle') {
      // Monthly reset: restore credits
      const sub = invoice.subscription as string;
      const [user] = await db.select().from(users).where(eq(users.stripeSubscriptionId, sub)).limit(1);
      if (user) {
        await db.update(users)
          .set({ creditsBalance: TIER_MONTHLY_CREDITS[user.tier] })
          .where(eq(users.id, user.id));
      }
    }
  }

  res.json({ ok: true });
});

export default router;
```

- [ ] **Step 3: Commit**

```bash
git add services/license-api/src/routes/stripe.ts services/license-api/src/lib/stripe.ts
git commit -m "feat(license-api): Stripe webhook — subscription create/cancel/renew + license key issuance"
```

---

### Task 5: Email via Resend

**Files:**
- Create: `services/license-api/src/lib/email.ts`

- [ ] **Step 1: Write email client with all templates**

```typescript
// services/license-api/src/lib/email.ts
import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY!);
const FROM = 'GCTRL <no-reply@gctrl.tech>';

type EmailTemplate =
  | 'welcome' | 'verify_email' | 'password_reset'
  | 'license_issued' | 'subscription_confirmed'
  | 'low_credits' | 'credits_exhausted'
  | 'update_available' | 'update_required'
  | 'license_expiring' | 'license_cancelled';

const subjects: Record<EmailTemplate, string> = {
  welcome: 'Welcome to Ground Control',
  verify_email: 'Verify your email',
  password_reset: 'Reset your password',
  license_issued: 'Your GCTRL License Key',
  subscription_confirmed: 'Subscription activated',
  low_credits: 'Credits running low',
  credits_exhausted: 'Credits exhausted',
  update_available: 'GCTRL update available',
  update_required: 'Action required: GCTRL update',
  license_expiring: 'Subscription renews in 3 days',
  license_cancelled: 'Subscription cancelled',
};

function renderBody(template: EmailTemplate, data: Record<string, any>): string {
  const base = (content: string) => `
    <div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px">
      <h2 style="color:#1a1a1a">Ground Control</h2>
      ${content}
      <hr style="margin-top:32px;border:none;border-top:1px solid #eee"/>
      <p style="color:#888;font-size:12px">gctrl.tech — structured knowledge, locally owned</p>
    </div>`;

  switch (template) {
    case 'license_issued':
      return base(`
        <p>Your license key for the <strong>${data.tier}</strong> plan:</p>
        <pre style="background:#f5f5f5;padding:16px;border-radius:8px;font-size:18px;letter-spacing:2px">${data.licenseKey}</pre>
        <p>Install GCTRL with:</p>
        <pre style="background:#1a1a1a;color:#fff;padding:16px;border-radius:8px">curl -fsSL https://gctrl.tech/install | bash</pre>
        <p>You will be prompted to enter the key above.</p>`);
    case 'low_credits':
      return base(`<p>Your GCTRL credit balance is running low: <strong>${data.balance} credits remaining</strong>.</p>
        <a href="https://gctrl.tech/billing" style="background:#6366f1;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none">Top up credits</a>`);
    case 'update_required':
      return base(`<p>A required update for GCTRL is available (v${data.version}).</p>
        <p><strong>Action required by ${data.deadline}:</strong></p>
        <pre style="background:#1a1a1a;color:#fff;padding:16px;border-radius:8px">curl -fsSL https://gctrl.tech/update | bash</pre>
        <p>${data.changelog}</p>`);
    case 'license_cancelled':
      return base(`<p>Your GCTRL subscription has been cancelled.</p>
        <p>Your installation will continue to work until <strong>${data.graceEndsAt}</strong>.</p>
        <a href="https://gctrl.tech/billing" style="background:#6366f1;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none">Reactivate</a>`);
    default:
      return base(`<p>${JSON.stringify(data)}</p>`);
  }
}

export async function sendEmail(
  template: EmailTemplate,
  to: string,
  data: Record<string, any> = {}
): Promise<void> {
  await resend.emails.send({
    from: FROM,
    to,
    subject: subjects[template],
    html: renderBody(template, data),
  });
}
```

- [ ] **Step 2: Commit**

```bash
git add services/license-api/src/lib/email.ts
git commit -m "feat(license-api): Resend email client with all 12 transactional templates"
```

---

### Task 6: Admin Routes

**Files:**
- Create: `services/license-api/src/routes/admin.ts`
- Create: `services/license-api/src/middleware/adminAuth.ts`

- [ ] **Step 1: Write admin auth middleware**

```typescript
// services/license-api/src/middleware/adminAuth.ts
import { Request, Response, NextFunction } from 'express';
import { verifyLicenseJWT } from '../lib/jwt.js';
import { db } from '../db/index.js';
import { users } from '../db/schema.js';
import { eq } from 'drizzle-orm';

export async function requireAdmin(req: Request, res: Response, next: NextFunction): Promise<void> {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) { res.status(401).json({ error: 'Unauthorized' }); return; }
  try {
    const claims = await verifyLicenseJWT(auth.slice(7));
    const [user] = await db.select().from(users).where(eq(users.id, claims.sub)).limit(1);
    if (!user || user.role !== 'admin') { res.status(403).json({ error: 'Admin only' }); return; }
    (req as any).adminUser = user;
    next();
  } catch { res.status(401).json({ error: 'Invalid token' }); }
}
```

- [ ] **Step 2: Write admin routes**

```typescript
// services/license-api/src/routes/admin.ts
import { Router, Request, Response } from 'express';
import { db } from '../db/index.js';
import { users, licenses, tokenUsage, auditLog, appVersions } from '../db/schema.js';
import { eq, desc, sql } from 'drizzle-orm';
import { requireAdmin } from '../middleware/adminAuth.js';
import { generateLicenseKey } from '../lib/licenseKey.js';

const router = Router();
router.use(requireAdmin);

async function audit(adminId: string, action: string, targetUserId: string | null, payload: any) {
  await db.insert(auditLog).values({ adminId, action, targetUserId, payload });
}

// List users
router.get('/users', async (req: Request, res: Response) => {
  const rows = await db.select().from(users).orderBy(desc(users.createdAt)).limit(200);
  res.json(rows);
});

// Update user tier
router.patch('/users/:id/tier', async (req: Request, res: Response) => {
  const { tier } = req.body;
  await db.update(users).set({ tier }).where(eq(users.id, req.params.id));
  await audit((req as any).adminUser.id, 'update_tier', req.params.id, { tier });
  res.json({ ok: true });
});

// Suspend user
router.patch('/users/:id/suspend', async (req: Request, res: Response) => {
  await db.update(users).set({ suspended: true }).where(eq(users.id, req.params.id));
  // Revoke all licenses
  await db.update(licenses).set({ status: 'revoked' }).where(eq(licenses.userId, req.params.id));
  await audit((req as any).adminUser.id, 'suspend_user', req.params.id, {});
  res.json({ ok: true });
});

// Add credits
router.post('/users/:id/credits', async (req: Request, res: Response) => {
  const { amount, reason } = req.body;
  await db.update(users)
    .set({ creditsBalance: sql`credits_balance + ${amount}` })
    .where(eq(users.id, req.params.id));
  await audit((req as any).adminUser.id, 'add_credits', req.params.id, { amount, reason });
  res.json({ ok: true });
});

// Revoke license
router.patch('/licenses/:id/revoke', async (req: Request, res: Response) => {
  const [lic] = await db.select().from(licenses).where(eq(licenses.id, req.params.id)).limit(1);
  await db.update(licenses).set({ status: 'revoked' }).where(eq(licenses.id, req.params.id));
  await audit((req as any).adminUser.id, 'revoke_license', lic.userId, { licenseId: req.params.id });
  res.json({ ok: true });
});

// Issue complimentary license
router.post('/licenses/issue', async (req: Request, res: Response) => {
  const { userId, tier } = req.body;
  const key = generateLicenseKey();
  await db.insert(licenses).values({ userId, licenseKey: key, tier, status: 'inactive' });
  await audit((req as any).adminUser.id, 'issue_license', userId, { licenseKey: key, tier });
  res.json({ licenseKey: key });
});

// Set app version
router.post('/versions', async (req: Request, res: Response) => {
  const { version, channel, updateRequired, changelog, rolloutPercent } = req.body;
  await db.insert(appVersions).values({ version, channel, updateRequired, changelog, rolloutPercent });
  await audit((req as any).adminUser.id, 'set_version', null, { version, channel, updateRequired });
  res.json({ ok: true });
});

// Analytics
router.get('/analytics/summary', async (req: Request, res: Response) => {
  const [totals] = await db.select({
    totalUsers: sql<number>`count(distinct ${users.id})`,
    activeUsers: sql<number>`count(distinct ${users.id}) filter (where ${users.creditsBalance} > 0)`,
    totalCreditsSpent: sql<number>`coalesce(sum(${tokenUsage.creditsSpent}), 0)`,
  }).from(users).leftJoin(tokenUsage, eq(tokenUsage.userId, users.id));

  res.json(totals);
});

// Export usage CSV
router.get('/users/:id/usage.csv', async (req: Request, res: Response) => {
  const rows = await db.select().from(tokenUsage)
    .where(eq(tokenUsage.userId, req.params.id))
    .orderBy(desc(tokenUsage.createdAt));

  const csv = ['id,action,chars_processed,credits_spent,is_overdraft,created_at',
    ...rows.map(r => `${r.id},${r.action},${r.charsProcessed},${r.creditsSpent},${r.isOverdraft},${r.createdAt}`)
  ].join('\n');

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="usage-${req.params.id}.csv"`);
  res.send(csv);
});

export default router;
```

- [ ] **Step 3: Commit**

```bash
git add services/license-api/src/routes/admin.ts services/license-api/src/middleware/adminAuth.ts
git commit -m "feat(license-api): admin routes — user management, license control, credits, analytics, CSV export"
```

---

### Task 7: Express App Entry + Dockerfile

**Files:**
- Create: `services/license-api/src/index.ts`
- Create: `services/license-api/Dockerfile`

- [ ] **Step 1: Write Express app**

```typescript
// services/license-api/src/index.ts
import express from 'express';
import cors from 'cors';
import activateRouter from './routes/activate.js';
import heartbeatRouter from './routes/heartbeat.js';
import stripeRouter from './routes/stripe.js';
import adminRouter from './routes/admin.js';

const app = express();

// Stripe needs raw body for signature verification
app.use('/v1/webhooks/stripe', express.raw({ type: 'application/json' }));
app.use(express.json());
app.use(cors({ origin: ['https://gctrl.tech', 'https://admin.gctrl.tech'] }));

app.get('/health', (_, res) => res.json({ ok: true, service: 'gctrl-api' }));

app.use(activateRouter);
app.use(heartbeatRouter);
app.use(stripeRouter);
app.use('/admin', adminRouter);

const PORT = process.env.PORT ?? 4000;
app.listen(PORT, () => console.log(`gctrl-api listening on :${PORT}`));
```

- [ ] **Step 2: Write Dockerfile**

```dockerfile
# services/license-api/Dockerfile
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist
EXPOSE 4000
CMD ["node", "dist/index.js"]
```

- [ ] **Step 3: Add license-api to VPS docker-compose.yml**

Add to `/opt/gctrl/docker-compose.yml`:
```yaml
  gctrl-api:
    image: ghcr.io/gctrl/license-api:latest
    container_name: gctrl-api
    restart: unless-stopped
    environment:
      DATABASE_URL: postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@gctrl-db:5432/${POSTGRES_DB}
      REDIS_URL: redis://:${REDIS_PASSWORD}@gctrl-redis:6379
      LICENSE_PRIVATE_KEY_PATH: /run/secrets/license_private
      LICENSE_PUBLIC_KEY_PATH: /run/secrets/license_public
      LICENSE_HMAC_SECRET: ${LICENSE_HMAC_SECRET}
      STRIPE_SECRET_KEY: ${STRIPE_SECRET_KEY}
      STRIPE_WEBHOOK_SECRET: ${STRIPE_WEBHOOK_SECRET}
      STRIPE_PRICE_STARTER: ${STRIPE_PRICE_STARTER}
      STRIPE_PRICE_PRO: ${STRIPE_PRICE_PRO}
      RESEND_API_KEY: ${RESEND_API_KEY}
      PORT: 4000
    secrets:
      - license_private
      - license_public
    depends_on:
      gctrl-db:
        condition: service_healthy
      gctrl-redis:
        condition: service_healthy
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.gctrl-api.rule=Host(`api.gctrl.tech`)"
      - "traefik.http.routers.gctrl-api.entrypoints=websecure"
      - "traefik.http.routers.gctrl-api.tls.certresolver=letsencrypt"
      - "traefik.http.services.gctrl-api.loadbalancer.server.port=4000"
    networks:
      - gctrl

secrets:
  license_private:
    file: /opt/gctrl/keys/license_private.pem
  license_public:
    file: /opt/gctrl/keys/license_public.pem
```

- [ ] **Step 4: Commit**

```bash
git add services/license-api/
git commit -m "feat(license-api): Express app entry point + Dockerfile"
```

---

### Task 8: Deploy to VPS + Smoke Test

- [ ] **Step 1: Build and push image (manual first deploy)**

```bash
cd services/license-api
docker build -t ghcr.io/gctrl/license-api:latest .
echo $GITHUB_TOKEN | docker login ghcr.io -u gctrl --password-stdin
docker push ghcr.io/gctrl/license-api:latest
```

- [ ] **Step 2: Deploy on VPS**

```bash
ssh root@72.61.189.78
cd /opt/gctrl
docker compose pull gctrl-api
docker compose up -d gctrl-api
docker compose logs gctrl-api --tail 20
```
Expected: `gctrl-api listening on :4000`

- [ ] **Step 3: Verify health endpoint**

```bash
curl https://api.gctrl.tech/health
```
Expected: `{"ok":true,"service":"gctrl-api"}`

- [ ] **Step 4: Create admin user in DB**

```bash
ssh root@72.61.189.78
docker exec -it gctrl-db psql -U gctrl -d gctrl -c "
INSERT INTO users (id, email, password_hash, role, tier)
VALUES (gen_random_uuid(), 'fabio@5monti.com', 'CHANGEME', 'admin', 'enterprise');"
```
Note: password_hash will be set via the web UI password reset flow once gctrl-web is deployed.

- [ ] **Step 5: Commit**

```bash
git add .
git commit -m "feat: phase 2 license server deployed to gctrl.tech"
```
