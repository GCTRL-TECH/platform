import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { randomBytes } from 'crypto';
import { eq, and } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../models/db.js';
import { apiKeys } from '../models/schema.js';
import { config } from '../config.js';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';

const router = Router();

// ─── Schemas ──────────────────────────────────────────────────────────────────

const createKeySchema = z.object({
  name: z
    .string()
    .min(1, 'Name is required')
    .max(255, 'Name too long')
    .default('Default'),
  scopes: z
    .array(z.string().min(1).max(100))
    .default([]),
});

// ─── POST / ───────────────────────────────────────────────────────────────────

router.post(
  '/',
  requireAuth,
  validate(createKeySchema),
  async (req: Request, res: Response): Promise<void> => {
    const userId = req.user!.sub;
    const { name, scopes } = req.body as z.infer<typeof createKeySchema>;

    try {
      // Generate a random API key: "bhk_" prefix + 40 random hex chars
      const rawKey = `bhk_${randomBytes(20).toString('hex')}`;
      const keyHash = await bcrypt.hash(rawKey, config.bcryptRounds);

      const [key] = await db
        .insert(apiKeys)
        .values({
          userId,
          keyHash,
          name,
          scopes,
        })
        .returning({
          id: apiKeys.id,
          name: apiKeys.name,
          scopes: apiKeys.scopes,
          createdAt: apiKeys.createdAt,
        });

      if (!key) {
        res.status(500).json({ error: 'Failed to create API key' });
        return;
      }

      // Return the raw key ONLY ONCE - it cannot be recovered after this
      res.status(201).json({
        key: rawKey,
        id: key.id,
        name: key.name,
        scopes: key.scopes,
        createdAt: key.createdAt,
        warning: 'Store this key securely. It will not be shown again.',
      });
    } catch (err) {
      console.error('[keys/create]', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// ─── GET / ────────────────────────────────────────────────────────────────────

router.get(
  '/',
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    const userId = req.user!.sub;

    try {
      const keys = await db
        .select({
          id: apiKeys.id,
          name: apiKeys.name,
          scopes: apiKeys.scopes,
          lastUsedAt: apiKeys.lastUsedAt,
          createdAt: apiKeys.createdAt,
        })
        .from(apiKeys)
        .where(eq(apiKeys.userId, userId))
        .orderBy(apiKeys.createdAt);

      res.json({ keys });
    } catch (err) {
      console.error('[keys/list]', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// ─── DELETE /:id ──────────────────────────────────────────────────────────────

router.delete(
  '/:id',
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    const userId = req.user!.sub;
    const keyId = req.params['id'];

    if (!keyId) {
      res.status(400).json({ error: 'Key ID is required' });
      return;
    }

    try {
      const [deleted] = await db
        .delete(apiKeys)
        .where(and(eq(apiKeys.id, keyId), eq(apiKeys.userId, userId)))
        .returning({ id: apiKeys.id });

      if (!deleted) {
        res.status(404).json({ error: 'API key not found' });
        return;
      }

      res.json({ message: 'API key deleted', id: deleted.id });
    } catch (err) {
      console.error('[keys/delete]', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

export default router;
