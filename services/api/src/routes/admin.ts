import { Router, Request, Response } from 'express';
import { eq, desc, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../models/db.js';
import { users, jobs, tokenUsage, compilations, auditLog, oauthConnectors } from '../models/schema.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';

const router = Router();

// All admin routes require admin role
router.use(requireAuth, requireRole('admin'));

// ─── GET /stats ──────────────────────────────────────────────────────────────

router.get('/stats', async (_req: Request, res: Response): Promise<void> => {
  try {
    const [userCount] = await db.select({ count: sql<number>`count(*)` }).from(users);
    const [jobCount] = await db.select({ count: sql<number>`count(*)` }).from(jobs);
    const [completedJobs] = await db.select({ count: sql<number>`count(*)` }).from(jobs).where(eq(jobs.status, 'completed'));
    const [failedJobs] = await db.select({ count: sql<number>`count(*)` }).from(jobs).where(eq(jobs.status, 'failed'));
    const [compilationCount] = await db.select({ count: sql<number>`count(*)` }).from(compilations);
    const [totalTokensSpent] = await db.select({ total: sql<number>`coalesce(sum(tokens_spent), 0)` }).from(tokenUsage);
    const [connectorCount] = await db.select({ count: sql<number>`count(*)` }).from(oauthConnectors);

    res.json({
      users: userCount?.count ?? 0,
      jobs: {
        total: jobCount?.count ?? 0,
        completed: completedJobs?.count ?? 0,
        failed: failedJobs?.count ?? 0,
      },
      compilations: compilationCount?.count ?? 0,
      tokensSpent: totalTokensSpent?.total ?? 0,
      connectors: connectorCount?.count ?? 0,
    });
  } catch (err) {
    console.error('[admin/stats]', err);
    res.status(500).json({ error: 'Failed to load stats' });
  }
});

// ─── GET /users ──────────────────────────────────────────────────────────────

router.get('/users', async (_req: Request, res: Response): Promise<void> => {
  try {
    const allUsers = await db
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        role: users.role,
        clearance: users.clearance,
        tokensBalance: users.tokensBalance,
        tier: users.tier,
        emailVerified: users.emailVerified,
        createdAt: users.createdAt,
        updatedAt: users.updatedAt,
      })
      .from(users)
      .orderBy(desc(users.createdAt));

    res.json({ users: allUsers });
  } catch (err) {
    console.error('[admin/users]', err);
    res.status(500).json({ error: 'Failed to load users' });
  }
});

// ─── PUT /users/:id/role ─────────────────────────────────────────────────────

const updateRoleSchema = z.object({
  role: z.enum(['viewer', 'analyst', 'editor', 'admin']),
  clearance: z.enum(['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED']).optional(),
});

router.put(
  '/users/:id/role',
  validate(updateRoleSchema),
  async (req: Request, res: Response): Promise<void> => {
    const userId = req.params['id']!;
    const { role, clearance } = req.body as z.infer<typeof updateRoleSchema>;

    try {
      const updates: Record<string, unknown> = { role, updatedAt: new Date() };
      if (clearance) updates.clearance = clearance;

      await db.update(users).set(updates).where(eq(users.id, userId));
      res.json({ ok: true, userId, role, clearance });
    } catch (err) {
      console.error('[admin/users/:id/role]', err);
      res.status(500).json({ error: 'Failed to update role' });
    }
  },
);

// ─── PUT /users/:id/tokens ───────────────────────────────────────────────────

const updateTokensSchema = z.object({
  tokensBalance: z.number().int().min(0),
  tier: z.enum(['free', 'starter', 'pro', 'enterprise']).optional(),
});

router.put(
  '/users/:id/tokens',
  validate(updateTokensSchema),
  async (req: Request, res: Response): Promise<void> => {
    const userId = req.params['id']!;
    const { tokensBalance, tier } = req.body as z.infer<typeof updateTokensSchema>;

    try {
      const updates: Record<string, unknown> = { tokensBalance, updatedAt: new Date() };
      if (tier) updates.tier = tier;

      await db.update(users).set(updates).where(eq(users.id, userId));
      res.json({ ok: true, userId, tokensBalance, tier });
    } catch (err) {
      console.error('[admin/users/:id/tokens]', err);
      res.status(500).json({ error: 'Failed to update tokens' });
    }
  },
);

// ─── GET /audit ──────────────────────────────────────────────────────────────

router.get('/audit', async (req: Request, res: Response): Promise<void> => {
  const limit = parseInt(req.query['limit'] as string) || 100;

  try {
    const logs = await db
      .select({
        id: auditLog.id,
        userId: auditLog.userId,
        action: auditLog.action,
        resourceType: auditLog.resourceType,
        resourceId: auditLog.resourceId,
        details: auditLog.details,
        ipAddress: auditLog.ipAddress,
        createdAt: auditLog.createdAt,
      })
      .from(auditLog)
      .orderBy(desc(auditLog.createdAt))
      .limit(limit);

    res.json({ logs });
  } catch (err) {
    console.error('[admin/audit]', err);
    res.status(500).json({ error: 'Failed to load audit logs' });
  }
});

export default router;
