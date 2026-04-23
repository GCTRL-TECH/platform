import { Router, Request, Response } from 'express';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../models/db.js';
import { jobs, jobBatches } from '../models/schema.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { tokenCost } from '../middleware/tokenMeter.js';
import { addKexJob } from '../services/queue.js';
import {
  listPostgresTables, queryPostgres,
  listMysqlTables, queryMysql,
  listMongoCollections, queryMongo,
  queryResultToText,
  type DatabaseConfig,
} from '../connectors/database.js';

const router = Router();

// ─── Schemas ─────────────────────────────────────────────────────────────────

const dbConfigSchema = z.object({
  type: z.enum(['postgresql', 'mysql', 'mongodb']),
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  database: z.string().min(1),
  username: z.string().min(1),
  password: z.string(),
  ssl: z.boolean().optional().default(false),
});

const syncTablesSchema = z.object({
  config: dbConfigSchema,
  tables: z.array(z.string()).min(1),
  rowLimit: z.number().int().min(1).max(10000).optional().default(1000),
  ontologyId: z.string().uuid().optional(),
  discoveryMode: z.enum(['discover', 'strict']).optional().default('discover'),
  compilationId: z.string().uuid().optional(),
});

// ─── POST /test-connection ───────────────────────────────────────────────────

router.post(
  '/test-connection',
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    const config = req.body.config as DatabaseConfig;
    if (!config?.type || !config?.host) {
      res.status(400).json({ error: 'Database config required' });
      return;
    }

    try {
      let tables;
      if (config.type === 'postgresql') tables = await listPostgresTables(config);
      else if (config.type === 'mysql') tables = await listMysqlTables(config);
      else if (config.type === 'mongodb') tables = await listMongoCollections(config);
      else { res.status(400).json({ error: `Unsupported type: ${config.type}` }); return; }

      res.json({ ok: true, tables, tableCount: tables.length });
    } catch (err) {
      res.status(400).json({ ok: false, error: (err as Error).message });
    }
  },
);

// ─── POST /list-tables ───────────────────────────────────────────────────────

router.post(
  '/list-tables',
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    const config = req.body.config as DatabaseConfig;

    try {
      let tables;
      if (config.type === 'postgresql') tables = await listPostgresTables(config);
      else if (config.type === 'mysql') tables = await listMysqlTables(config);
      else if (config.type === 'mongodb') tables = await listMongoCollections(config);
      else { res.status(400).json({ error: `Unsupported type: ${config.type}` }); return; }

      res.json({ tables });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  },
);

// ─── POST /sync ──────────────────────────────────────────────────────────────
// Extract data from selected tables into KEX

router.post(
  '/sync',
  requireAuth,
  requireRole('analyst', 'editor', 'admin'),
  validate(syncTablesSchema),
  tokenCost(5, 'db_sync'),
  async (req: Request, res: Response): Promise<void> => {
    const userId = req.user!.sub;
    const { config, tables, rowLimit, ontologyId, discoveryMode, compilationId } = req.body as z.infer<typeof syncTablesSchema>;

    try {
      // Create batch
      const [batch] = await db.insert(jobBatches).values({
        userId,
        name: `DB: ${config.host}/${config.database} (${tables.length} tables)`,
        source: `db_${config.type}`,
        sourceMetadata: { host: config.host, database: config.database, type: config.type, compilationId },
        totalJobs: tables.length,
        status: 'processing',
      }).returning();

      const batchId = batch!.id;
      const results: Array<{ table: string; jobId?: string; rows?: number; error?: string }> = [];

      for (const tableName of tables) {
        try {
          let queryResult;
          if (config.type === 'postgresql') {
            queryResult = await queryPostgres(config, `SELECT * FROM "${tableName}"`, rowLimit);
          } else if (config.type === 'mysql') {
            queryResult = await queryMysql(config, `SELECT * FROM \`${tableName}\``, rowLimit);
          } else if (config.type === 'mongodb') {
            queryResult = await queryMongo(config, tableName, {}, rowLimit);
          } else {
            results.push({ table: tableName, error: 'Unsupported DB type' });
            continue;
          }

          const text = queryResultToText(queryResult, tableName);

          if (text.length < 50) {
            results.push({ table: tableName, rows: 0, error: 'Table empty or too small' });
            continue;
          }

          const [job] = await db.insert(jobs).values({
            userId,
            type: 'kex_extract',
            status: 'pending',
            batchId,
            input: {
              source: `db_${config.type}`,
              fileName: `${config.database}.${tableName}`,
              host: config.host,
              database: config.database,
              table: tableName,
              ...(ontologyId ? { ontologyId, discoveryMode } : {}),
              ...(compilationId ? { compilationId } : {}),
            },
          }).returning();

          await addKexJob(job!.id, {
            userId,
            type: 'kex_extract',
            input: {
              text,
              ...(ontologyId ? { ontologyId, discoveryMode } : {}),
            },
          });

          results.push({ table: tableName, jobId: job!.id, rows: queryResult.rowCount });
        } catch (err) {
          results.push({ table: tableName, error: (err as Error).message });
        }
      }

      // Update batch
      const synced = results.filter((r) => r.jobId).length;
      const failed = results.filter((r) => r.error).length;
      await db.update(jobBatches).set({
        totalJobs: synced,
        failedJobs: failed,
        status: synced === 0 ? 'failed' : 'processing',
        updatedAt: new Date(),
      }).where(eq(jobBatches.id, batchId));

      res.json({ batchId, synced, failed, results });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  },
);

export default router;
