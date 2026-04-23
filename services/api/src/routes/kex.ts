import express, { Router, Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { eq, and, desc, sql, isNull, like, or } from 'drizzle-orm';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../models/db.js';
import { jobs, jobBatches, ontologyEntityTypes } from '../models/schema.js';
import { config } from '../config.js';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { tokenCost } from '../middleware/tokenMeter.js';
import { addKexJob } from '../services/queue.js';


const router = Router();

// ─── Multer setup ─────────────────────────────────────────────────────────────

// Ensure upload dir exists
try {
  fs.mkdirSync(config.uploadDir, { recursive: true });
} catch {
  // Already exists or not writable - will fail on first upload
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, config.uploadDir);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname);
    const safeName = `${uuidv4()}${ext}`;
    cb(null, safeName);
  },
});

const upload = multer({
  storage,
  limits: {
    files: 1,
  },
  fileFilter: (_req, file, cb) => {
    const allowed = [
      'text/plain',
      'application/pdf',
      'text/csv',
      'application/json',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`Unsupported file type: ${file.mimetype}`));
    }
  },
});

// ─── Schemas ─────────────────────────────────────────────────────────────────

const extractSchema = z.object({
  text: z
    .string()
    .min(10, 'Text must be at least 10 characters'),
  ontologyId: z.string().uuid().optional(),
  discoveryMode: z.enum(['strict', 'discover']).default('discover'),
});

// ─── POST /extract ────────────────────────────────────────────────────────────

router.post(
  '/extract',
  requireAuth,
  validate(extractSchema),
  tokenCost(5, 'kex_extract'),
  async (req: Request, res: Response): Promise<void> => {
    const { text, ontologyId, discoveryMode } = req.body as z.infer<typeof extractSchema>;
    const userId = req.user!.sub;

    try {
      // If ontologyId provided, fetch entity type names for GLiNER
      let entityTypes: string[] | undefined;
      if (ontologyId && discoveryMode === 'strict') {
        // Strict: only use ontology entity types
        const types = await db
          .select({ name: ontologyEntityTypes.name })
          .from(ontologyEntityTypes)
          .where(eq(ontologyEntityTypes.ontologyId, ontologyId));
        if (types.length > 0) {
          entityTypes = types.map((t) => t.name);
        }
      }
      // Discover mode: entityTypes stays undefined → GLiNER uses all 87 defaults + ontology types
      // After extraction completes, new types will be auto-added to the ontology

      const [job] = await db
        .insert(jobs)
        .values({
          userId,
          type: 'kex_extract',
          status: 'pending',
          input: { text, ontologyId, discoveryMode, entityTypes },
        })
        .returning();

      if (!job) {
        res.status(500).json({ error: 'Failed to create job' });
        return;
      }

      await addKexJob(job.id, {
        userId,
        type: 'kex_extract',
        input: { text, entityTypes },
      });

      res.status(202).json({ jobId: job.id, status: 'pending' });
    } catch (err) {
      console.error('[kex/extract]', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// ─── POST /upload ─────────────────────────────────────────────────────────────

router.post(
  '/upload',
  requireAuth,
  (req: Request, res: Response, next: express.NextFunction) => {
    upload.single('file')(req, res, (err: unknown) => {
      if (err instanceof multer.MulterError) {
        res.status(400).json({ error: `Upload error: ${err.message}` });
        return;
      }
      if (err instanceof Error) {
        res.status(400).json({ error: err.message });
        return;
      }
      next();
    });
  },
  tokenCost(5, 'kex_upload'),
  async (req: Request, res: Response): Promise<void> => {
    const userId = req.user!.sub;
    const ontologyId = req.body?.ontologyId as string | undefined;
    const discoveryMode = (req.body?.discoveryMode as string) || 'discover';

    if (!req.file) {
      res.status(400).json({ error: 'No file uploaded' });
      return;
    }

    const { originalname, mimetype, filename, size } = req.file;
    const filePath = path.join(config.uploadDir, filename);

    try {
      // If strict mode + ontologyId, fetch entity types
      let entityTypes: string[] | undefined;
      if (ontologyId && discoveryMode === 'strict') {
        const types = await db
          .select({ name: ontologyEntityTypes.name })
          .from(ontologyEntityTypes)
          .where(eq(ontologyEntityTypes.ontologyId, ontologyId));
        if (types.length > 0) {
          entityTypes = types.map((t) => t.name);
        }
      }

      // Create job in DB
      const [job] = await db
        .insert(jobs)
        .values({
          userId,
          type: 'kex_upload',
          status: 'processing',
          input: {
            originalFilename: originalname,
            mimetype,
            size,
            ontologyId,
            discoveryMode,
            entityTypes,
          },
        })
        .returning();

      if (!job) {
        res.status(500).json({ error: 'Failed to create job' });
        return;
      }

      // Send file as base64 through Redis queue — KEX worker will decode and extract text
      const fileBuffer = fs.readFileSync(filePath);
      const base64Content = fileBuffer.toString('base64');

      // Clean up uploaded file
      fs.unlink(filePath, () => {});

      // Dispatch through Redis queue with file data
      await addKexJob(job.id, {
        userId,
        type: 'kex_upload',
        input: {
          fileBase64: base64Content,
          mimetype,
          originalFilename: originalname,
          entityTypes,
        },
      });

      res.status(202).json({ jobId: job.id, status: 'pending' });
    } catch (err) {
      console.error('[kex/upload]', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// ─── GET /jobs ─────────────────────────────────────────────────────────────────

router.get(
  '/jobs',
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    const userId = req.user!.sub;
    const limit = Math.min(parseInt(req.query['limit'] as string) || 50, 200);
    const offset = parseInt(req.query['offset'] as string) || 0;
    const search = (req.query['search'] as string || '').trim();

    try {
      // Build search condition
      const baseWhere = eq(jobs.userId, userId);

      // Get standalone jobs (no batch) + batch summary objects
      const standaloneJobs = await db
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
          batchId: jobs.batchId,
        })
        .from(jobs)
        .where(and(baseWhere, isNull(jobs.batchId)))
        .orderBy(desc(jobs.createdAt))
        .limit(limit)
        .offset(offset);

      // Get batches for this user
      const userBatches = await db
        .select()
        .from(jobBatches)
        .where(eq(jobBatches.userId, userId))
        .orderBy(desc(jobBatches.createdAt))
        .limit(limit);

      // Get total count for pagination
      const [countResult] = await db
        .select({ count: sql<number>`count(*)` })
        .from(jobs)
        .where(and(baseWhere, isNull(jobs.batchId)));

      const total = countResult?.count ?? 0;

      res.json({
        jobs: standaloneJobs,
        batches: userBatches,
        total,
        hasMore: offset + limit < total,
      });
    } catch (err) {
      console.error('[kex/jobs]', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// ─── GET /batches/:id/jobs ───────────────────────────────────────────────────

router.get(
  '/batches/:id/jobs',
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    const userId = req.user!.sub;
    const batchId = req.params['id'];

    if (!batchId) {
      res.status(400).json({ error: 'Batch ID is required' });
      return;
    }

    try {
      const batchJobs = await db
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
          batchId: jobs.batchId,
        })
        .from(jobs)
        .where(and(eq(jobs.userId, userId), eq(jobs.batchId, batchId)))
        .orderBy(desc(jobs.createdAt));

      res.json({ jobs: batchJobs });
    } catch (err) {
      console.error('[kex/batches/:id/jobs]', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// ─── GET /queue ──────────────────────────────────────────────────────────────

router.get(
  '/queue',
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    const userId = req.user!.sub;
    try {
      const { getQueueDepth, getWorkerThreads } = await import('../services/queue.js');
      const depth = await getQueueDepth();
      const threads = await getWorkerThreads();

      // Get pending + processing jobs for queue view
      const pendingJobs = await db
        .select({
          id: jobs.id,
          type: jobs.type,
          status: jobs.status,
          input: jobs.input,
          createdAt: jobs.createdAt,
          batchId: jobs.batchId,
        })
        .from(jobs)
        .where(and(
          eq(jobs.userId, userId),
          or(eq(jobs.status, 'pending'), eq(jobs.status, 'processing')),
        ))
        .orderBy(jobs.createdAt);

      res.json({ depth, threads, pendingJobs });
    } catch (err) {
      res.json({ depth: 0, threads: 1, pendingJobs: [] });
    }
  }
);

// ─── PUT /threads ────────────────────────────────────────────────────────────

router.put(
  '/threads',
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    const threads = Math.max(1, Math.min(10, parseInt(req.body.threads) || 1));
    try {
      const { setWorkerThreads } = await import('../services/queue.js');
      await setWorkerThreads(threads);
      res.json({ ok: true, threads });
    } catch (err) {
      res.status(500).json({ error: 'Failed to set threads' });
    }
  }
);

// ─── GET /jobs/:id ─────────────────────────────────────────────────────────────

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
          error: jobs.error,
          createdAt: jobs.createdAt,
          updatedAt: jobs.updatedAt,
          completedAt: jobs.completedAt,
        })
        .from(jobs)
        .where(and(eq(jobs.id, jobId), eq(jobs.userId, userId)))
        .limit(1);

      if (!job) {
        res.status(404).json({ error: 'Job not found' });
        return;
      }

      res.json({ job });
    } catch (err) {
      console.error('[kex/jobs/:id]', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// ─── GET /jobs/:id/result ──────────────────────────────────────────────────────

router.get(
  '/jobs/:id/result',
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
          status: jobs.status,
          result: jobs.result,
          error: jobs.error,
          completedAt: jobs.completedAt,
        })
        .from(jobs)
        .where(and(eq(jobs.id, jobId), eq(jobs.userId, userId)))
        .limit(1);

      if (!job) {
        res.status(404).json({ error: 'Job not found' });
        return;
      }

      if (job.status === 'pending' || job.status === 'processing') {
        res.status(202).json({ status: job.status, message: 'Job is still processing' });
        return;
      }

      if (job.status === 'failed') {
        res.status(422).json({
          status: 'failed',
          error: job.error ?? 'Job failed without error message',
        });
        return;
      }

      // Completed
      const result = job.result as Record<string, unknown> | null;

      res.json({
        jobId: job.id,
        status: job.status,
        completedAt: job.completedAt,
        result: {
          entities: result?.['entities'] ?? [],
          relations: result?.['relations'] ?? [],
          graphStats: result?.['graphStats'] ?? {
            nodes: 0,
            edges: 0,
            components: 0,
          },
          raw: result,
        },
      });
    } catch (err) {
      console.error('[kex/jobs/:id/result]', err);
      res.status(500).json({ error: 'Internal server error' });
    }
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
      console.error('[kex/jobs/:id/cancel]', err);
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
      console.error('[kex/jobs/:id DELETE]', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

export default router;
