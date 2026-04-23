/**
 * Sync Engine - shared logic for folder sync with dedup and batch creation.
 * Used by connectors.ts routes and trigger-scheduler.ts.
 */

import { eq, and } from 'drizzle-orm';
import { db } from '../models/db.js';
import { jobBatches, jobs, connectorSyncJobs } from '../models/schema.js';
import { addKexJob } from './queue.js';
import {
  getDriveFile,
  listFolderRecursive,
  downloadDriveFile,
} from '../connectors/google.js';
import { compilations } from '../models/schema.js';

export interface SyncResult {
  batchId: string | null;
  batchName: string;
  totalFiles: number;
  synced: number;
  skipped: number;
  failed: number;
  results: Array<{ fileId: string; name: string; jobId?: string; error?: string; skipped?: boolean }>;
}

export async function syncFolderIncremental(opts: {
  connectorId: string;
  folderId: string;
  userId: string;
  ontologyId?: string;
  discoveryMode?: string;
  batchName?: string;
  triggerId?: string;
  maxDepth?: number;
  compilationId?: string;
  forceSingleGraphs?: boolean;
}): Promise<SyncResult> {
  const { connectorId, folderId, userId, ontologyId, discoveryMode = 'discover', triggerId, maxDepth = 5, compilationId, forceSingleGraphs } = opts;

  // Get folder metadata
  const folder = await getDriveFile(connectorId, folderId);
  const batchName = opts.batchName || folder.name;
  console.log(`[SyncEngine] Syncing folder "${batchName}" recursively (depth: ${maxDepth})`);

  // Recursively list all extractable files
  const files = await listFolderRecursive(connectorId, folderId, folder.name, maxDepth);

  if (files.length === 0) {
    return { batchId: null, batchName, totalFiles: 0, synced: 0, skipped: 0, failed: 0, results: [] };
  }

  // Dedup: check which files were already synced and unchanged FOR THE SAME TARGET
  // A file extracted into Graph A should still be extractable into Graph B
  const existingSyncs = await db
    .select({
      sourceId: connectorSyncJobs.sourceId,
      metadata: connectorSyncJobs.metadata,
      status: connectorSyncJobs.status,
    })
    .from(connectorSyncJobs)
    .where(and(
      eq(connectorSyncJobs.connectorId, connectorId),
      eq(connectorSyncJobs.userId, userId),
      eq(connectorSyncJobs.sourceType, 'drive_file'),
    ));

  const syncedMap = new Map<string, string>();
  for (const sync of existingSyncs) {
    if (sync.status === 'completed') {
      const meta = sync.metadata as Record<string, unknown> | null;
      const modTime = meta?.['modifiedTime'] as string | undefined;
      const syncCompilationId = meta?.['compilationId'] as string | undefined;
      // Only skip if same target (or both have no target)
      if (modTime && (syncCompilationId || null) === (compilationId || null)) {
        syncedMap.set(sync.sourceId, modTime);
      }
    }
  }

  // First pass: collect files that actually need processing (not skipped by dedup)
  const filesToProcess: typeof files = [];
  const results: SyncResult['results'] = [];
  let skippedCount = 0;

  for (const file of files) {
    const lastSyncedTime = syncedMap.get(file.id);
    if (lastSyncedTime && file.modifiedTime && new Date(file.modifiedTime) <= new Date(lastSyncedTime)) {
      results.push({ fileId: file.id, name: file.name, skipped: true });
      skippedCount++;
    } else {
      filesToProcess.push(file);
    }
  }

  // If nothing to process after dedup, return silently — no batch, no noise
  if (filesToProcess.length === 0) {
    return { batchId: null, batchName, totalFiles: files.length, synced: 0, skipped: skippedCount, failed: 0, results };
  }

  // Look up compilation name for display if auto-FUSE target is set
  let compilationName: string | null = null;
  if (compilationId) {
    try {
      const [comp] = await db.select({ name: compilations.name }).from(compilations).where(eq(compilations.id, compilationId)).limit(1);
      compilationName = comp?.name ?? null;
    } catch { /* non-fatal */ }
  }

  // Create batch only when there's actual work
  const [batch] = await db.insert(jobBatches).values({
    userId,
    name: batchName,
    source: 'google_drive',
    sourceMetadata: { connectorId, folderId, folderName: folder.name, compilationId, compilationName },
    totalJobs: filesToProcess.length,
    status: 'processing',
  }).returning();

  const batchId = batch!.id;

  for (const file of filesToProcess) {
    try {
      const { content, exportedMimeType } = await downloadDriveFile(connectorId, file.id, file.mimeType);

      const [job] = await db.insert(jobs).values({
        userId,
        type: 'kex_extract',
        status: 'pending',
        batchId,
        triggerId: triggerId || null,
        input: {
          source: 'google_drive',
          folderId,
          folderName: folder.name,
          fileName: file.name,
          mimeType: exportedMimeType,
          connectorId,
          ...(ontologyId ? { ontologyId, discoveryMode } : {}),
          ...(compilationId ? { compilationId, forceSingleGraphs: !!forceSingleGraphs } : {}),
        },
      }).returning();

      await addKexJob(job!.id, {
        userId,
        type: 'kex_upload',
        input: {
          fileBase64: content.toString('base64'),
          mimetype: exportedMimeType,
          originalFilename: file.name,
          ...(ontologyId ? { ontologyId, discoveryMode } : {}),
        },
      });

      await db.insert(connectorSyncJobs).values({
        connectorId,
        userId,
        sourceType: 'drive_file',
        sourceId: file.id,
        sourceName: file.name,
        kexJobId: job!.id,
        status: 'processing',
        metadata: { modifiedTime: file.modifiedTime, folderId, folderName: folder.name, compilationId: compilationId || null },
      });

      results.push({ fileId: file.id, name: file.name, jobId: job!.id });
    } catch (err) {
      results.push({ fileId: file.id, name: file.name, error: (err as Error).message });
    }
  }

  // Update batch with actual counts
  const actualJobs = results.filter((r) => r.jobId).length;
  const failedCount = results.filter((r) => r.error && !r.skipped).length;
  await db.update(jobBatches).set({
    totalJobs: actualJobs,
    failedJobs: failedCount,
    status: actualJobs === 0 ? 'failed' : 'processing',
    updatedAt: new Date(),
  }).where(eq(jobBatches.id, batchId));

  console.log(`[SyncEngine] Batch ${batchId}: ${actualJobs} synced, ${skippedCount} skipped, ${failedCount} failed`);

  return { batchId, batchName, totalFiles: files.length, synced: actualJobs, skipped: skippedCount, failed: failedCount, results };
}

/**
 * Update batch progress when a job completes or fails.
 * Called from the result handler in index.ts.
 */
export async function updateBatchProgress(batchId: string): Promise<void> {
  const [batch] = await db.select({ totalJobs: jobBatches.totalJobs }).from(jobBatches).where(eq(jobBatches.id, batchId)).limit(1);
  if (!batch) return;

  // Count completed and failed jobs in this batch
  const batchJobs = await db
    .select({ status: jobs.status })
    .from(jobs)
    .where(eq(jobs.batchId, batchId));

  const completed = batchJobs.filter((j) => j.status === 'completed').length;
  const failed = batchJobs.filter((j) => j.status === 'failed').length;
  const allDone = completed + failed >= batch.totalJobs;

  await db.update(jobBatches).set({
    completedJobs: completed,
    failedJobs: failed,
    status: allDone ? (failed > 0 && completed > 0 ? 'partial_failure' : failed > 0 ? 'failed' : 'completed') : 'processing',
    updatedAt: new Date(),
  }).where(eq(jobBatches.id, batchId));
}
