import express from 'express';
import cors from 'cors';
import helmet from 'helmet';

import { eq, sql } from 'drizzle-orm';
import { config } from './config.js';
import { pool, db } from './models/db.js';
import { jobs, compilations, ontologyEntityTypes, ontologies, connectorSyncJobs } from './models/schema.js';
import { getDriver, closeDriver } from './services/neo4j.js';
import { closeQueue, subscribeToResults } from './services/queue.js';
import { generalLimiter, authLimiter } from './middleware/rateLimit.js';
import { triggerCompilationRefresh } from './services/compilation-refresh.js';
import { updateBatchProgress } from './services/sync-engine.js';

import authRouter from './routes/auth.js';
import kexRouter from './routes/kex.js';
import fuseRouter from './routes/fuse.js';
import kgRouter from './routes/kg.js';
import usersRouter from './routes/users.js';
import keysRouter from './routes/keys.js';
import ontologiesRouter from './routes/ontologies.js';
import ragRouter from './routes/rag.js';
import foldersRouter from './routes/folders.js';
import connectorsRouter from './routes/connectors.js';
import billingRouter from './routes/billing.js';
import adminRouter from './routes/admin.js';
import triggersRouter from './routes/triggers.js';
import metricsRouter from './routes/metrics.js';
import crawlerRouter from './routes/crawler.js';
import databaseRouter from './routes/database.js';
import sourcesRouter from './routes/sources.js';
import { initHeartbeat, stopHeartbeat } from './services/heartbeat.js';

const app = express();

// ─── Security middleware ──────────────────────────────────────────────────────

app.use(
  helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  })
);

app.use(
  cors({
    origin: config.frontendUrl,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })
);

// ─── Body parsing ─────────────────────────────────────────────────────────────

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ─── Rate limiting ────────────────────────────────────────────────────────────

app.use(generalLimiter);

// ─── Health check ─────────────────────────────────────────────────────────────

app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    version: '0.1.0',
    timestamp: new Date().toISOString(),
  });
});

// ─── Routes ───────────────────────────────────────────────────────────────────

app.use('/api/auth', authLimiter, authRouter);
app.use('/api/kex', kexRouter);
app.use('/api/fuse', fuseRouter);
app.use('/api/kg', kgRouter);
app.use('/api/users', usersRouter);
app.use('/api/keys', keysRouter);
app.use('/api/ontologies', ontologiesRouter);
app.use('/api/rag', ragRouter);
app.use('/api/kg/folders', foldersRouter);
app.use('/api/connectors', connectorsRouter);
app.use('/api/billing', billingRouter);
app.use('/api/admin', adminRouter);
app.use('/api/triggers', triggersRouter);
app.use('/api/metrics', metricsRouter);
app.use('/api/crawler', crawlerRouter);
app.use('/api/database', databaseRouter);
app.use('/api/sources', sourcesRouter);

// ─── 404 handler ─────────────────────────────────────────────────────────────

app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// ─── Global error handler ─────────────────────────────────────────────────────

app.use(
  (
    err: Error,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction
  ) => {
    console.error('[Unhandled error]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
);

// ─── Startup ──────────────────────────────────────────────────────────────────

const start = async () => {
  // Verify DB connection
  try {
    const client = await pool.connect();
    await client.query('SELECT 1');
    client.release();
    console.log('[DB] PostgreSQL connected');
  } catch (err) {
    console.error('[DB] Failed to connect to PostgreSQL:', err);
    process.exit(1);
  }

  // Verify Neo4j connection (non-fatal in dev)
  try {
    await getDriver().verifyConnectivity();
    console.log('[Neo4j] Connected');
  } catch (err) {
    console.warn('[Neo4j] Connection failed (non-fatal):', err);
  }

  // Subscribe to KEX job results from Redis
  try {
    await subscribeToResults(async (result) => {
      const jobId = result.job_id;
      console.log(`[Queue] Received result for job ${jobId}: ${result.status}`);

      try {
        // Handle 'processing' status — just update DB and return early
        if (result.status === 'processing') {
          await db.update(jobs).set({ status: 'processing', updatedAt: new Date() }).where(eq(jobs.id, jobId));
          return;
        }

        if (result.status === 'completed') {
          await db
            .update(jobs)
            .set({
              status: 'completed',
              result: result.result ?? {},
              updatedAt: new Date(),
              completedAt: new Date(),
            })
            .where(eq(jobs.id, jobId));

          // If this is a KEX job with discover mode + ontologyId, auto-add new entity types
          try {
            const [completedJob] = await db
              .select({ input: jobs.input, type: jobs.type, userId: jobs.userId })
              .from(jobs)
              .where(eq(jobs.id, jobId))
              .limit(1);

            const jobInput = completedJob?.input as Record<string, unknown> | null;
            const ontologyId = jobInput?.['ontologyId'] as string | undefined;
            const discoveryMode = jobInput?.['discoveryMode'] as string | undefined;

            if (ontologyId && discoveryMode === 'discover' && result.result) {
              const entities = (result.result as Record<string, unknown>)['entities'] as Array<{ label?: string; gliner_label?: string; type?: string }> | undefined;
              if (entities && entities.length > 0) {
                // Get existing types in this ontology
                const existing = await db
                  .select({ name: ontologyEntityTypes.name })
                  .from(ontologyEntityTypes)
                  .where(eq(ontologyEntityTypes.ontologyId, ontologyId));
                const existingNames = new Set(existing.map((t) => t.name.toLowerCase()));

                // Find new types from extraction results
                const newTypes = new Map<string, { label: string; qid: string }>();
                for (const e of entities) {
                  const label = e.gliner_label || e.label || '';
                  const qid = e.type || '';
                  if (label && !existingNames.has(label.toLowerCase()) && !newTypes.has(label.toLowerCase())) {
                    newTypes.set(label.toLowerCase(), { label, qid });
                  }
                }

                // Auto-add new types to ontology
                if (newTypes.size > 0) {
                  for (const [, { label, qid }] of newTypes) {
                    try {
                      await db.insert(ontologyEntityTypes).values({
                        ontologyId,
                        name: label,
                        qid: qid || null,
                        description: `Auto-discovered from extraction`,
                      }).onConflictDoNothing();
                    } catch { /* ignore duplicates */ }
                  }
                  // Update entity type count
                  const countResult = await db
                    .select({ name: ontologyEntityTypes.name })
                    .from(ontologyEntityTypes)
                    .where(eq(ontologyEntityTypes.ontologyId, ontologyId));
                  await db
                    .update(ontologies)
                    .set({ entityTypeCount: countResult.length, updatedAt: new Date() })
                    .where(eq(ontologies.id, ontologyId));

                  console.log(`[Queue] Auto-added ${newTypes.size} new entity types to ontology ${ontologyId}`);
                }
              }
            }
            // Auto-FUSE: if job has compilationId, add it to the compilation's sourceJobIds
            if (completedJob?.type === 'kex_extract' || completedJob?.type === 'kex_upload') {
              const jobCompilationId = jobInput?.['compilationId'] as string | undefined;
              const jobForceSingle = jobInput?.['forceSingleGraphs'] as boolean | undefined;
              const jobFileName = jobInput?.['fileName'] as string | undefined;

              if (jobCompilationId && !jobForceSingle) {
                // Add this job to the target compilation's source list
                try {
                  const { sql: sqlTag } = await import('drizzle-orm');
                  await db.update(compilations).set({
                    sourceJobIds: sqlTag`array_append(${compilations.sourceJobIds}, ${jobId}::uuid)` as unknown as string[],
                    updatedAt: new Date(),
                  }).where(eq(compilations.id, jobCompilationId));
                  console.log(`[Queue] Auto-FUSE: added job ${jobId} to compilation ${jobCompilationId}`);
                } catch (fuseErr) {
                  console.error('[Queue] Auto-FUSE failed (non-fatal):', fuseErr);
                }
              } else if (jobCompilationId && jobForceSingle) {
                // Force single graphs: create a new standalone compilation per file
                try {
                  await db.insert(compilations).values({
                    userId: completedJob.userId,
                    name: jobFileName || `Extraction ${jobId.slice(0, 8)}`,
                    sourceJobIds: [jobId] as unknown as string[],
                    classification: 'INTERNAL',
                    version: 1,
                  });
                  console.log(`[Queue] Force-single: created standalone compilation for ${jobFileName}`);
                } catch (fuseErr) {
                  console.error('[Queue] Force-single failed (non-fatal):', fuseErr);
                }
              }

              // Trigger compilation refresh (finds compilations using this job, queues FUSE merge)
              setImmediate(() => void triggerCompilationRefresh(jobId));
            }
          } catch (err) {
            console.error('[Queue] Ontology auto-add failed (non-fatal):', err);
          }

          // If this is a fuse job, update the compilation stats
          const compilationId = (result as Record<string, unknown>).compilation_id as string | undefined;
          if (compilationId && result.result) {
            const r = result.result as Record<string, unknown>;
            const nodeCount = (r['nodes_total'] ?? 0) as number;
            const edgeCount = (r['relations_merged'] ?? 0) as number;
            const entityCount = (r['entities_merged'] ?? 0) as number;
            const duplicateCount = (r['duplicates_found'] ?? 0) as number;
            const linkCount = (r['total_links'] ?? 0) as number;
            await db
              .update(compilations)
              .set({
                nodeCount,
                edgeCount,
                entityCount,
                duplicateCount,
                linkCount,
                lastRefreshAt: new Date(),
                updatedAt: new Date(),
              })
              .where(eq(compilations.id, compilationId));
            console.log(`[Queue] Updated compilation ${compilationId}: ${nodeCount} nodes, ${edgeCount} edges`);
          }

        } else {
          await db
            .update(jobs)
            .set({
              status: 'failed',
              error: result.error ?? 'Unknown error',
              updatedAt: new Date(),
              completedAt: new Date(),
            })
            .where(eq(jobs.id, jobId));
        }
        // Update batch progress if this job belongs to a batch
        try {
          const [jobRow] = await db
            .select({ batchId: jobs.batchId })
            .from(jobs)
            .where(eq(jobs.id, jobId))
            .limit(1);
          if (jobRow?.batchId) {
            await updateBatchProgress(jobRow.batchId);
          }
        } catch (batchErr) {
          console.error(`[Queue] Batch progress update failed (non-fatal):`, batchErr);
        }

        // Update connector_sync_jobs status to match the KEX job result
        try {
          const newSyncStatus = result.status === 'completed' ? 'completed' : 'failed';
          await db.update(connectorSyncJobs).set({
            status: newSyncStatus,
            updatedAt: new Date(),
          }).where(eq(connectorSyncJobs.kexJobId, jobId));
        } catch {
          // non-fatal — not all jobs have a sync job entry
        }

      } catch (err) {
        console.error(`[Queue] Failed to update job ${jobId}:`, err);
      }
    });
  } catch (err) {
    console.warn('[Queue] Failed to subscribe to results:', err);
  }

  // Recover stale jobs — only fail jobs stuck for >1 hour (crawls can take 30+ min for large sites)
  try {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    await db.update(jobs).set({
      status: 'failed',
      error: 'Worker timeout — job was stuck for >1 hour',
      completedAt: new Date(),
      updatedAt: new Date(),
    }).where(sql`${jobs.status} IN ('pending', 'processing') AND ${jobs.createdAt} < ${oneHourAgo}`);
    // Fix orphaned batches
    await db.execute(sql`
      UPDATE job_batches SET
        status = CASE
          WHEN (SELECT count(*) FROM jobs WHERE jobs.batch_id = job_batches.id AND jobs.status = 'failed') > 0
           AND (SELECT count(*) FROM jobs WHERE jobs.batch_id = job_batches.id AND jobs.status = 'completed') > 0 THEN 'partial_failure'
          WHEN (SELECT count(*) FROM jobs WHERE jobs.batch_id = job_batches.id AND jobs.status = 'failed') > 0 THEN 'failed'
          ELSE 'completed'
        END,
        completed_jobs = (SELECT count(*) FROM jobs WHERE jobs.batch_id = job_batches.id AND jobs.status = 'completed'),
        failed_jobs = (SELECT count(*) FROM jobs WHERE jobs.batch_id = job_batches.id AND jobs.status = 'failed'),
        updated_at = NOW()
      WHERE status = 'processing'
      AND NOT EXISTS (SELECT 1 FROM jobs WHERE jobs.batch_id = job_batches.id AND jobs.status IN ('pending', 'processing'))
    `);
    // Fix stuck sync jobs
    await db.execute(sql`
      UPDATE connector_sync_jobs SET status = 'failed', updated_at = NOW()
      WHERE status = 'processing' AND created_at < ${oneHourAgo}
    `);
    console.log('[Startup] Stale job recovery complete');
  } catch (err) {
    console.warn('[Startup] Stale job recovery failed:', err);
  }

  // Periodic batch reconciliation — every 30s, fix any batch whose progress is stale
  setInterval(async () => {
    try {
      await db.execute(sql`
        UPDATE job_batches SET
          completed_jobs = (SELECT count(*) FROM jobs WHERE jobs.batch_id = job_batches.id AND jobs.status = 'completed'),
          failed_jobs = (SELECT count(*) FROM jobs WHERE jobs.batch_id = job_batches.id AND jobs.status = 'failed'),
          status = CASE
            WHEN (SELECT count(*) FROM jobs WHERE jobs.batch_id = job_batches.id AND jobs.status IN ('pending', 'processing')) > 0 THEN 'processing'
            WHEN (SELECT count(*) FROM jobs WHERE jobs.batch_id = job_batches.id AND jobs.status = 'failed') > 0
             AND (SELECT count(*) FROM jobs WHERE jobs.batch_id = job_batches.id AND jobs.status = 'completed') > 0 THEN 'partial_failure'
            WHEN (SELECT count(*) FROM jobs WHERE jobs.batch_id = job_batches.id AND jobs.status = 'failed') > 0 THEN 'failed'
            ELSE 'completed'
          END,
          updated_at = NOW()
        WHERE status = 'processing'
      `);
    } catch { /* non-fatal */ }
  }, 30_000);

  // Initialize unified heartbeat (drives all triggers)
  try {
    await initHeartbeat();
  } catch (err) {
    console.warn('[Heartbeat] Init failed (non-fatal):', err);
  }

  app.listen(config.port, () => {
    console.log(`[API] GCTRL API running on port ${config.port}`);
    console.log(`[API] Health: http://localhost:${config.port}/api/health`);
    console.log(`[API] Environment: ${config.nodeEnv}`);
  });
};

// ─── Graceful shutdown ────────────────────────────────────────────────────────

const shutdown = async (signal: string) => {
  console.log(`[API] Received ${signal}, shutting down gracefully...`);

  stopHeartbeat();

  try {
    await closeQueue();
    console.log('[Queue] Closed');
  } catch (err) {
    console.error('[Queue] Close error:', err);
  }

  try {
    await closeDriver();
    console.log('[Neo4j] Driver closed');
  } catch (err) {
    console.error('[Neo4j] Close error:', err);
  }

  try {
    await pool.end();
    console.log('[DB] Pool closed');
  } catch (err) {
    console.error('[DB] Pool close error:', err);
  }

  process.exit(0);
};

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

start().catch((err) => {
  console.error('[API] Fatal startup error:', err);
  process.exit(1);
});

export default app;

