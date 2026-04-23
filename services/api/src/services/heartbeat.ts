/**
 * Unified Heartbeat — single timer that drives ALL scheduled triggers.
 *
 * Instead of one setInterval per trigger, one heartbeat ticks at a configurable
 * interval and processes every trigger whose nextRunAt <= now. This is the only
 * scheduling mechanism in the system — like a lightweight cron daemon.
 *
 * Heartbeat interval is stored in Redis (triggers:heartbeat:interval) and
 * configurable via the Triggers management page.
 */

import { eq, and, lte, isNotNull } from 'drizzle-orm';
import { db } from '../models/db.js';
import { triggers, compilations } from '../models/schema.js';
import { syncFolderIncremental } from './sync-engine.js';
import { addFuseJob } from './queue.js';
import { createClient } from 'redis';
import { config } from '../config.js';

type TriggerRow = typeof triggers.$inferSelect;

const DEFAULT_INTERVAL_MS = 60_000; // 1 minute

// ─── Next run calculation ────────────────────────────────────────────────────

export function nextRunFromCron(cron: string, after: Date = new Date()): Date {
  const parts = cron.trim().split(/\s+/);
  if (parts.length < 5) return new Date(after.getTime() + 24 * 60 * 60 * 1000); // fallback: 24h

  const [minPart, hourPart] = parts;

  // Every N minutes: */N * * * *
  if (minPart?.startsWith('*/') && hourPart === '*') {
    const n = parseInt(minPart.slice(2));
    if (n > 0) return new Date(after.getTime() + n * 60 * 1000);
  }

  // Every minute: * * * * *
  if (minPart === '*' && hourPart === '*') {
    return new Date(after.getTime() + 60 * 1000);
  }

  // Every N hours: 0 */N * * * or M */N * * *
  if (hourPart?.startsWith('*/')) {
    const n = parseInt(hourPart.slice(2));
    if (n > 0) return new Date(after.getTime() + n * 60 * 60 * 1000);
  }

  // Hourly at specific minute: M * * * *
  if (minPart && !minPart.includes('*') && hourPart === '*') {
    const targetMin = parseInt(minPart);
    const next = new Date(after);
    next.setMinutes(targetMin, 0, 0);
    if (next <= after) next.setHours(next.getHours() + 1);
    return next;
  }

  // Daily at specific time: M H * * *
  if (minPart && !minPart.includes('*') && hourPart && !hourPart.includes('*')) {
    const targetMin = parseInt(minPart);
    const targetHour = parseInt(hourPart);
    const next = new Date(after);
    next.setHours(targetHour, targetMin, 0, 0);
    if (next <= after) next.setDate(next.getDate() + 1);
    return next;
  }

  // Fallback: 24 hours
  return new Date(after.getTime() + 24 * 60 * 60 * 1000);
}

// ─── Heartbeat class ─────────────────────────────────────────────────────────

class Heartbeat {
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private intervalMs: number = DEFAULT_INTERVAL_MS;
  private lastTickAt: Date | null = null;
  private lastTickDurationMs: number | null = null;
  private isTicking = false;
  private redisClient: ReturnType<typeof createClient> | null = null;

  async init(): Promise<void> {
    // Connect to Redis for config
    try {
      this.redisClient = createClient({ url: config.redisUrl });
      await this.redisClient.connect();
      const stored = await this.redisClient.get('triggers:heartbeat:interval');
      if (stored) this.intervalMs = Math.max(1000, parseInt(stored, 10));
    } catch {
      // Redis not available, use default
    }

    // Ensure all active triggers have nextRunAt set
    await this.initializeNextRunDates();

    // Migrate compilation cron schedules to triggers (one-time)
    await this.migrateCompilationCrons();

    // Start ticking
    this.startLoop();
    console.log(`[Heartbeat] Started — tick every ${this.intervalMs / 1000}s`);
  }

  private startLoop(): void {
    if (this.intervalId) clearInterval(this.intervalId);
    this.intervalId = setInterval(() => void this.tick(), this.intervalMs);
    // First tick after 5s to let startup complete
    setTimeout(() => void this.tick(), 5000);
  }

  async tick(): Promise<void> {
    const tickStart = Date.now();
    this.isTicking = true;
    this.lastTickAt = new Date();
    try {
      // Find all active triggers that are due
      const dueTriggers = await db
        .select()
        .from(triggers)
        .where(and(
          eq(triggers.status, 'active'),
          isNotNull(triggers.nextRunAt),
          lte(triggers.nextRunAt, new Date()),
        ));

      if (dueTriggers.length === 0) return;

      console.log(`[Heartbeat] ${dueTriggers.length} trigger(s) due`);

      for (const trigger of dueTriggers) {
        try {
          await this.executeTrigger(trigger);
        } catch (err) {
          console.error(`[Heartbeat] Trigger "${trigger.name}" failed:`, err);
          await db.update(triggers).set({
            lastRunAt: new Date(),
            lastError: (err as Error).message,
            nextRunAt: trigger.cronSchedule ? nextRunFromCron(trigger.cronSchedule) : null,
            updatedAt: new Date(),
          }).where(eq(triggers.id, trigger.id));
        }
      }
    } catch (err) {
      console.error('[Heartbeat] Tick error:', err);
    } finally {
      this.lastTickDurationMs = Date.now() - tickStart;
      this.isTicking = false;
    }
  }

  async executeTrigger(trigger: TriggerRow): Promise<void> {
    const cfg = trigger.config as Record<string, unknown>;
    let didWork = false;

    if (trigger.module === 'kex') {
      // KEX triggers: folder sync (dedup handles change detection)
      if (cfg.connectorId && cfg.folderId) {
        const result = await syncFolderIncremental({
          connectorId: cfg.connectorId as string,
          folderId: cfg.folderId as string,
          userId: trigger.userId,
          ontologyId: cfg.ontologyId as string | undefined,
          discoveryMode: (cfg.discoveryMode as string) || 'discover',
          batchName: `Trigger: ${trigger.name}`,
          triggerId: trigger.id,
          compilationId: cfg.compilationId as string | undefined,
          forceSingleGraphs: cfg.forceSingleGraphs as boolean | undefined,
        });
        didWork = result.synced > 0;
        if (didWork) {
          console.log(`[Heartbeat] "${trigger.name}": ${result.synced} files synced`);
        }
      }
    } else if (trigger.module === 'compilation' || trigger.module === 'fuse') {
      // Compilation/FUSE refresh trigger
      const compilationId = cfg.compilationId as string;
      if (compilationId) {
        const [comp] = await db.select().from(compilations).where(eq(compilations.id, compilationId)).limit(1);
        if (comp) {
          const sourceJobIds = (comp.sourceJobIds ?? []) as string[];
          if (sourceJobIds.length > 0) {
            const { jobs: jobsTable } = await import('../models/schema.js');
            const [job] = await db.insert(jobsTable).values({
              userId: trigger.userId,
              type: 'fuse_merge',
              status: 'pending',
              triggerId: trigger.id,
              input: { compilationId, sourceJobIds, name: comp.name, mode: 'incremental', triggeredBy: 'heartbeat' },
            }).returning();
            if (job) {
              await addFuseJob(job.id, {
                userId: trigger.userId,
                compilationId,
                sourceJobIds,
                name: comp.name,
              });
            }
          }
        }
      }
    }

    // Update trigger: always set lastRunAt + nextRunAt, only increment runCount if work was done
    const nextRun = trigger.type === 'change_detection'
      ? new Date() // always due on next heartbeat tick
      : trigger.cronSchedule ? nextRunFromCron(trigger.cronSchedule) : null;
    await db.update(triggers).set({
      lastRunAt: new Date(),
      runCount: didWork ? trigger.runCount + 1 : trigger.runCount,
      lastError: null,
      nextRunAt: nextRun,
      updatedAt: new Date(),
    }).where(eq(triggers.id, trigger.id));
  }

  private async initializeNextRunDates(): Promise<void> {
    // Set nextRunAt for active triggers that don't have one
    const unscheduled = await db
      .select({ id: triggers.id, cronSchedule: triggers.cronSchedule })
      .from(triggers)
      .where(and(eq(triggers.status, 'active'), eq(triggers.nextRunAt, null as unknown as Date)));

    for (const t of unscheduled) {
      if (t.cronSchedule) {
        await db.update(triggers).set({
          nextRunAt: nextRunFromCron(t.cronSchedule),
        }).where(eq(triggers.id, t.id));
      }
    }

    if (unscheduled.length > 0) {
      console.log(`[Heartbeat] Initialized nextRunAt for ${unscheduled.length} trigger(s)`);
    }
  }

  private async migrateCompilationCrons(): Promise<void> {
    // Migrate compilations with cronSchedule to triggers table (one-time)
    try {
      const cronComps = await db
        .select({ id: compilations.id, name: compilations.name, userId: compilations.userId, cronSchedule: compilations.cronSchedule, cronMode: compilations.cronMode })
        .from(compilations)
        .where(isNotNull(compilations.cronSchedule));

      for (const comp of cronComps) {
        if (!comp.cronSchedule) continue;
        // Check if trigger already exists for this compilation
        const [existing] = await db
          .select({ id: triggers.id })
          .from(triggers)
          .where(and(eq(triggers.module, 'compilation'), eq(triggers.name, `Compilation: ${comp.name}`)))
          .limit(1);

        if (!existing) {
          await db.insert(triggers).values({
            userId: comp.userId,
            name: `Compilation: ${comp.name}`,
            module: 'compilation',
            type: 'cron',
            status: 'active',
            cronSchedule: comp.cronSchedule,
            config: { compilationId: comp.id, mode: comp.cronMode || 'incremental' },
            nextRunAt: nextRunFromCron(comp.cronSchedule),
          });
          console.log(`[Heartbeat] Migrated compilation "${comp.name}" cron to trigger`);
        }
      }
    } catch (err) {
      console.warn('[Heartbeat] Compilation migration failed (non-fatal):', err);
    }
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  getStatus(): { intervalMs: number; lastTickAt: string | null; lastTickDurationMs: number | null; isTicking: boolean } {
    return {
      intervalMs: this.intervalMs,
      lastTickAt: this.lastTickAt?.toISOString() ?? null,
      lastTickDurationMs: this.lastTickDurationMs,
      isTicking: this.isTicking,
    };
  }

  async setHeartbeatInterval(ms: number): Promise<void> {
    this.intervalMs = Math.max(1000, ms);
    if (this.redisClient) {
      await this.redisClient.set('triggers:heartbeat:interval', String(this.intervalMs));
    }
    this.startLoop(); // restart with new interval
    console.log(`[Heartbeat] Interval changed to ${this.intervalMs / 1000}s`);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    if (this.redisClient) {
      void this.redisClient.disconnect();
    }
    console.log('[Heartbeat] Stopped');
  }
}

// ─── Singleton ───────────────────────────────────────────────────────────────

let _instance: Heartbeat | null = null;

export function getHeartbeat(): Heartbeat | null {
  return _instance;
}

export async function initHeartbeat(): Promise<Heartbeat> {
  _instance = new Heartbeat();
  await _instance.init();
  return _instance;
}

export function stopHeartbeat(): void {
  if (_instance) {
    _instance.stop();
    _instance = null;
  }
}
