/**
 * Event-driven compilation refresh.
 *
 * When a KEX job completes, check if the job ID appears in any
 * compilation's sourceJobIds. If so, queue an incremental fuse_merge
 * job — but only if there isn't already a pending refresh for that
 * compilation (natural debounce).
 *
 * IMPORTANT: Only call this for KEX job completions, never for FUSE
 * completions — that would cause infinite refresh loops.
 */

import { eq, sql } from 'drizzle-orm';
import { db } from '../models/db.js';
import { compilations, jobs } from '../models/schema.js';
import { addFuseJob } from './queue.js';

export async function triggerCompilationRefresh(completedJobId: string): Promise<void> {
  try {
    // Find compilations that include this job in their sourceJobIds
    const affected = await db
      .select({
        id: compilations.id,
        name: compilations.name,
        userId: compilations.userId,
        sourceJobIds: compilations.sourceJobIds,
      })
      .from(compilations)
      .where(sql`${compilations.sourceJobIds} @> ARRAY[${completedJobId}::uuid]`);

    if (affected.length === 0) return;

    for (const comp of affected) {
      const sourceJobIds = (comp.sourceJobIds as string[]) ?? [];
      if (sourceJobIds.length === 0) continue;

      // Debounce: check if there's already a pending/processing fuse_merge for this compilation
      const [pendingJob] = await db
        .select({ id: jobs.id })
        .from(jobs)
        .where(
          sql`${jobs.type} = 'fuse_merge'
            AND ${jobs.status} IN ('pending', 'processing')
            AND (${jobs.input}->>'compilationId') = ${comp.id}`
        )
        .limit(1);

      if (pendingJob) {
        console.log(`[CompRefresh] Skipping "${comp.name}" — refresh already pending (${pendingJob.id})`);
        continue;
      }

      // Create incremental refresh job
      const [job] = await db
        .insert(jobs)
        .values({
          userId: comp.userId,
          type: 'fuse_merge',
          status: 'pending',
          input: {
            compilationId: comp.id,
            sourceJobIds,
            name: comp.name,
            mode: 'incremental',
            triggeredBy: 'source_update',
            triggerJobId: completedJobId,
          },
        })
        .returning();

      if (!job) {
        console.error(`[CompRefresh] Failed to create job for ${comp.id}`);
        continue;
      }

      try {
        await addFuseJob(job.id, {
          userId: comp.userId,
          compilationId: comp.id,
          sourceJobIds,
          name: comp.name,
        });
      } catch (err) {
        console.error(`[CompRefresh] Redis dispatch failed for ${comp.id}:`, err);
        continue;
      }

      await db
        .update(compilations)
        .set({ lastRefreshAt: new Date(), updatedAt: new Date() })
        .where(eq(compilations.id, comp.id));

      console.log(`[CompRefresh] Queued refresh for "${comp.name}" (triggered by job ${completedJobId})`);
    }
  } catch (err) {
    console.error('[CompRefresh] Error:', err);
  }
}
