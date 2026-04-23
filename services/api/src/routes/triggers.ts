import { Router, Request, Response } from 'express';
import { eq, and, desc } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../models/db.js';
import { triggers } from '../models/schema.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { nextRunFromCron, getHeartbeat } from '../services/heartbeat.js';

const router = Router();

// ─── Heartbeat config endpoints ──────────────────────────────────────────────

router.get('/heartbeat', requireAuth, async (_req: Request, res: Response): Promise<void> => {
  const hb = getHeartbeat();
  res.json(hb ? hb.getStatus() : { intervalMs: 60000, lastTickAt: null });
});

router.put('/heartbeat', requireAuth, requireRole('admin'), async (req: Request, res: Response): Promise<void> => {
  const ms = Math.max(1000, parseInt(req.body.intervalMs) || 60000);
  const hb = getHeartbeat();
  if (hb) {
    await hb.setHeartbeatInterval(ms);
    res.json({ ok: true, intervalMs: ms });
  } else {
    res.status(500).json({ error: 'Heartbeat not running' });
  }
});

router.post('/heartbeat/tick', requireAuth, requireRole('admin'), async (_req: Request, res: Response): Promise<void> => {
  const hb = getHeartbeat();
  if (hb) {
    await hb.tick();
    res.json({ ok: true, message: 'Heartbeat tick executed' });
  } else {
    res.status(500).json({ error: 'Heartbeat not running' });
  }
});

// ─── Schemas ─────────────────────────────────────────────────────────────────

const createTriggerSchema = z.object({
  name: z.string().min(1).max(255),
  module: z.enum(['kex', 'fuse', 'compilation']),
  type: z.enum(['cron', 'change_detection']),
  cronSchedule: z.string().optional(),
  config: z.record(z.unknown()).default({}),
});

const updateTriggerSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  cronSchedule: z.string().optional(),
  config: z.record(z.unknown()).optional(),
});

// ─── GET / ───────────────────────────────────────────────────────────────────

router.get(
  '/',
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    const userId = req.user!.sub;
    const module = req.query['module'] as string | undefined;

    let rows;
    if (module) {
      rows = await db.select().from(triggers)
        .where(and(eq(triggers.userId, userId), eq(triggers.module, module as 'kex' | 'fuse' | 'compilation')))
        .orderBy(desc(triggers.createdAt));
    } else {
      rows = await db.select().from(triggers)
        .where(eq(triggers.userId, userId))
        .orderBy(desc(triggers.createdAt));
    }

    res.json({ triggers: rows });
  },
);

// ─── POST / ──────────────────────────────────────────────────────────────────

router.post(
  '/',
  requireAuth,
  requireRole('analyst', 'editor', 'admin'),
  validate(createTriggerSchema),
  async (req: Request, res: Response): Promise<void> => {
    const userId = req.user!.sub;
    const { name, module, type, cronSchedule, config: triggerConfig } = req.body as z.infer<typeof createTriggerSchema>;

    try {
      const nextRunAt = cronSchedule ? nextRunFromCron(cronSchedule) : null;

      const [trigger] = await db.insert(triggers).values({
        userId,
        name,
        module: module as 'kex' | 'fuse' | 'compilation',
        type: type as 'cron' | 'change_detection',
        cronSchedule: cronSchedule || null,
        config: triggerConfig,
        status: 'active',
        nextRunAt,
      }).returning();

      res.status(201).json({ trigger });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  },
);

// ─── GET /:id ────────────────────────────────────────────────────────────────

router.get(
  '/:id',
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    const userId = req.user!.sub;
    const triggerId = req.params['id']!;

    const [trigger] = await db.select().from(triggers)
      .where(and(eq(triggers.id, triggerId), eq(triggers.userId, userId)))
      .limit(1);

    if (!trigger) { res.status(404).json({ error: 'Trigger not found' }); return; }
    res.json({ trigger });
  },
);

// ─── PUT /:id ────────────────────────────────────────────────────────────────

router.put(
  '/:id',
  requireAuth,
  validate(updateTriggerSchema),
  async (req: Request, res: Response): Promise<void> => {
    const userId = req.user!.sub;
    const triggerId = req.params['id']!;
    const updates = req.body as z.infer<typeof updateTriggerSchema>;

    const [existing] = await db.select({ id: triggers.id }).from(triggers)
      .where(and(eq(triggers.id, triggerId), eq(triggers.userId, userId))).limit(1);
    if (!existing) { res.status(404).json({ error: 'Trigger not found' }); return; }

    const setData: Record<string, unknown> = { updatedAt: new Date() };
    if (updates.name) setData.name = updates.name;
    if (updates.cronSchedule !== undefined) setData.cronSchedule = updates.cronSchedule;
    if (updates.config) setData.config = updates.config;

    await db.update(triggers).set(setData).where(eq(triggers.id, triggerId));
    res.json({ ok: true, triggerId });
  },
);

// ─── DELETE /:id ─────────────────────────────────────────────────────────────

router.delete(
  '/:id',
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    const userId = req.user!.sub;
    const triggerId = req.params['id']!;
    await db.delete(triggers).where(and(eq(triggers.id, triggerId), eq(triggers.userId, userId)));
    res.json({ ok: true, deleted: triggerId });
  },
);

// ─── POST /:id/pause ────────────────────────────────────────────────────────

router.post(
  '/:id/pause',
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    const userId = req.user!.sub;
    const triggerId = req.params['id']!;
    // Paused triggers won't be picked up by heartbeat (status != 'active')
    await db.update(triggers).set({ status: 'paused', updatedAt: new Date() })
      .where(and(eq(triggers.id, triggerId), eq(triggers.userId, userId)));
    res.json({ ok: true, status: 'paused' });
  },
);

// ─── POST /:id/resume ───────────────────────────────────────────────────────

router.post(
  '/:id/resume',
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    const userId = req.user!.sub;
    const triggerId = req.params['id']!;

    // Recalculate nextRunAt so heartbeat picks it up on next tick
    const [trigger] = await db.select().from(triggers)
      .where(and(eq(triggers.id, triggerId), eq(triggers.userId, userId))).limit(1);

    const nextRun = trigger?.cronSchedule ? nextRunFromCron(trigger.cronSchedule) : null;
    await db.update(triggers).set({ status: 'active', nextRunAt: nextRun, updatedAt: new Date() })
      .where(and(eq(triggers.id, triggerId), eq(triggers.userId, userId)));

    res.json({ ok: true, status: 'active' });
  },
);

// ─── POST /:id/run-now ──────────────────────────────────────────────────────

router.post(
  '/:id/run-now',
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    const userId = req.user!.sub;
    const triggerId = req.params['id']!;

    const [trigger] = await db.select().from(triggers)
      .where(and(eq(triggers.id, triggerId), eq(triggers.userId, userId))).limit(1);

    if (!trigger) { res.status(404).json({ error: 'Trigger not found' }); return; }

    try {
      const hb = getHeartbeat();
      if (hb) {
        await hb.executeTrigger(trigger);
        res.json({ ok: true, message: 'Trigger executed' });
      } else {
        res.status(500).json({ error: 'Heartbeat not running' });
      }
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  },
);

export default router;
