/**
 * Prometheus-compatible metrics endpoint.
 * Exposes basic application metrics for monitoring.
 */

import { Router, Request, Response } from 'express';
import { sql } from 'drizzle-orm';
import { db } from '../models/db.js';
import { jobs, users, compilations, triggers } from '../models/schema.js';

const router = Router();

// Simple counter for tracking
let requestCount = 0;
const startTime = Date.now();

export function incrementRequestCount() {
  requestCount++;
}

router.get('/', async (_req: Request, res: Response): Promise<void> => {
  try {
    // Collect metrics from database
    const [jobStats] = await db.select({
      total: sql<number>`count(*)`,
      pending: sql<number>`count(*) filter (where status = 'pending')`,
      processing: sql<number>`count(*) filter (where status = 'processing')`,
      completed: sql<number>`count(*) filter (where status = 'completed')`,
      failed: sql<number>`count(*) filter (where status = 'failed')`,
    }).from(jobs);

    const [userCount] = await db.select({ count: sql<number>`count(*)` }).from(users);
    const [compCount] = await db.select({ count: sql<number>`count(*)` }).from(compilations);
    const [triggerCount] = await db.select({ count: sql<number>`count(*)` }).from(triggers);

    const uptimeSeconds = Math.floor((Date.now() - startTime) / 1000);

    // Output in Prometheus text format
    const lines = [
      '# HELP GCTRL_uptime_seconds Time since API started',
      '# TYPE GCTRL_uptime_seconds gauge',
      `GCTRL_uptime_seconds ${uptimeSeconds}`,
      '',
      '# HELP GCTRL_requests_total Total HTTP requests handled',
      '# TYPE GCTRL_requests_total counter',
      `GCTRL_requests_total ${requestCount}`,
      '',
      '# HELP GCTRL_users_total Total registered users',
      '# TYPE GCTRL_users_total gauge',
      `GCTRL_users_total ${userCount?.count ?? 0}`,
      '',
      '# HELP GCTRL_compilations_total Total knowledge graph compilations',
      '# TYPE GCTRL_compilations_total gauge',
      `GCTRL_compilations_total ${compCount?.count ?? 0}`,
      '',
      '# HELP GCTRL_triggers_total Total active triggers',
      '# TYPE GCTRL_triggers_total gauge',
      `GCTRL_triggers_total ${triggerCount?.count ?? 0}`,
      '',
      '# HELP GCTRL_jobs_total Total jobs by status',
      '# TYPE GCTRL_jobs_total gauge',
      `GCTRL_jobs_total{status="pending"} ${jobStats?.pending ?? 0}`,
      `GCTRL_jobs_total{status="processing"} ${jobStats?.processing ?? 0}`,
      `GCTRL_jobs_total{status="completed"} ${jobStats?.completed ?? 0}`,
      `GCTRL_jobs_total{status="failed"} ${jobStats?.failed ?? 0}`,
      '',
      '# HELP GCTRL_jobs_sum Total jobs ever created',
      '# TYPE GCTRL_jobs_sum counter',
      `GCTRL_jobs_sum ${jobStats?.total ?? 0}`,
      '',
    ];

    res.set('Content-Type', 'text/plain; version=0.0.4');
    res.send(lines.join('\n'));
  } catch (err) {
    res.status(500).send('# Error collecting metrics\n');
  }
});

export default router;

