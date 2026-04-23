import { Router, Request, Response } from 'express';
import { eq, and } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../models/db.js';
import { kgFolders, compilations } from '../models/schema.js';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';

const router = Router();

const createFolderSchema = z.object({
  name: z.string().min(1).max(255),
  parentFolderId: z.string().uuid().nullable().optional(),
});

const updateFolderSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  parentFolderId: z.string().uuid().nullable().optional(),
});

const moveToFolderSchema = z.object({
  folderId: z.string().uuid().nullable(),
});

// GET / — list user's folders
router.get(
  '/',
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    const userId = req.user!.sub;
    try {
      const folders = await db
        .select()
        .from(kgFolders)
        .where(eq(kgFolders.userId, userId))
        .orderBy(kgFolders.position, kgFolders.name);
      res.json({ folders });
    } catch (err) {
      console.error('[folders GET]', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// POST / — create folder
router.post(
  '/',
  requireAuth,
  validate(createFolderSchema),
  async (req: Request, res: Response): Promise<void> => {
    const userId = req.user!.sub;
    const { name, parentFolderId } = req.body as z.infer<typeof createFolderSchema>;
    try {
      if (parentFolderId) {
        const [parent] = await db
          .select({ id: kgFolders.id })
          .from(kgFolders)
          .where(and(eq(kgFolders.id, parentFolderId), eq(kgFolders.userId, userId)))
          .limit(1);
        if (!parent) {
          res.status(404).json({ error: 'Parent folder not found' });
          return;
        }
      }

      const [folder] = await db
        .insert(kgFolders)
        .values({
          userId,
          name,
          parentFolderId: parentFolderId ?? null,
        })
        .returning();

      res.status(201).json({ folder });
    } catch (err) {
      console.error('[folders POST]', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// PUT /move/:compilationId — move a compilation into/out of a folder
// NOTE: Must be defined BEFORE /:id to prevent Express matching "move" as an :id param
router.put(
  '/move/:compilationId',
  requireAuth,
  validate(moveToFolderSchema),
  async (req: Request, res: Response): Promise<void> => {
    const userId = req.user!.sub;
    const compilationId = req.params['compilationId'];
    const { folderId } = req.body as z.infer<typeof moveToFolderSchema>;

    if (!compilationId) {
      res.status(400).json({ error: 'Compilation ID is required' });
      return;
    }

    try {
      // Verify compilation belongs to user
      const [comp] = await db
        .select({ id: compilations.id })
        .from(compilations)
        .where(and(eq(compilations.id, compilationId), eq(compilations.userId, userId)))
        .limit(1);

      if (!comp) {
        res.status(404).json({ error: 'Compilation not found' });
        return;
      }

      // If folderId set, verify it belongs to user
      if (folderId) {
        const [folder] = await db
          .select({ id: kgFolders.id })
          .from(kgFolders)
          .where(and(eq(kgFolders.id, folderId), eq(kgFolders.userId, userId)))
          .limit(1);

        if (!folder) {
          res.status(404).json({ error: 'Folder not found' });
          return;
        }
      }

      await db
        .update(compilations)
        .set({ folderId: folderId, updatedAt: new Date() })
        .where(eq(compilations.id, compilationId));

      res.json({ ok: true, compilationId, folderId });
    } catch (err) {
      console.error('[folders/move PUT]', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// PUT /:id — rename/move folder
router.put(
  '/:id',
  requireAuth,
  validate(updateFolderSchema),
  async (req: Request, res: Response): Promise<void> => {
    const userId = req.user!.sub;
    const folderId = req.params['id'];
    const updates = req.body as z.infer<typeof updateFolderSchema>;

    if (!folderId) {
      res.status(400).json({ error: 'Folder ID is required' });
      return;
    }

    try {
      const [folder] = await db
        .select()
        .from(kgFolders)
        .where(and(eq(kgFolders.id, folderId), eq(kgFolders.userId, userId)))
        .limit(1);

      if (!folder) {
        res.status(404).json({ error: 'Folder not found' });
        return;
      }

      const setValues: Partial<typeof kgFolders.$inferInsert> = { updatedAt: new Date() };
      if (updates.name !== undefined) setValues.name = updates.name;
      if (updates.parentFolderId !== undefined) setValues.parentFolderId = updates.parentFolderId;

      const [updated] = await db
        .update(kgFolders)
        .set(setValues)
        .where(eq(kgFolders.id, folderId))
        .returning();

      res.json({ folder: updated });
    } catch (err) {
      console.error('[folders PUT]', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// DELETE /:id — delete folder (contents move to parent/root)
router.delete(
  '/:id',
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    const userId = req.user!.sub;
    const folderId = req.params['id'];

    if (!folderId) {
      res.status(400).json({ error: 'Folder ID is required' });
      return;
    }

    try {
      const [folder] = await db
        .select()
        .from(kgFolders)
        .where(and(eq(kgFolders.id, folderId), eq(kgFolders.userId, userId)))
        .limit(1);

      if (!folder) {
        res.status(404).json({ error: 'Folder not found' });
        return;
      }

      // Move compilations in this folder to parent folder (or root)
      await db
        .update(compilations)
        .set({ folderId: folder.parentFolderId ?? null, updatedAt: new Date() })
        .where(eq(compilations.folderId, folderId));

      // Move sub-folders to parent folder (or root)
      await db
        .update(kgFolders)
        .set({ parentFolderId: folder.parentFolderId ?? null, updatedAt: new Date() })
        .where(eq(kgFolders.parentFolderId, folderId));

      // Delete the folder
      await db.delete(kgFolders).where(eq(kgFolders.id, folderId));

      res.json({ ok: true, deleted: folderId });
    } catch (err) {
      console.error('[folders DELETE]', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

export default router;
