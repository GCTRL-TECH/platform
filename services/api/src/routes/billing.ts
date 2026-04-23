import { Router, Request, Response } from 'express';
import { eq, desc, sql, and, gte } from 'drizzle-orm';
import { db } from '../models/db.js';
import { users, tokenUsage } from '../models/schema.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

// ─── GET /balance ────────────────────────────────────────────────────────────

router.get(
  '/balance',
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    const userId = req.user!.sub;

    const [user] = await db
      .select({
        tokensBalance: users.tokensBalance,
        tier: users.tier,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    // Get tier limits
    const tierLimits: Record<string, number> = {
      free: 50,
      starter: 500,
      pro: 5000,
      enterprise: 999999,
    };

    res.json({
      balance: user.tokensBalance,
      tier: user.tier,
      tierLimit: tierLimits[user.tier] ?? 50,
    });
  },
);

// ─── GET /usage ──────────────────────────────────────────────────────────────

router.get(
  '/usage',
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    const userId = req.user!.sub;
    const days = parseInt(req.query['days'] as string) || 30;

    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const usage = await db
      .select({
        id: tokenUsage.id,
        action: tokenUsage.action,
        tokensSpent: tokenUsage.tokensSpent,
        jobId: tokenUsage.jobId,
        createdAt: tokenUsage.createdAt,
      })
      .from(tokenUsage)
      .where(and(eq(tokenUsage.userId, userId), gte(tokenUsage.createdAt, since)))
      .orderBy(desc(tokenUsage.createdAt))
      .limit(500);

    res.json({ usage, period: { days, since: since.toISOString() } });
  },
);

// ─── GET /usage/summary ──────────────────────────────────────────────────────

router.get(
  '/usage/summary',
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    const userId = req.user!.sub;
    const days = parseInt(req.query['days'] as string) || 30;

    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    // Group by action
    const byAction = await db
      .select({
        action: tokenUsage.action,
        totalSpent: sql<number>`sum(${tokenUsage.tokensSpent})`,
        count: sql<number>`count(*)`,
      })
      .from(tokenUsage)
      .where(and(eq(tokenUsage.userId, userId), gte(tokenUsage.createdAt, since)))
      .groupBy(tokenUsage.action)
      .orderBy(sql`sum(${tokenUsage.tokensSpent}) DESC`);

    // Group by day
    const byDay = await db
      .select({
        date: sql<string>`date_trunc('day', ${tokenUsage.createdAt})::date`,
        totalSpent: sql<number>`sum(${tokenUsage.tokensSpent})`,
        count: sql<number>`count(*)`,
      })
      .from(tokenUsage)
      .where(and(eq(tokenUsage.userId, userId), gte(tokenUsage.createdAt, since)))
      .groupBy(sql`date_trunc('day', ${tokenUsage.createdAt})::date`)
      .orderBy(sql`date_trunc('day', ${tokenUsage.createdAt})::date`);

    // Total
    const [total] = await db
      .select({
        totalSpent: sql<number>`coalesce(sum(${tokenUsage.tokensSpent}), 0)`,
        totalActions: sql<number>`count(*)`,
      })
      .from(tokenUsage)
      .where(and(eq(tokenUsage.userId, userId), gte(tokenUsage.createdAt, since)));

    res.json({
      byAction,
      byDay,
      total: {
        tokensSpent: total?.totalSpent ?? 0,
        actions: total?.totalActions ?? 0,
      },
      period: { days, since: since.toISOString() },
    });
  },
);

export default router;
