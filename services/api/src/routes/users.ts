import { Router, Request, Response } from 'express';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../models/db.js';
import { users, UserRole } from '../models/schema.js';
import { requireAuth } from '../middleware/auth.js';
import { requireRole } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';

const router = Router();

// ─── Schema ───────────────────────────────────────────────────────────────────

const updateRoleSchema = z.object({
  role: z.enum(['viewer', 'analyst', 'editor', 'admin'] as const),
});

const updateSettingsSchema = z.object({
  defaultOntologyId: z.string().uuid().nullable().optional(),
});

const safeUser = (user: typeof users.$inferSelect) => ({
  id: user.id,
  email: user.email,
  name: user.name,
  role: user.role,
  clearance: user.clearance,
  emailVerified: user.emailVerified,
  tokensBalance: user.tokensBalance,
  tier: user.tier,
  defaultOntologyId: user.defaultOntologyId,
  createdAt: user.createdAt,
  updatedAt: user.updatedAt,
});

// ─── GET /me ──────────────────────────────────────────────────────────────────

router.get(
  '/me',
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    const userId = req.user!.sub;

    try {
      const [user] = await db
        .select()
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);

      if (!user) {
        res.status(404).json({ error: 'User not found' });
        return;
      }

      res.json({ user: safeUser(user) });
    } catch (err) {
      console.error('[users/me]', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// ─── GET / (admin only) ────────────────────────────────────────────────────────

router.get(
  '/',
  requireAuth,
  requireRole('admin'),
  async (_req: Request, res: Response): Promise<void> => {
    try {
      const allUsers = await db
        .select({
          id: users.id,
          email: users.email,
          name: users.name,
          role: users.role,
          clearance: users.clearance,
          emailVerified: users.emailVerified,
          tokensBalance: users.tokensBalance,
          tier: users.tier,
          createdAt: users.createdAt,
          updatedAt: users.updatedAt,
        })
        .from(users)
        .orderBy(users.createdAt);

      res.json({ users: allUsers });
    } catch (err) {
      console.error('[users/list]', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// ─── PUT /:id/role (admin only) ────────────────────────────────────────────────

router.put(
  '/:id/role',
  requireAuth,
  requireRole('admin'),
  validate(updateRoleSchema),
  async (req: Request, res: Response): Promise<void> => {
    const targetId = req.params['id'];
    const { role } = req.body as z.infer<typeof updateRoleSchema>;

    if (!targetId) {
      res.status(400).json({ error: 'User ID is required' });
      return;
    }

    // Prevent admin from demoting themselves
    if (targetId === req.user!.sub && role !== 'admin') {
      res.status(400).json({ error: 'You cannot change your own admin role' });
      return;
    }

    try {
      const [updated] = await db
        .update(users)
        .set({ role: role as UserRole, updatedAt: new Date() })
        .where(eq(users.id, targetId))
        .returning({
          id: users.id,
          email: users.email,
          name: users.name,
          role: users.role,
        });

      if (!updated) {
        res.status(404).json({ error: 'User not found' });
        return;
      }

      res.json({ user: updated });
    } catch (err) {
      console.error('[users/:id/role]', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// ─── PUT /me/settings ────────────────────────────────────────────────────────

router.put(
  '/me/settings',
  requireAuth,
  validate(updateSettingsSchema),
  async (req: Request, res: Response): Promise<void> => {
    const userId = req.user!.sub;
    const { defaultOntologyId } = req.body as z.infer<typeof updateSettingsSchema>;

    try {
      const [updated] = await db
        .update(users)
        .set({
          defaultOntologyId: defaultOntologyId ?? null,
          updatedAt: new Date(),
        })
        .where(eq(users.id, userId))
        .returning();

      if (!updated) {
        res.status(404).json({ error: 'User not found' });
        return;
      }

      res.json({ user: safeUser(updated) });
    } catch (err) {
      console.error('[users/me/settings]', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

export default router;
