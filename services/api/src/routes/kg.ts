import { Router, Request, Response } from 'express';
import { eq, and, or, inArray, desc } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../models/db.js';
import {
  compilations,
  compilationAcl,
  auditLog,
  jobs,
  UserClearance,
} from '../models/schema.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { tokenCost } from '../middleware/tokenMeter.js';
import { canAccess, CLEARANCE_LEVELS } from '../middleware/acl.js';
import { addKexJob } from '../services/queue.js';

const router = Router();

// ─── Schemas ──────────────────────────────────────────────────────────────────

const createCompilationSchema = z.object({
  name: z
    .string()
    .min(1, 'Name is required')
    .max(255, 'Name must be at most 255 characters'),
  description: z
    .string()
    .max(2000, 'Description must be at most 2000 characters')
    .optional(),
  classification: z
    .enum(['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED'])
    .optional()
    .default('PUBLIC'),
  sourceJobIds: z
    .array(z.string().uuid('Each sourceJobId must be a valid UUID'))
    .optional()
    .default([]),
});

const updateCompilationSchema = z.object({
  name: z
    .string()
    .min(1, 'Name must be at least 1 character')
    .max(255, 'Name must be at most 255 characters')
    .optional(),
  description: z
    .string()
    .max(2000, 'Description must be at most 2000 characters')
    .optional(),
  classification: z
    .enum(['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED'])
    .optional(),
  sourceJobIds: z
    .array(z.string().uuid())
    .optional(),
});

const scheduleSchema = z.object({
  schedule: z.string().nullable(),
  mode: z.enum(['incremental', 'full']).default('incremental'),
});

const aclUpdateSchema = z.object({
  entries: z.array(
    z.object({
      userId: z.string().uuid('userId must be a valid UUID'),
      permission: z.enum(['read', 'write', 'admin']),
    })
  ),
});

// ─── Helper: write audit log (fire-and-forget) ────────────────────────────────

const writeAuditLog = (
  userId: string,
  action: string,
  resourceType: string,
  resourceId: string,
  details: Record<string, unknown>,
  ipAddress?: string
): void => {
  setImmediate(async () => {
    try {
      await db.insert(auditLog).values({
        userId,
        action,
        resourceType,
        resourceId,
        details,
        ipAddress: ipAddress as unknown as string | undefined,
      });
    } catch (err) {
      console.error('[kg] Audit log write failed:', err);
    }
  });
};

// ─── Helper: resolve ACL-accessible compilation IDs for a user ────────────────

const getAccessibleCompilationIds = async (userId: string): Promise<string[]> => {
  const aclRows = await db
    .select({ compilationId: compilationAcl.compilationId })
    .from(compilationAcl)
    .where(eq(compilationAcl.userId, userId));

  return aclRows.map((r) => r.compilationId);
};

// ─── Helper: check if user can access a specific compilation ─────────────────

const checkCompilationAccess = async (
  compilationId: string,
  userId: string,
  userRole: string,
  userClearance: UserClearance
): Promise<{
  allowed: boolean;
  compilation: typeof compilations.$inferSelect | null;
}> => {
  const [compilation] = await db
    .select()
    .from(compilations)
    .where(eq(compilations.id, compilationId))
    .limit(1);

  if (!compilation) {
    return { allowed: false, compilation: null };
  }

  // Admin can always access
  if (userRole === 'admin') {
    return { allowed: true, compilation };
  }

  // Clearance check: user clearance must be >= compilation classification
  if (!canAccess(userClearance, compilation.classification as UserClearance)) {
    return { allowed: false, compilation: null };
  }

  // Owner can always access
  if (compilation.userId === userId) {
    return { allowed: true, compilation };
  }

  // Check ACL
  const [aclEntry] = await db
    .select({ id: compilationAcl.id })
    .from(compilationAcl)
    .where(
      and(
        eq(compilationAcl.compilationId, compilationId),
        eq(compilationAcl.userId, userId)
      )
    )
    .limit(1);

  return { allowed: !!aclEntry, compilation };
};

// ─── GET /compilations ────────────────────────────────────────────────────────

router.get(
  '/compilations',
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    const userId = req.user!.sub;
    const userRole = req.user!.role;
    const userClearance = req.user!.clearance;

    try {
      // Determine allowed classification levels for this user
      const userClearanceLevel = CLEARANCE_LEVELS.indexOf(userClearance);
      const allowedClassifications = CLEARANCE_LEVELS.slice(
        0,
        userClearanceLevel + 1
      ) as UserClearance[];

      let rows: (typeof compilations.$inferSelect)[];

      if (userRole === 'admin') {
        // Admins see all compilations within their clearance
        rows = await db
          .select()
          .from(compilations)
          .where(
            inArray(
              compilations.classification,
              allowedClassifications
            )
          )
          .orderBy(desc(compilations.createdAt));
      } else {
        // Get compilations user owns OR has ACL entry for
        const aclIds = await getAccessibleCompilationIds(userId);

        if (aclIds.length > 0) {
          rows = await db
            .select()
            .from(compilations)
            .where(
              and(
                inArray(compilations.classification, allowedClassifications),
                or(
                  eq(compilations.userId, userId),
                  inArray(compilations.id, aclIds)
                )
              )
            )
            .orderBy(desc(compilations.createdAt));
        } else {
          rows = await db
            .select()
            .from(compilations)
            .where(
              and(
                inArray(compilations.classification, allowedClassifications),
                eq(compilations.userId, userId)
              )
            )
            .orderBy(desc(compilations.createdAt));
        }
      }

      writeAuditLog(
        userId,
        'kg_compilations_listed',
        'compilation',
        '*',
        { count: rows.length },
        req.ip
      );

      res.json({ compilations: rows });
    } catch (err) {
      console.error('[kg/compilations GET]', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// ─── POST /compilations ───────────────────────────────────────────────────────

router.post(
  '/compilations',
  requireAuth,
  requireRole('editor', 'admin'),
  validate(createCompilationSchema),
  async (req: Request, res: Response): Promise<void> => {
    const { name, description, classification, sourceJobIds } =
      req.body as z.infer<typeof createCompilationSchema>;
    const userId = req.user!.sub;
    const userClearance = req.user!.clearance;

    // User cannot create a compilation with higher classification than their own clearance
    if (!canAccess(userClearance, classification as UserClearance)) {
      res.status(403).json({
        error: 'Cannot create compilation with classification above your clearance',
        yourClearance: userClearance,
        requestedClassification: classification,
      });
      return;
    }

    try {
      const [compilation] = await db
        .insert(compilations)
        .values({
          userId,
          name,
          description: description ?? null,
          sourceJobIds: (sourceJobIds ?? []) as unknown as string[],
          classification: classification as UserClearance,
          version: 1,
        })
        .returning();

      if (!compilation) {
        res.status(500).json({ error: 'Failed to create compilation' });
        return;
      }

      writeAuditLog(
        userId,
        'kg_compilation_created',
        'compilation',
        compilation.id,
        { name, classification },
        req.ip
      );

      res.status(201).json({ compilation });
    } catch (err) {
      console.error('[kg/compilations POST]', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// ─── GET /compilations/:id ────────────────────────────────────────────────────

router.get(
  '/compilations/:id',
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    const userId = req.user!.sub;
    const userRole = req.user!.role;
    const userClearance = req.user!.clearance;
    const compilationId = req.params['id'];

    if (!compilationId) {
      res.status(400).json({ error: 'Compilation ID is required' });
      return;
    }

    try {
      const { allowed, compilation } = await checkCompilationAccess(
        compilationId,
        userId,
        userRole,
        userClearance
      );

      if (!compilation) {
        res.status(404).json({ error: 'Compilation not found' });
        return;
      }

      if (!allowed) {
        res.status(403).json({ error: 'Access denied' });
        return;
      }

      writeAuditLog(
        userId,
        'kg_compilation_viewed',
        'compilation',
        compilationId,
        {},
        req.ip
      );

      res.json({ compilation });
    } catch (err) {
      console.error('[kg/compilations/:id GET]', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// ─── PUT /compilations/:id ────────────────────────────────────────────────────

router.put(
  '/compilations/:id',
  requireAuth,
  validate(updateCompilationSchema),
  async (req: Request, res: Response): Promise<void> => {
    const userId = req.user!.sub;
    const userRole = req.user!.role;
    const userClearance = req.user!.clearance;
    const compilationId = req.params['id'];
    const updates = req.body as z.infer<typeof updateCompilationSchema>;

    if (!compilationId) {
      res.status(400).json({ error: 'Compilation ID is required' });
      return;
    }

    try {
      const [compilation] = await db
        .select()
        .from(compilations)
        .where(eq(compilations.id, compilationId))
        .limit(1);

      if (!compilation) {
        res.status(404).json({ error: 'Compilation not found' });
        return;
      }

      // Only owner or admin can update
      if (compilation.userId !== userId && userRole !== 'admin') {
        res.status(403).json({ error: 'Access denied: must be owner or admin' });
        return;
      }

      // If updating classification, check clearance
      if (updates.classification) {
        if (!canAccess(userClearance, updates.classification as UserClearance)) {
          res.status(403).json({
            error: 'Cannot set classification above your clearance',
            yourClearance: userClearance,
            requestedClassification: updates.classification,
          });
          return;
        }
      }

      const setValues: Partial<typeof compilations.$inferInsert> = {
        updatedAt: new Date(),
      };

      if (updates.name !== undefined) setValues.name = updates.name;
      if (updates.description !== undefined) setValues.description = updates.description;
      if (updates.classification !== undefined) {
        setValues.classification = updates.classification as UserClearance;
      }
      if (updates.sourceJobIds !== undefined) {
        setValues.sourceJobIds = updates.sourceJobIds as unknown as string[];
      }

      const [updated] = await db
        .update(compilations)
        .set(setValues)
        .where(eq(compilations.id, compilationId))
        .returning();

      writeAuditLog(
        userId,
        'kg_compilation_updated',
        'compilation',
        compilationId,
        { updates },
        req.ip
      );

      res.json({ compilation: updated });
    } catch (err) {
      console.error('[kg/compilations/:id PUT]', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// ─── DELETE /compilations/:id ─────────────────────────────────────────────────

router.delete(
  '/compilations/:id',
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    const userId = req.user!.sub;
    const userRole = req.user!.role;
    const compilationId = req.params['id'];

    if (!compilationId) {
      res.status(400).json({ error: 'Compilation ID is required' });
      return;
    }

    try {
      const [compilation] = await db
        .select({ id: compilations.id, name: compilations.name, userId: compilations.userId })
        .from(compilations)
        .where(eq(compilations.id, compilationId))
        .limit(1);

      if (!compilation) {
        res.status(404).json({ error: 'Compilation not found' });
        return;
      }

      if (compilation.userId !== userId && userRole !== 'admin') {
        res.status(403).json({ error: 'Only the owner or admin can delete this compilation' });
        return;
      }

      await db.delete(compilations).where(eq(compilations.id, compilationId));

      writeAuditLog(
        userId,
        'kg_compilation_deleted',
        'compilation',
        compilationId,
        { name: compilation.name },
        req.ip
      );

      res.json({ ok: true, deleted: compilationId });
    } catch (err) {
      console.error('[kg/compilations/:id DELETE]', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// ─── POST /compilations/:id/refresh ──────────────────────────────────────────

router.post(
  '/compilations/:id/refresh',
  requireAuth,
  requireRole('editor', 'admin'),
  tokenCost(3, 'kg_refresh'),
  async (req: Request, res: Response): Promise<void> => {
    const userId = req.user!.sub;
    const userRole = req.user!.role;
    const userClearance = req.user!.clearance;
    const compilationId = req.params['id'];

    if (!compilationId) {
      res.status(400).json({ error: 'Compilation ID is required' });
      return;
    }

    try {
      const { allowed, compilation } = await checkCompilationAccess(
        compilationId,
        userId,
        userRole,
        userClearance
      );

      if (!compilation) {
        res.status(404).json({ error: 'Compilation not found' });
        return;
      }

      if (!allowed) {
        res.status(403).json({ error: 'Access denied' });
        return;
      }

      const sourceJobIds = (compilation.sourceJobIds ?? []) as string[];

      if (sourceJobIds.length === 0) {
        res.status(422).json({
          error: 'Compilation has no source jobs to refresh from',
        });
        return;
      }

      // Create a new kex job for each source (simplified: one combined job)
      const [job] = await db
        .insert(jobs)
        .values({
          userId,
          type: 'fuse_merge',
          status: 'pending',
          input: {
            compilationId,
            sourceJobIds,
            name: compilation.name,
            mode: compilation.cronMode ?? 'incremental',
            triggeredBy: 'manual_refresh',
          },
        })
        .returning();

      if (!job) {
        res.status(500).json({ error: 'Failed to create refresh job' });
        return;
      }

      // Update lastRefreshAt timestamp
      await db
        .update(compilations)
        .set({ lastRefreshAt: new Date(), updatedAt: new Date() })
        .where(eq(compilations.id, compilationId));

      try {
        await addKexJob(job.id, {
          userId,
          type: 'fuse_merge',
          input: {
            compilationId,
            sourceJobIds,
            name: compilation.name,
          },
        });
      } catch (qErr) {
        console.error('[kg/refresh] Redis dispatch failed (job stays pending):', qErr);
      }

      writeAuditLog(
        userId,
        'kg_compilation_refreshed',
        'compilation',
        compilationId,
        { jobId: job.id, mode: compilation.cronMode ?? 'incremental' },
        req.ip
      );

      res.status(202).json({
        jobId: job.id,
        compilationId,
        status: 'pending',
      });
    } catch (err) {
      console.error('[kg/compilations/:id/refresh POST]', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// ─── PUT /compilations/:id/schedule ──────────────────────────────────────────

router.put(
  '/compilations/:id/schedule',
  requireAuth,
  requireRole('editor', 'admin'),
  validate(scheduleSchema),
  async (req: Request, res: Response): Promise<void> => {
    const userId = req.user!.sub;
    const userRole = req.user!.role;
    const userClearance = req.user!.clearance;
    const compilationId = req.params['id'];
    const { schedule, mode } = req.body as z.infer<typeof scheduleSchema>;

    if (!compilationId) {
      res.status(400).json({ error: 'Compilation ID is required' });
      return;
    }

    try {
      const { allowed, compilation } = await checkCompilationAccess(
        compilationId,
        userId,
        userRole,
        userClearance
      );

      if (!compilation) {
        res.status(404).json({ error: 'Compilation not found' });
        return;
      }

      if (!allowed) {
        res.status(403).json({ error: 'Access denied' });
        return;
      }

      const [updated] = await db
        .update(compilations)
        .set({
          cronSchedule: schedule,
          cronMode: mode,
          updatedAt: new Date(),
        })
        .where(eq(compilations.id, compilationId))
        .returning();

      writeAuditLog(
        userId,
        'kg_compilation_schedule_updated',
        'compilation',
        compilationId,
        { schedule, mode },
        req.ip
      );

      res.json({
        compilationId,
        cronSchedule: updated?.cronSchedule ?? null,
        cronMode: updated?.cronMode ?? mode,
      });
    } catch (err) {
      console.error('[kg/compilations/:id/schedule PUT]', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// ─── GET /compilations/:id/acl ────────────────────────────────────────────────

router.get(
  '/compilations/:id/acl',
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    const userId = req.user!.sub;
    const userRole = req.user!.role;
    const userClearance = req.user!.clearance;
    const compilationId = req.params['id'];

    if (!compilationId) {
      res.status(400).json({ error: 'Compilation ID is required' });
      return;
    }

    try {
      const { allowed, compilation } = await checkCompilationAccess(
        compilationId,
        userId,
        userRole,
        userClearance
      );

      if (!compilation) {
        res.status(404).json({ error: 'Compilation not found' });
        return;
      }

      if (!allowed) {
        res.status(403).json({ error: 'Access denied' });
        return;
      }

      const entries = await db
        .select({
          id: compilationAcl.id,
          userId: compilationAcl.userId,
          permission: compilationAcl.permission,
          grantedBy: compilationAcl.grantedBy,
          createdAt: compilationAcl.createdAt,
        })
        .from(compilationAcl)
        .where(eq(compilationAcl.compilationId, compilationId))
        .orderBy(desc(compilationAcl.createdAt));

      writeAuditLog(
        userId,
        'kg_acl_viewed',
        'compilation',
        compilationId,
        {},
        req.ip
      );

      res.json({ compilationId, entries });
    } catch (err) {
      console.error('[kg/compilations/:id/acl GET]', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// ─── PUT /compilations/:id/acl ────────────────────────────────────────────────

router.put(
  '/compilations/:id/acl',
  requireAuth,
  requireRole('editor', 'admin'),
  validate(aclUpdateSchema),
  async (req: Request, res: Response): Promise<void> => {
    const userId = req.user!.sub;
    const userRole = req.user!.role;
    const userClearance = req.user!.clearance;
    const compilationId = req.params['id'];
    const { entries } = req.body as z.infer<typeof aclUpdateSchema>;

    if (!compilationId) {
      res.status(400).json({ error: 'Compilation ID is required' });
      return;
    }

    try {
      const { allowed, compilation } = await checkCompilationAccess(
        compilationId,
        userId,
        userRole,
        userClearance
      );

      if (!compilation) {
        res.status(404).json({ error: 'Compilation not found' });
        return;
      }

      // Only owner or admin can manage ACL
      if (compilation.userId !== userId && userRole !== 'admin') {
        res.status(403).json({ error: 'Access denied: must be owner or admin' });
        return;
      }

      void allowed; // already checked ownership above

      // Replace all ACL entries for this compilation
      await db
        .delete(compilationAcl)
        .where(eq(compilationAcl.compilationId, compilationId));

      let inserted: (typeof compilationAcl.$inferSelect)[] = [];

      if (entries.length > 0) {
        inserted = await db
          .insert(compilationAcl)
          .values(
            entries.map((e) => ({
              compilationId,
              userId: e.userId,
              permission: e.permission,
              grantedBy: userId,
            }))
          )
          .returning();
      }

      writeAuditLog(
        userId,
        'kg_acl_updated',
        'compilation',
        compilationId,
        { entryCount: entries.length, entries },
        req.ip
      );

      res.json({ compilationId, entries: inserted });
    } catch (err) {
      console.error('[kg/compilations/:id/acl PUT]', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// ─── GET /compilations/:id/audit ─────────────────────────────────────────────

router.get(
  '/compilations/:id/audit',
  requireAuth,
  requireRole('admin'),
  async (req: Request, res: Response): Promise<void> => {
    const userId = req.user!.sub;
    const compilationId = req.params['id'];

    if (!compilationId) {
      res.status(400).json({ error: 'Compilation ID is required' });
      return;
    }

    try {
      const [compilation] = await db
        .select({ id: compilations.id })
        .from(compilations)
        .where(eq(compilations.id, compilationId))
        .limit(1);

      if (!compilation) {
        res.status(404).json({ error: 'Compilation not found' });
        return;
      }

      const entries = await db
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
        .where(
          and(
            eq(auditLog.resourceType, 'compilation'),
            eq(auditLog.resourceId, compilationId)
          )
        )
        .orderBy(desc(auditLog.createdAt));

      writeAuditLog(
        userId,
        'kg_audit_viewed',
        'compilation',
        compilationId,
        { entryCount: entries.length },
        req.ip
      );

      res.json({ compilationId, audit: entries });
    } catch (err) {
      console.error('[kg/compilations/:id/audit GET]', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

export default router;
