import { Router, Request, Response } from 'express';
import { eq, and, desc } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../models/db.js';
import { jobs, compilations, auditLog, ontologyMatchRules } from '../models/schema.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { tokenCost } from '../middleware/tokenMeter.js';
import { addFuseJob } from '../services/queue.js';

const router = Router();

// ─── In-memory resolver config store (placeholder) ───────────────────────────

interface ResolverConfig {
  similarityThreshold: number;
  measureFunction: string;
  maxCandidates: number;
  acceptThreshold: number;
  reviewThreshold: number;
}

let resolverConfig: ResolverConfig = {
  similarityThreshold: 0.85,
  measureFunction: 'trigrams',
  maxCandidates: 10,
  acceptThreshold: 0.95,
  reviewThreshold: 0.75,
};

// ─── Schemas ──────────────────────────────────────────────────────────────────

const mergeSchema = z.object({
  name: z
    .string()
    .min(1, 'Name is required')
    .max(255, 'Name must be at most 255 characters'),
  sourceJobIds: z
    .array(z.string().uuid('Each sourceJobId must be a valid UUID'))
    .min(1, 'At least one source job ID is required'),
  description: z
    .string()
    .max(2000, 'Description must be at most 2000 characters')
    .optional(),
  targetCompilationId: z
    .string()
    .uuid('targetCompilationId must be a valid UUID')
    .optional(),
  ontologyId: z
    .string()
    .uuid('ontologyId must be a valid UUID')
    .optional(),
});

const reviewDecisionsSchema = z.object({
  decisions: z.array(
    z.object({
      entityPairId: z.string(),
      action: z.enum(['merge', 'keep_separate']),
    })
  ),
});

const resolverConfigUpdateSchema = z.object({
  similarityThreshold: z.number().min(0).max(1).optional(),
  measureFunction: z
    .enum(['trigrams', 'jaccard', 'cosine', 'levenshtein'])
    .optional(),
  maxCandidates: z.number().int().min(1).max(100).optional(),
  acceptThreshold: z.number().min(0).max(1).optional(),
  reviewThreshold: z.number().min(0).max(1).optional(),
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
      console.error('[fuse] Audit log write failed:', err);
    }
  });
};

// ─── POST /merge ──────────────────────────────────────────────────────────────

router.post(
  '/merge',
  requireAuth,
  requireRole('editor', 'admin'),
  validate(mergeSchema),
  tokenCost(10, 'fuse_merge'),
  async (req: Request, res: Response): Promise<void> => {
    const { name, sourceJobIds, description, targetCompilationId, ontologyId } =
      req.body as z.infer<typeof mergeSchema>;
    const userId = req.user!.sub;

    try {
      let compilationId: string;

      if (targetCompilationId) {
        // ── Enrich existing compilation ────────────────────────────────────────
        const [existing] = await db
          .select({ id: compilations.id, sourceJobIds: compilations.sourceJobIds })
          .from(compilations)
          .where(and(eq(compilations.id, targetCompilationId), eq(compilations.userId, userId)))
          .limit(1);

        if (!existing) {
          res.status(404).json({ error: 'Target compilation not found' });
          return;
        }

        // Merge new sourceJobIds into existing, dedup
        const existingIds = (existing.sourceJobIds as string[]) ?? [];
        const mergedIds = Array.from(new Set([...existingIds, ...sourceJobIds]));

        await db
          .update(compilations)
          .set({
            sourceJobIds: mergedIds as unknown as string[],
            updatedAt: new Date(),
          })
          .where(eq(compilations.id, targetCompilationId));

        compilationId = targetCompilationId;
      } else {
        // ── Create new compilation ─────────────────────────────────────────────
        const [compilation] = await db
          .insert(compilations)
          .values({
            userId,
            name,
            description: description ?? null,
            sourceJobIds: sourceJobIds as unknown as string[],
            classification: 'INTERNAL',
            version: 1,
            ...(ontologyId ? { ontologyId } : {}),
          })
          .returning();

        if (!compilation) {
          res.status(500).json({ error: 'Failed to create compilation' });
          return;
        }

        compilationId = compilation.id;
      }

      // Create the fuse_merge job record
      const [job] = await db
        .insert(jobs)
        .values({
          userId,
          type: 'fuse_merge',
          status: 'pending',
          input: {
            compilationId,
            sourceJobIds,
            name,
            ...(targetCompilationId ? { targetCompilationId } : {}),
          },
        })
        .returning();

      if (!job) {
        res.status(500).json({ error: 'Failed to create fuse job' });
        return;
      }

      // Fetch ontology match rules if ontologyId is set
      let matchRules: Array<Record<string, unknown>> | undefined;
      if (ontologyId) {
        const rules = await db
          .select()
          .from(ontologyMatchRules)
          .where(eq(ontologyMatchRules.ontologyId, ontologyId));
        if (rules.length > 0) {
          matchRules = rules.map((r) => ({
            entityTypeA: r.entityTypeA,
            entityTypeB: r.entityTypeB,
            canMatch: r.canMatch,
            similarityMetric: r.similarityMetric,
            threshold: r.threshold,
            blockingStrategy: r.blockingStrategy,
            propertiesToMatch: r.propertiesToMatch,
          }));
        }
      }

      // Dispatch to Redis queue 'fuse:jobs' (non-fatal if Redis is unavailable)
      try {
        await addFuseJob(job.id, {
          userId,
          compilationId,
          sourceJobIds,
          name,
          matchRules,
        });
      } catch (qErr) {
        console.error('[fuse/merge] Redis dispatch failed (job stays pending):', qErr);
      }

      writeAuditLog(
        userId,
        targetCompilationId ? 'fuse_enrich_created' : 'fuse_merge_created',
        'compilation',
        compilationId,
        { sourceJobIds, jobId: job.id, targetCompilationId },
        req.ip
      );

      console.log(
        `[fuse/merge] Job created: ${job.id}, compilation: ${compilationId}${targetCompilationId ? ' (enrich)' : ' (new)'}`
      );

      res.status(202).json({
        compilationId,
        jobId: job.id,
        status: 'pending',
      });
    } catch (err) {
      console.error('[fuse/merge]', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// ─── GET /jobs ────────────────────────────────────────────────────────────────

router.get(
  '/jobs',
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    const userId = req.user!.sub;

    try {
      const userJobs = await db
        .select({
          id: jobs.id,
          type: jobs.type,
          status: jobs.status,
          input: jobs.input,
          result: jobs.result,
          createdAt: jobs.createdAt,
          updatedAt: jobs.updatedAt,
          completedAt: jobs.completedAt,
          error: jobs.error,
        })
        .from(jobs)
        .where(and(eq(jobs.userId, userId), eq(jobs.type, 'fuse_merge')))
        .orderBy(desc(jobs.createdAt));

      res.json({ jobs: userJobs });
    } catch (err) {
      console.error('[fuse/jobs]', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// ─── GET /jobs/:id ────────────────────────────────────────────────────────────

router.get(
  '/jobs/:id',
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    const userId = req.user!.sub;
    const jobId = req.params['id'];

    if (!jobId) {
      res.status(400).json({ error: 'Job ID is required' });
      return;
    }

    try {
      const [job] = await db
        .select({
          id: jobs.id,
          type: jobs.type,
          status: jobs.status,
          input: jobs.input,
          result: jobs.result,
          error: jobs.error,
          createdAt: jobs.createdAt,
          updatedAt: jobs.updatedAt,
          completedAt: jobs.completedAt,
        })
        .from(jobs)
        .where(and(eq(jobs.id, jobId), eq(jobs.userId, userId)))
        .limit(1);

      if (!job || job.type !== 'fuse_merge') {
        res.status(404).json({ error: 'Fuse job not found' });
        return;
      }

      res.json({ job });
    } catch (err) {
      console.error('[fuse/jobs/:id]', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// ─── GET /jobs/:id/review ─────────────────────────────────────────────────────

router.get(
  '/jobs/:id/review',
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    const userId = req.user!.sub;
    const jobId = req.params['id'];

    if (!jobId) {
      res.status(400).json({ error: 'Job ID is required' });
      return;
    }

    try {
      const [job] = await db
        .select({ id: jobs.id, type: jobs.type, status: jobs.status })
        .from(jobs)
        .where(and(eq(jobs.id, jobId), eq(jobs.userId, userId)))
        .limit(1);

      if (!job || job.type !== 'fuse_merge') {
        res.status(404).json({ error: 'Fuse job not found' });
        return;
      }

      // Placeholder: review queue populates this when worker integration is complete
      res.json({
        jobId,
        status: job.status,
        pendingReview: [],
        message: 'No entities pending human review',
      });
    } catch (err) {
      console.error('[fuse/jobs/:id/review GET]', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// ─── POST /jobs/:id/review ────────────────────────────────────────────────────

router.post(
  '/jobs/:id/review',
  requireAuth,
  validate(reviewDecisionsSchema),
  async (req: Request, res: Response): Promise<void> => {
    const userId = req.user!.sub;
    const jobId = req.params['id'];
    const { decisions } = req.body as z.infer<typeof reviewDecisionsSchema>;

    if (!jobId) {
      res.status(400).json({ error: 'Job ID is required' });
      return;
    }

    try {
      const [job] = await db
        .select({ id: jobs.id, type: jobs.type, status: jobs.status })
        .from(jobs)
        .where(and(eq(jobs.id, jobId), eq(jobs.userId, userId)))
        .limit(1);

      if (!job || job.type !== 'fuse_merge') {
        res.status(404).json({ error: 'Fuse job not found' });
        return;
      }

      writeAuditLog(
        userId,
        'fuse_review_submitted',
        'job',
        jobId,
        { decisionCount: decisions.length },
        req.ip
      );

      // Placeholder: decisions will be forwarded to resolver worker in future integration
      res.json({
        ok: true,
        jobId,
        processed: decisions.length,
        message: 'Review decisions accepted',
      });
    } catch (err) {
      console.error('[fuse/jobs/:id/review POST]', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// ─── GET /config ──────────────────────────────────────────────────────────────

router.get(
  '/config',
  requireAuth,
  async (_req: Request, res: Response): Promise<void> => {
    res.json({ config: resolverConfig });
  }
);

// ─── PUT /config ──────────────────────────────────────────────────────────────

router.put(
  '/config',
  requireAuth,
  requireRole('editor', 'admin'),
  validate(resolverConfigUpdateSchema),
  async (req: Request, res: Response): Promise<void> => {
    const userId = req.user!.sub;
    const updates = req.body as z.infer<typeof resolverConfigUpdateSchema>;

    resolverConfig = { ...resolverConfig, ...updates };

    writeAuditLog(
      userId,
      'fuse_config_updated',
      'fuse_config',
      'global',
      { updates },
      req.ip
    );

    res.json({ ok: true, config: resolverConfig });
  }
);

// ─── POST /jobs/:id/cancel ────────────────────────────────────────────────────

router.post(
  '/jobs/:id/cancel',
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    const userId = req.user!.sub;
    const jobId = req.params['id'];

    if (!jobId) {
      res.status(400).json({ error: 'Job ID is required' });
      return;
    }

    try {
      const [job] = await db
        .select({ id: jobs.id, status: jobs.status, userId: jobs.userId })
        .from(jobs)
        .where(and(eq(jobs.id, jobId), eq(jobs.userId, userId)))
        .limit(1);

      if (!job) {
        res.status(404).json({ error: 'Job not found' });
        return;
      }

      if (job.status !== 'pending' && job.status !== 'processing') {
        res.status(400).json({ error: 'Job is already completed or failed' });
        return;
      }

      await db
        .update(jobs)
        .set({
          status: 'failed',
          error: 'Cancelled by user',
          updatedAt: new Date(),
          completedAt: new Date(),
        })
        .where(eq(jobs.id, jobId));

      res.json({ message: 'Job cancelled', jobId });
    } catch (err) {
      console.error('[fuse/jobs/:id/cancel]', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// ─── DELETE /jobs/:id ─────────────────────────────────────────────────────────

router.delete(
  '/jobs/:id',
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    const userId = req.user!.sub;
    const jobId = req.params['id'];

    if (!jobId) {
      res.status(400).json({ error: 'Job ID is required' });
      return;
    }

    try {
      const [job] = await db
        .select({ id: jobs.id, userId: jobs.userId })
        .from(jobs)
        .where(and(eq(jobs.id, jobId), eq(jobs.userId, userId)))
        .limit(1);

      if (!job) {
        res.status(404).json({ error: 'Job not found' });
        return;
      }

      await db.delete(jobs).where(eq(jobs.id, jobId));
      res.json({ ok: true, deleted: jobId });
    } catch (err) {
      console.error('[fuse/jobs/:id DELETE]', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

export default router;
