import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { SignJWT } from 'jose';
import { db } from '../db/index.js';
import { users, licenses, tokenUsage } from '../db/schema.js';
import { eq, and, desc, gt } from 'drizzle-orm';
import { generateLicenseKey } from '../lib/licenseKey.js';
import { requireSession } from '../middleware/sessionAuth.js';
import { TIER_MONTHLY_CREDITS } from '../lib/credits.js';

const router = Router();

function getSecret() {
  return new TextEncoder().encode(process.env.JWT_SECRET!);
}

async function signSessionJWT(userId: string, email: string, role: string, tier: string): Promise<string> {
  return new SignJWT({ email, role, tier })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime('24h')
    .sign(getSecret());
}

// POST /v1/auth/register
router.post('/v1/auth/register', async (req: Request, res: Response): Promise<void> => {
  const { email, password } = req.body as { email?: string; password?: string };

  if (!email || !password) {
    res.status(400).json({ error: 'email and password required' });
    return;
  }
  if (typeof password !== 'string' || password.length < 8) {
    res.status(400).json({ error: 'Password must be at least 8 characters' });
    return;
  }

  const existing = await db.select({ id: users.id }).from(users)
    .where(eq(users.email, email.toLowerCase())).limit(1);
  if (existing.length > 0) {
    res.status(409).json({ error: 'Email already registered' });
    return;
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const [user] = await db.insert(users).values({
    email: email.toLowerCase(),
    name: email.split('@')[0]!,
    passwordHash,
    role: 'viewer',
    tier: 'free',
    creditsBalance: TIER_MONTHLY_CREDITS.free,
  }).returning();

  // Auto-issue one free license on registration
  const licenseKey = generateLicenseKey();
  const [license] = await db.insert(licenses).values({
    userId: user.id,
    licenseKey,
    status: 'inactive',
    tier: 'free',
  }).returning();

  const token = await signSessionJWT(user.id, user.email, user.role, user.tier);

  res.status(201).json({
    token,
    user: {
      id: user.id,
      email: user.email,
      role: user.role,
      tier: user.tier,
      creditsBalance: user.creditsBalance,
    },
    license: {
      id: license.id,
      key: license.licenseKey,
      tier: license.tier,
      status: license.status,
    },
  });
});

// POST /v1/auth/login
router.post('/v1/auth/login', async (req: Request, res: Response): Promise<void> => {
  const { email, password } = req.body as { email?: string; password?: string };

  if (!email || !password) {
    res.status(400).json({ error: 'email and password required' });
    return;
  }

  const [user] = await db.select().from(users)
    .where(eq(users.email, email.toLowerCase())).limit(1);

  if (!user) {
    res.status(401).json({ error: 'Invalid credentials' });
    return;
  }
  if (user.suspended) {
    res.status(403).json({ error: 'Account suspended. Contact support.' });
    return;
  }

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) {
    res.status(401).json({ error: 'Invalid credentials' });
    return;
  }

  const token = await signSessionJWT(user.id, user.email, user.role, user.tier);

  res.json({
    token,
    user: {
      id: user.id,
      email: user.email,
      role: user.role,
      tier: user.tier,
      creditsBalance: user.creditsBalance,
    },
  });
});

// GET /v1/me — current user profile + all licenses
router.get('/v1/me', requireSession, async (req: Request, res: Response): Promise<void> => {
  const userId = req.sessionUser!.id;

  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return;
  }

  const userLicenses = await db.select().from(licenses)
    .where(eq(licenses.userId, userId))
    .orderBy(desc(licenses.createdAt));

  res.json({
    user: {
      id: user.id,
      email: user.email,
      role: user.role,
      tier: user.tier,
      creditsBalance: user.creditsBalance,
      emailVerified: user.emailVerified,
    },
    licenses: userLicenses.map((l) => ({
      id: l.id,
      key: l.licenseKey,
      status: l.status,
      tier: l.tier,
      lastHeartbeatAt: l.lastHeartbeatAt,
      activatedAt: l.activatedAt,
      createdAt: l.createdAt,
    })),
  });
});

// GET /v1/licenses — all licenses for current user
router.get('/v1/licenses', requireSession, async (req: Request, res: Response): Promise<void> => {
  const userId = req.sessionUser!.id;

  const userLicenses = await db.select().from(licenses)
    .where(eq(licenses.userId, userId))
    .orderBy(desc(licenses.createdAt));

  res.json(userLicenses.map((l) => ({
    id: l.id,
    key: l.licenseKey,
    status: l.status,
    tier: l.tier,
    lastHeartbeatAt: l.lastHeartbeatAt,
    activatedAt: l.activatedAt,
    createdAt: l.createdAt,
  })));
});

// GET /v1/licenses/:id/usage — daily credit usage for last 30 days
router.get('/v1/licenses/:id/usage', requireSession, async (req: Request, res: Response): Promise<void> => {
  const userId = req.sessionUser!.id;
  const licenseId = req.params['id']!;

  const [license] = await db.select({ id: licenses.id })
    .from(licenses)
    .where(and(eq(licenses.id, licenseId), eq(licenses.userId, userId)))
    .limit(1);

  if (!license) {
    res.status(404).json({ error: 'License not found' });
    return;
  }

  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const rows = await db.select().from(tokenUsage)
    .where(and(
      eq(tokenUsage.licenseId, licenseId),
      gt(tokenUsage.createdAt, thirtyDaysAgo),
    ))
    .orderBy(desc(tokenUsage.createdAt));

  // Aggregate by day in Node — avoids raw SQL for portability
  const byDay = new Map<string, { day: string; totalCredits: number; totalChars: number; operations: number }>();
  for (const row of rows) {
    const day = row.createdAt.toISOString().slice(0, 10);
    const existing = byDay.get(day) ?? { day, totalCredits: 0, totalChars: 0, operations: 0 };
    existing.totalCredits += row.creditsSpent;
    existing.totalChars += row.charsProcessed ?? 0;
    existing.operations += 1;
    byDay.set(day, existing);
  }

  const days = Array.from(byDay.values()).sort((a, b) => a.day.localeCompare(b.day));

  res.json({ licenseId, days });
});

// POST /v1/licenses/:id/transfer-seat — self-service machine transfer
// Resets the seat reassignment counter so the user can activate on a new machine.
// Cooldown: once per 30 days, enforced by lastReassignmentAt.
router.post('/v1/licenses/:id/transfer-seat', requireSession, async (req: Request, res: Response): Promise<void> => {
  const userId = req.sessionUser!.id;
  const licenseId = req.params['id']!;

  const [license] = await db.select()
    .from(licenses)
    .where(and(eq(licenses.id, licenseId), eq(licenses.userId, userId)))
    .limit(1);

  if (!license) {
    res.status(404).json({ error: 'License not found' });
    return;
  }

  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  if (license.lastReassignmentAt && license.lastReassignmentAt > thirtyDaysAgo) {
    const nextAllowed = new Date(license.lastReassignmentAt.getTime() + 30 * 24 * 60 * 60 * 1000);
    res.status(429).json({
      error: 'Self-service transfer available once per 30 days.',
      nextAllowedAt: nextAllowed.toISOString(),
    });
    return;
  }

  await db.update(licenses)
    .set({ seatReassignments: 0, lastReassignmentAt: null, hardwareFingerprint: null })
    .where(eq(licenses.id, licenseId));

  res.json({ ok: true, message: 'License unbound from previous machine. Activate again on your new machine.' });
});

// POST /v1/auth/change-password
router.post('/v1/auth/change-password', requireSession, async (req: Request, res: Response): Promise<void> => {
  const { currentPassword, newPassword } = req.body as { currentPassword?: string; newPassword?: string };

  if (!currentPassword || !newPassword) {
    res.status(400).json({ error: 'currentPassword and newPassword required' });
    return;
  }
  if (newPassword.length < 8) {
    res.status(400).json({ error: 'New password must be at least 8 characters' });
    return;
  }

  const [user] = await db.select().from(users).where(eq(users.id, req.sessionUser!.id)).limit(1);
  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return;
  }

  const valid = await bcrypt.compare(currentPassword, user.passwordHash);
  if (!valid) {
    res.status(401).json({ error: 'Current password is incorrect' });
    return;
  }

  const passwordHash = await bcrypt.hash(newPassword, 10);
  await db.update(users).set({ passwordHash }).where(eq(users.id, user.id));

  res.json({ ok: true });
});

// POST /v1/licenses — generate a new free license for the authenticated user
router.post('/v1/licenses', requireSession, async (req: Request, res: Response): Promise<void> => {
  const userId = req.sessionUser!.id;

  const [user] = await db.select({ tier: users.tier })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return;
  }

  const licenseKey = generateLicenseKey();
  const [license] = await db.insert(licenses).values({
    userId,
    licenseKey,
    status: 'inactive',
    tier: user.tier,
  }).returning();

  res.status(201).json({
    id: license.id,
    key: license.licenseKey,
    status: license.status,
    tier: license.tier,
    createdAt: license.createdAt,
  });
});

export default router;
