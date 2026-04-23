/**
 * Unified Source Sync Routes
 * Cloud Storage (S3, GCS, MinIO, Dropbox), CRM (Salesforce, HubSpot),
 * Project Management (Jira, Confluence, Notion, Linear)
 *
 * All routes follow the same pattern:
 *   POST /api/sources/:provider/sync — extract data to KEX
 */

import { Router, Request, Response } from 'express';
import { eq } from 'drizzle-orm';
import { db } from '../models/db.js';
import { jobs, jobBatches } from '../models/schema.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { tokenCost } from '../middleware/tokenMeter.js';
import { addKexJob } from '../services/queue.js';

// Lazy-load connectors to avoid import errors if optional deps missing
async function loadCloudStorage() { return import('../connectors/cloud-storage.js'); }
async function loadCRM() { return import('../connectors/crm.js'); }
async function loadPM() { return import('../connectors/project-management.js'); }

const router = Router();

// ─── Helper: create a text extraction job ────────────────────────────────────

async function createTextJob(
  userId: string,
  batchId: string | null,
  source: string,
  fileName: string,
  text: string,
  extra?: Record<string, unknown>,
): Promise<string> {
  const [job] = await db.insert(jobs).values({
    userId,
    type: 'kex_extract',
    status: 'pending',
    batchId,
    input: { source, fileName, ...extra },
  }).returning();

  await addKexJob(job!.id, {
    userId,
    type: 'kex_extract',
    input: { text, ...(extra?.ontologyId ? { ontologyId: extra.ontologyId, discoveryMode: extra.discoveryMode } : {}) },
  });

  return job!.id;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Cloud Storage
// ═══════════════════════════════════════════════════════════════════════════════

router.post('/s3/sync', requireAuth, requireRole('analyst', 'editor', 'admin'), tokenCost(5, 'source_sync'),
  async (req: Request, res: Response): Promise<void> => {
    const userId = req.user!.sub;
    const { config, keys, ontologyId, discoveryMode, compilationId } = req.body;
    try {
      const cs = await loadCloudStorage();
      const [batch] = await db.insert(jobBatches).values({
        userId, name: `S3: ${config.bucket} (${keys.length} files)`, source: 's3',
        sourceMetadata: { bucket: config.bucket, endpoint: config.endpoint },
        totalJobs: keys.length, status: 'processing',
      }).returning();

      const results = [];
      for (const key of keys as string[]) {
        try {
          const { content, contentType } = await cs.downloadS3Object(config, key);
          const mime = contentType !== 'application/octet-stream' ? contentType : cs.mimeFromKey(key);
          const jobId = await createTextJob(userId, batch!.id, 's3', key,
            content.toString('base64'), { encoding: 'base64', mimeType: mime, ontologyId, discoveryMode, compilationId });
          results.push({ key, jobId });
        } catch (err) { results.push({ key, error: (err as Error).message }); }
      }
      res.json({ batchId: batch!.id, synced: results.filter((r) => r.jobId).length, results });
    } catch (err) { res.status(500).json({ error: (err as Error).message }); }
  }
);

router.post('/dropbox/sync', requireAuth, requireRole('analyst', 'editor', 'admin'), tokenCost(5, 'source_sync'),
  async (req: Request, res: Response): Promise<void> => {
    const userId = req.user!.sub;
    const { config, paths, ontologyId, discoveryMode } = req.body;
    try {
      const cs = await loadCloudStorage();
      const [batch] = await db.insert(jobBatches).values({
        userId, name: `Dropbox (${paths.length} files)`, source: 'dropbox',
        totalJobs: paths.length, status: 'processing',
      }).returning();

      const results = [];
      for (const path of paths as string[]) {
        try {
          const { content } = await cs.downloadDropboxFile(config, path);
          const mime = cs.mimeFromKey(path);
          const jobId = await createTextJob(userId, batch!.id, 'dropbox', path,
            content.toString('base64'), { encoding: 'base64', mimeType: mime, ontologyId, discoveryMode });
          results.push({ path, jobId });
        } catch (err) { results.push({ path, error: (err as Error).message }); }
      }
      res.json({ batchId: batch!.id, synced: results.filter((r) => r.jobId).length, results });
    } catch (err) { res.status(500).json({ error: (err as Error).message }); }
  }
);

// ═══════════════════════════════════════════════════════════════════════════════
// CRM
// ═══════════════════════════════════════════════════════════════════════════════

router.post('/salesforce/sync', requireAuth, requireRole('analyst', 'editor', 'admin'), tokenCost(5, 'source_sync'),
  async (req: Request, res: Response): Promise<void> => {
    const userId = req.user!.sub;
    const { config, objects = ['contacts', 'deals', 'accounts'], ontologyId, discoveryMode, compilationId } = req.body;
    try {
      const crm = await loadCRM();
      const [batch] = await db.insert(jobBatches).values({
        userId, name: `Salesforce (${objects.length} objects)`, source: 'salesforce',
        totalJobs: objects.length, status: 'processing',
      }).returning();

      const results = [];
      for (const obj of objects as string[]) {
        try {
          let text = '';
          if (obj === 'contacts') text = await crm.fetchSalesforceContacts(config);
          else if (obj === 'deals') text = await crm.fetchSalesforceDeals(config);
          else if (obj === 'accounts') text = await crm.fetchSalesforceAccounts(config);
          if (!text) { results.push({ object: obj, error: 'No data' }); continue; }
          const jobId = await createTextJob(userId, batch!.id, 'salesforce', `Salesforce ${obj}`, text, { ontologyId, discoveryMode, compilationId });
          results.push({ object: obj, jobId });
        } catch (err) { results.push({ object: obj, error: (err as Error).message }); }
      }
      res.json({ batchId: batch!.id, synced: results.filter((r) => r.jobId).length, results });
    } catch (err) { res.status(500).json({ error: (err as Error).message }); }
  }
);

router.post('/hubspot/sync', requireAuth, requireRole('analyst', 'editor', 'admin'), tokenCost(5, 'source_sync'),
  async (req: Request, res: Response): Promise<void> => {
    const userId = req.user!.sub;
    const { config, objects = ['contacts', 'deals', 'companies'], ontologyId, discoveryMode, compilationId } = req.body;
    try {
      const crm = await loadCRM();
      const [batch] = await db.insert(jobBatches).values({
        userId, name: `HubSpot (${objects.length} objects)`, source: 'hubspot',
        totalJobs: objects.length, status: 'processing',
      }).returning();

      const results = [];
      for (const obj of objects as string[]) {
        try {
          let text = '';
          if (obj === 'contacts') text = await crm.fetchHubSpotContacts(config);
          else if (obj === 'deals') text = await crm.fetchHubSpotDeals(config);
          else if (obj === 'companies') text = await crm.fetchHubSpotCompanies(config);
          if (!text) { results.push({ object: obj, error: 'No data' }); continue; }
          const jobId = await createTextJob(userId, batch!.id, 'hubspot', `HubSpot ${obj}`, text, { ontologyId, discoveryMode, compilationId });
          results.push({ object: obj, jobId });
        } catch (err) { results.push({ object: obj, error: (err as Error).message }); }
      }
      res.json({ batchId: batch!.id, synced: results.filter((r) => r.jobId).length, results });
    } catch (err) { res.status(500).json({ error: (err as Error).message }); }
  }
);

// ═══════════════════════════════════════════════════════════════════════════════
// Project Management
// ═══════════════════════════════════════════════════════════════════════════════

router.post('/jira/sync', requireAuth, requireRole('analyst', 'editor', 'admin'), tokenCost(5, 'source_sync'),
  async (req: Request, res: Response): Promise<void> => {
    const userId = req.user!.sub;
    const { config, jql, maxResults = 50, ontologyId, discoveryMode, compilationId } = req.body;
    try {
      const pm = await loadPM();
      const text = await pm.fetchJiraIssues(config, jql, maxResults);
      if (!text) { res.json({ synced: 0, message: 'No issues found' }); return; }

      const jobId = await createTextJob(userId, null, 'jira', `Jira: ${jql || 'recent issues'}`, text, { ontologyId, discoveryMode, compilationId });
      res.json({ jobId, synced: 1 });
    } catch (err) { res.status(500).json({ error: (err as Error).message }); }
  }
);

router.post('/confluence/sync', requireAuth, requireRole('analyst', 'editor', 'admin'), tokenCost(5, 'source_sync'),
  async (req: Request, res: Response): Promise<void> => {
    const userId = req.user!.sub;
    const { config, spaceKey, limit = 25, ontologyId, discoveryMode, compilationId } = req.body;
    try {
      const pm = await loadPM();
      const text = await pm.fetchConfluencePages(config, spaceKey, limit);
      if (!text) { res.json({ synced: 0, message: 'No pages found' }); return; }

      const jobId = await createTextJob(userId, null, 'confluence', `Confluence: ${spaceKey || 'all spaces'}`, text, { ontologyId, discoveryMode, compilationId });
      res.json({ jobId, synced: 1 });
    } catch (err) { res.status(500).json({ error: (err as Error).message }); }
  }
);

router.post('/notion/sync', requireAuth, requireRole('analyst', 'editor', 'admin'), tokenCost(5, 'source_sync'),
  async (req: Request, res: Response): Promise<void> => {
    const userId = req.user!.sub;
    const { config, databaseId, limit = 50, ontologyId, discoveryMode, compilationId } = req.body;
    try {
      const pm = await loadPM();
      const text = await pm.fetchNotionPages(config, databaseId, limit);
      if (!text) { res.json({ synced: 0, message: 'No pages found' }); return; }

      const jobId = await createTextJob(userId, null, 'notion', `Notion: ${databaseId || 'all pages'}`, text, { ontologyId, discoveryMode, compilationId });
      res.json({ jobId, synced: 1 });
    } catch (err) { res.status(500).json({ error: (err as Error).message }); }
  }
);

router.post('/linear/sync', requireAuth, requireRole('analyst', 'editor', 'admin'), tokenCost(5, 'source_sync'),
  async (req: Request, res: Response): Promise<void> => {
    const userId = req.user!.sub;
    const { config, teamKey, limit = 50, ontologyId, discoveryMode, compilationId } = req.body;
    try {
      const pm = await loadPM();
      const text = await pm.fetchLinearIssues(config, teamKey, limit);
      if (!text) { res.json({ synced: 0, message: 'No issues found' }); return; }

      const jobId = await createTextJob(userId, null, 'linear', `Linear: ${teamKey || 'all teams'}`, text, { ontologyId, discoveryMode, compilationId });
      res.json({ jobId, synced: 1 });
    } catch (err) { res.status(500).json({ error: (err as Error).message }); }
  }
);

export default router;
