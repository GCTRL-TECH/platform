import { Router, Request, Response } from 'express';
import { db } from '../db/index.js';
import { users, licenses, tokenUsage, auditLog, appVersions } from '../db/schema.js';
import { eq, desc, sql } from 'drizzle-orm';
import { requireAdmin } from '../middleware/adminAuth.js';
import { generateLicenseKey } from '../lib/licenseKey.js';

const router = Router();
router.use(requireAdmin);

async function audit(adminId: string, action: string, targetUserId: string | null, payload: unknown) {
  await db.insert(auditLog).values({ adminId, action, targetUserId: targetUserId ?? undefined, payload });
}

router.get('/users', async (_req: Request, res: Response) => {
  const rows = await db.select().from(users).orderBy(desc(users.createdAt)).limit(200);
  res.json(rows);
});

router.patch('/users/:id/tier', async (req: Request, res: Response) => {
  const { tier } = req.body as { tier: string };
  await db.update(users).set({ tier }).where(eq(users.id, req.params.id));
  await audit((req as any).adminUser.id, 'update_tier', req.params.id, { tier });
  res.json({ ok: true });
});

router.patch('/users/:id/suspend', async (req: Request, res: Response) => {
  await db.update(users).set({ suspended: true }).where(eq(users.id, req.params.id));
  await db.update(licenses).set({ status: 'revoked' }).where(eq(licenses.userId, req.params.id));
  await audit((req as any).adminUser.id, 'suspend_user', req.params.id, {});
  res.json({ ok: true });
});

router.post('/users/:id/credits', async (req: Request, res: Response) => {
  const { amount, reason } = req.body as { amount: number; reason: string };
  await db.update(users)
    .set({ creditsBalance: sql`credits_balance + ${amount}` })
    .where(eq(users.id, req.params.id));
  await audit((req as any).adminUser.id, 'add_credits', req.params.id, { amount, reason });
  res.json({ ok: true });
});

router.patch('/licenses/:id/revoke', async (req: Request, res: Response) => {
  const [lic] = await db.select().from(licenses).where(eq(licenses.id, req.params.id)).limit(1);
  await db.update(licenses).set({ status: 'revoked' }).where(eq(licenses.id, req.params.id));
  await audit((req as any).adminUser.id, 'revoke_license', lic?.userId ?? null, { licenseId: req.params.id });
  res.json({ ok: true });
});

router.post('/licenses/issue', async (req: Request, res: Response) => {
  const { userId, tier } = req.body as { userId: string; tier: string };
  const key = generateLicenseKey();
  await db.insert(licenses).values({ userId, licenseKey: key, tier, status: 'inactive' });
  await audit((req as any).adminUser.id, 'issue_license', userId, { licenseKey: key, tier });
  res.json({ licenseKey: key });
});

router.post('/versions', async (req: Request, res: Response) => {
  const { version, channel, updateRequired, changelog, rolloutPercent } = req.body as {
    version: string; channel: string; updateRequired: boolean; changelog: string; rolloutPercent: number;
  };
  await db.insert(appVersions).values({ version, channel, updateRequired, changelog, rolloutPercent });
  await audit((req as any).adminUser.id, 'set_version', null, { version, channel, updateRequired });
  res.json({ ok: true });
});

router.get('/analytics/summary', async (_req: Request, res: Response) => {
  const [totals] = await db.select({
    totalUsers: sql<number>`count(distinct ${users.id})`,
    activeUsers: sql<number>`count(distinct ${users.id}) filter (where ${users.creditsBalance} > 0)`,
    totalCreditsSpent: sql<number>`coalesce(sum(${tokenUsage.creditsSpent}), 0)`,
  }).from(users).leftJoin(tokenUsage, eq(tokenUsage.userId, users.id));

  res.json(totals);
});

router.get('/users/:id/usage.csv', async (req: Request, res: Response) => {
  const rows = await db.select().from(tokenUsage)
    .where(eq(tokenUsage.userId, req.params.id))
    .orderBy(desc(tokenUsage.createdAt));

  const csv = [
    'id,action,chars_processed,credits_spent,is_overdraft,created_at',
    ...rows.map(r => `${r.id},${r.action},${r.charsProcessed ?? ''},${r.creditsSpent},${r.isOverdraft},${r.createdAt.toISOString()}`)
  ].join('\n');

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="usage-${req.params.id}.csv"`);
  res.send(csv);
});

export default router;
