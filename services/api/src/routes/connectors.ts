import { Router, Request, Response } from 'express';
import { eq, and, desc } from 'drizzle-orm';
import { z } from 'zod';
import { randomBytes } from 'crypto';
import { db } from '../models/db.js';
import { oauthConnectors, connectorSyncJobs, connectorConfigs, jobs, jobBatches } from '../models/schema.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { tokenCost } from '../middleware/tokenMeter.js';
import { getProviderConfig, getProviderList } from '../connectors/oauth-config.js';
import { syncFolderIncremental } from '../services/sync-engine.js';
import { addKexJob } from '../services/queue.js';
import {
  listDriveFiles,
  listFolderContents,
  listFolderRecursive,
  getDriveFile,
  downloadDriveFile,
  isFolder,
  isExtractable,
  listGmailThreads,
  getGmailThread,
  gmailThreadToText,
  listCalendarEvents,
  calendarEventsToText,
} from '../connectors/google.js';
import {
  listChannels,
  getChannelHistory,
  channelMessagesToText,
} from '../connectors/slack.js';
import {
  listRepos,
  getRepoReadme,
  listIssues,
  listPRs,
  repoToText,
  issuesToText,
  prsToText,
} from '../connectors/github.js';
import {
  listOneDriveFiles,
  downloadOneDriveFile,
  listOutlookMessages,
  outlookMessagesToText,
} from '../connectors/microsoft.js';

const router = Router();

// ─── In-memory state store for OAuth flows (CSRF protection) ─────────────────
const oauthStateMap = new Map<string, { userId: string; provider: string; expiresAt: number }>();

// Clean expired states every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of oauthStateMap) {
    if (val.expiresAt < now) oauthStateMap.delete(key);
  }
}, 5 * 60 * 1000);

// ═══════════════════════════════════════════════════════════════════════════════
// Connector Configuration (Admin: set OAuth client IDs/secrets via frontend)
// ═══════════════════════════════════════════════════════════════════════════════

// ─── GET /config/providers ───────────────────────────────────────────────────
// List all providers with their setup info and whether they're configured

router.get(
  '/config/providers',
  requireAuth,
  async (_req: Request, res: Response): Promise<void> => {
    const providers = getProviderList();

    // Check which providers are configured
    const configs = await db
      .select({ provider: connectorConfigs.provider, isActive: connectorConfigs.isActive })
      .from(connectorConfigs);

    const configMap = new Map(configs.map((c) => [c.provider, c.isActive]));

    const result = providers.map((p) => ({
      ...p,
      configured: configMap.has(p.id) && configMap.get(p.id),
    }));

    res.json({ providers: result });
  },
);

// ─── GET /config/:provider ───────────────────────────────────────────────────
// Get config for a specific provider (masks secret)

router.get(
  '/config/:provider',
  requireAuth,
  requireRole('admin'),
  async (req: Request, res: Response): Promise<void> => {
    const provider = req.params['provider'] as string;

    const [config] = await db
      .select()
      .from(connectorConfigs)
      .where(eq(connectorConfigs.provider, provider))
      .limit(1);

    if (!config) {
      res.json({ provider, configured: false, clientId: '', clientSecretSet: false });
      return;
    }

    res.json({
      provider,
      configured: true,
      clientId: config.clientId,
      clientSecretSet: !!config.clientSecret,
      clientSecretPreview: config.clientSecret ? `${config.clientSecret.slice(0, 4)}...${config.clientSecret.slice(-4)}` : '',
      isActive: config.isActive,
      updatedAt: config.updatedAt,
    });
  },
);

// ─── PUT /config/:provider ───────────────────────────────────────────────────
// Create or update OAuth credentials for a provider

const configUpdateSchema = z.object({
  clientId: z.string().min(1, 'Client ID is required'),
  clientSecret: z.string().min(1, 'Client Secret is required'),
});

router.put(
  '/config/:provider',
  requireAuth,
  requireRole('admin'),
  validate(configUpdateSchema),
  async (req: Request, res: Response): Promise<void> => {
    const provider = req.params['provider'] as string;
    const userId = req.user!.sub;
    const { clientId, clientSecret } = req.body as z.infer<typeof configUpdateSchema>;

    const validProviders = ['google', 'microsoft', 'slack', 'github'];
    if (!validProviders.includes(provider)) {
      res.status(400).json({ error: `Invalid provider: ${provider}` });
      return;
    }

    try {
      // Upsert: insert or update on conflict
      const [existing] = await db
        .select({ id: connectorConfigs.id })
        .from(connectorConfigs)
        .where(eq(connectorConfigs.provider, provider))
        .limit(1);

      if (existing) {
        await db
          .update(connectorConfigs)
          .set({ clientId, clientSecret, updatedBy: userId, isActive: true, updatedAt: new Date() })
          .where(eq(connectorConfigs.provider, provider));
      } else {
        await db
          .insert(connectorConfigs)
          .values({ provider, clientId, clientSecret, updatedBy: userId, isActive: true });
      }

      console.log(`[Connectors] ${provider} OAuth config updated by ${userId}`);
      res.json({ ok: true, provider, message: `${provider} OAuth credentials saved. You can now connect accounts.` });
    } catch (err) {
      console.error(`[Connectors] Config update failed:`, err);
      res.status(500).json({ error: 'Failed to save configuration' });
    }
  },
);

// ─── DELETE /config/:provider ────────────────────────────────────────────────
// Remove OAuth credentials for a provider

router.delete(
  '/config/:provider',
  requireAuth,
  requireRole('admin'),
  async (req: Request, res: Response): Promise<void> => {
    const provider = req.params['provider'] as string;

    await db.delete(connectorConfigs).where(eq(connectorConfigs.provider, provider));
    res.json({ ok: true, provider, message: `${provider} OAuth credentials removed.` });
  },
);

// ─── Schemas ─────────────────────────────────────────────────────────────────

const syncDriveSchema = z.object({
  connectorId: z.string().uuid(),
  fileIds: z.array(z.string()).min(1, 'At least one file ID required'),
});

const syncGmailSchema = z.object({
  connectorId: z.string().uuid(),
  query: z.string().optional(),
  maxThreads: z.number().int().min(1).max(50).optional().default(10),
});

const syncCalendarSchema = z.object({
  connectorId: z.string().uuid(),
  timeMin: z.string().optional(),
  timeMax: z.string().optional(),
});

const syncOneDriveSchema = z.object({
  connectorId: z.string().uuid(),
  itemIds: z.array(z.string()).min(1),
});

const syncOutlookSchema = z.object({
  connectorId: z.string().uuid(),
  query: z.string().optional(),
  maxMessages: z.number().int().min(1).max(50).optional().default(10),
});

// ═══════════════════════════════════════════════════════════════════════════════
// OAuth2 Flow
// ═══════════════════════════════════════════════════════════════════════════════

// ─── GET /auth/:provider ─────────────────────────────────────────────────────
// Redirects user to OAuth provider's consent screen

router.get(
  '/auth/:provider',
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    const provider = req.params['provider'] as string;
    const userId = req.user!.sub;

    try {
      const config = await getProviderConfig(provider);

      if (!config.clientId) {
        res.status(400).json({
          error: `${provider} OAuth not configured. Go to Settings > Integrations > Configure to add your ${provider} OAuth credentials.`,
        });
        return;
      }

      // Generate CSRF state
      const state = randomBytes(32).toString('hex');
      oauthStateMap.set(state, {
        userId,
        provider,
        expiresAt: Date.now() + 10 * 60 * 1000, // 10 min
      });

      const params = new URLSearchParams({
        client_id: config.clientId,
        redirect_uri: config.redirectUri,
        response_type: 'code',
        scope: config.scopes.join(' '),
        state,
        access_type: 'offline',
        prompt: 'consent',
      });

      res.json({
        authUrl: `${config.authUrl}?${params.toString()}`,
        provider,
        message: 'Redirect the user to this URL to start the OAuth flow',
      });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  },
);

// ─── GET /:provider/callback ─────────────────────────────────────────────────
// OAuth callback - exchanges code for tokens

router.get(
  '/:provider/callback',
  async (req: Request, res: Response): Promise<void> => {
    const provider = req.params['provider'] as string;
    const code = req.query['code'] as string;
    const state = req.query['state'] as string;
    const error = req.query['error'] as string;

    if (error) {
      res.status(400).json({ error: `OAuth denied: ${error}` });
      return;
    }

    if (!code || !state) {
      res.status(400).json({ error: 'Missing code or state parameter' });
      return;
    }

    // Validate state (CSRF)
    const stateData = oauthStateMap.get(state);
    if (!stateData || stateData.provider !== provider || stateData.expiresAt < Date.now()) {
      res.status(400).json({ error: 'Invalid or expired OAuth state' });
      return;
    }
    oauthStateMap.delete(state);

    try {
      const config = await getProviderConfig(provider);

      // Exchange code for tokens
      const params = new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        code,
        redirect_uri: config.redirectUri,
        grant_type: 'authorization_code',
      });

      const tokenResp = await fetch(config.tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
      });

      if (!tokenResp.ok) {
        const errText = await tokenResp.text();
        res.status(400).json({ error: `Token exchange failed: ${errText}` });
        return;
      }

      const tokens = (await tokenResp.json()) as {
        access_token: string;
        refresh_token?: string;
        expires_in?: number;
        scope?: string;
      };

      // Get user info from provider
      let providerEmail = '';
      let providerAccountId = '';

      if (provider === 'google') {
        const userResp = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
          headers: { Authorization: `Bearer ${tokens.access_token}` },
        });
        if (userResp.ok) {
          const user = (await userResp.json()) as { id: string; email: string };
          providerEmail = user.email;
          providerAccountId = user.id;
        }
      } else if (provider === 'microsoft') {
        const userResp = await fetch('https://graph.microsoft.com/v1.0/me', {
          headers: { Authorization: `Bearer ${tokens.access_token}` },
        });
        if (userResp.ok) {
          const user = (await userResp.json()) as { id: string; mail?: string; userPrincipalName?: string };
          providerEmail = user.mail || user.userPrincipalName || '';
          providerAccountId = user.id;
        }
      }

      const expiresAt = tokens.expires_in
        ? new Date(Date.now() + tokens.expires_in * 1000)
        : null;

      // Upsert: if same user+provider+email exists, update tokens instead of creating duplicate
      const [existing] = await db
        .select({ id: oauthConnectors.id })
        .from(oauthConnectors)
        .where(and(
          eq(oauthConnectors.userId, stateData.userId),
          eq(oauthConnectors.provider, provider as 'google' | 'microsoft' | 'slack' | 'github'),
          providerEmail ? eq(oauthConnectors.providerEmail, providerEmail) : undefined as never,
        ))
        .limit(1);

      let connectorId: string;

      if (existing) {
        // Update existing connector's tokens
        await db
          .update(oauthConnectors)
          .set({
            accessToken: tokens.access_token,
            refreshToken: tokens.refresh_token || undefined,
            tokenExpiresAt: expiresAt,
            isActive: true,
            updatedAt: new Date(),
          })
          .where(eq(oauthConnectors.id, existing.id));
        connectorId = existing.id;
        console.log(`[Connectors] ${provider} re-authenticated for user ${stateData.userId}: ${providerEmail}`);
      } else {
        // Create new connector
        const [connector] = await db
          .insert(oauthConnectors)
          .values({
            userId: stateData.userId,
            provider: provider as 'google' | 'microsoft' | 'slack' | 'github',
            label: `${provider === 'google' ? 'Google' : provider === 'microsoft' ? 'Microsoft' : provider.charAt(0).toUpperCase() + provider.slice(1)} - ${providerEmail || 'Connected'}`,
            accessToken: tokens.access_token,
            refreshToken: tokens.refresh_token || null,
            tokenExpiresAt: expiresAt,
            scopes: tokens.scope ? tokens.scope.split(' ') : config.scopes,
            providerAccountId,
            providerEmail,
          })
          .returning();
        connectorId = connector!.id;
        console.log(`[Connectors] ${provider} connected for user ${stateData.userId}: ${providerEmail}`);
      }

      // Redirect to frontend with success
      // Redirect to frontend settings page (not the API server)
      const frontendUrl = process.env['FRONTEND_URL'] || 'http://localhost:3001';
      res.redirect(`${frontendUrl}/settings?tab=integrations&provider=${provider}&status=connected`);
    } catch (err) {
      console.error(`[Connectors] OAuth callback error:`, err);
      res.status(500).json({ error: 'OAuth callback failed' });
    }
  },
);

// ═══════════════════════════════════════════════════════════════════════════════
// Connector Management
// ═══════════════════════════════════════════════════════════════════════════════

// ─── GET / (list connectors) ─────────────────────────────────────────────────

router.get(
  '/',
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    const userId = req.user!.sub;

    const connectors = await db
      .select({
        id: oauthConnectors.id,
        provider: oauthConnectors.provider,
        label: oauthConnectors.label,
        providerEmail: oauthConnectors.providerEmail,
        isActive: oauthConnectors.isActive,
        lastSyncAt: oauthConnectors.lastSyncAt,
        createdAt: oauthConnectors.createdAt,
      })
      .from(oauthConnectors)
      .where(eq(oauthConnectors.userId, userId))
      .orderBy(desc(oauthConnectors.createdAt));

    res.json({ connectors });
  },
);

// ─── DELETE /:id ─────────────────────────────────────────────────────────────

router.delete(
  '/:id',
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    const userId = req.user!.sub;
    const connectorId = req.params['id']!;

    const result = await db
      .delete(oauthConnectors)
      .where(and(eq(oauthConnectors.id, connectorId), eq(oauthConnectors.userId, userId)));

    res.json({ ok: true, deleted: connectorId });
  },
);

// ═══════════════════════════════════════════════════════════════════════════════
// Google Sync Operations
// ═══════════════════════════════════════════════════════════════════════════════

// ─── GET /google/drive/files ─────────────────────────────────────────────────
// List files. ?folderId= to browse inside a folder, ?q= for search

router.get(
  '/google/drive/files',
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    const connectorId = req.query['connectorId'] as string;
    const folderId = req.query['folderId'] as string | undefined;
    const search = req.query['q'] as string | undefined;
    const pageToken = req.query['pageToken'] as string | undefined;

    if (!connectorId) {
      res.status(400).json({ error: 'connectorId is required' });
      return;
    }

    try {
      let query: string | undefined;
      if (folderId) {
        query = `'${folderId}' in parents and trashed = false`;
        if (search) query += ` and name contains '${search}'`;
      } else if (search) {
        query = `name contains '${search}' and trashed = false`;
      } else {
        query = `'root' in parents and trashed = false`;
      }

      const result = await listDriveFiles(connectorId, query, pageToken);

      // Annotate with isFolder and isExtractable flags for the UI
      const annotated = result.files.map((f) => ({
        ...f,
        isFolder: isFolder(f.mimeType),
        isExtractable: isExtractable(f.mimeType),
      }));

      res.json({ files: annotated, nextPageToken: result.nextPageToken, folderId: folderId || 'root' });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  },
);

// ─── POST /google/drive/sync/folder ──────────────────────────────────────────
// Recursively sync all extractable files from a folder into KEX (with batch + dedup)

router.post(
  '/google/drive/sync/folder',
  requireAuth,
  requireRole('analyst', 'editor', 'admin'),
  tokenCost(5, 'connector_sync'),
  async (req: Request, res: Response): Promise<void> => {
    const userId = req.user!.sub;
    const connectorId = req.body.connectorId as string;
    const folderId = req.body.folderId as string;
    const maxDepth = (req.body.maxDepth as number) || 5;
    const ontologyId = req.body.ontologyId as string | undefined;
    const discoveryMode = (req.body.discoveryMode as string) || 'discover';

    if (!connectorId || !folderId) {
      res.status(400).json({ error: 'connectorId and folderId are required' });
      return;
    }

    try {
      const compilationId = req.body.compilationId as string | undefined;
      const forceSingleGraphs = req.body.forceSingleGraphs as boolean | undefined;

      const result = await syncFolderIncremental({
        connectorId, folderId, userId, ontologyId, discoveryMode, maxDepth, compilationId, forceSingleGraphs,
      });

      await db.update(oauthConnectors)
        .set({ lastSyncAt: new Date(), updatedAt: new Date() })
        .where(eq(oauthConnectors.id, connectorId));

      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  },
);

// ─── POST /google/drive/sync ─────────────────────────────────────────────────
// Download specific files from Drive and submit to KEX for extraction
// Creates a batch when multiple files are selected

router.post(
  '/google/drive/sync',
  requireAuth,
  requireRole('analyst', 'editor', 'admin'),
  validate(syncDriveSchema),
  tokenCost(5, 'connector_sync'),
  async (req: Request, res: Response): Promise<void> => {
    const userId = req.user!.sub;
    const { connectorId, fileIds } = req.body as z.infer<typeof syncDriveSchema>;
    const compilationId = req.body.compilationId as string | undefined;
    const forceSingleGraphs = req.body.forceSingleGraphs as boolean | undefined;

    try {
      // Create a batch if more than 1 file
      let batchId: string | null = null;
      if (fileIds.length > 1) {
        const [batch] = await db.insert(jobBatches).values({
          userId,
          name: `${fileIds.length} files from Google Drive`,
          source: 'google_drive',
          sourceMetadata: { connectorId },
          totalJobs: fileIds.length,
          status: 'processing',
        }).returning();
        batchId = batch!.id;
      }

      const results: Array<{ fileId: string; jobId?: string; error?: string }> = [];

      for (const fileId of fileIds) {
        try {
          const file = await getDriveFile(connectorId, fileId);
          const { content, exportedMimeType } = await downloadDriveFile(connectorId, fileId, file.mimeType);

          const [job] = await db
            .insert(jobs)
            .values({
              userId,
              type: 'kex_extract',
              status: 'pending',
              batchId,
              input: {
                source: 'google_drive',
                fileName: file.name,
                mimeType: exportedMimeType,
                connectorId,
                ...(compilationId ? { compilationId, forceSingleGraphs: !!forceSingleGraphs } : {}),
              },
            })
            .returning();

          await addKexJob(job!.id, {
            userId,
            type: 'kex_upload',
            input: {
              fileBase64: content.toString('base64'),
              mimetype: exportedMimeType,
              originalFilename: file.name,
            },
          });

          await db.insert(connectorSyncJobs).values({
            connectorId,
            userId,
            sourceType: 'drive_file',
            sourceId: fileId,
            sourceName: file.name,
            kexJobId: job!.id,
            status: 'processing',
            metadata: { modifiedTime: file.modifiedTime },
          });

          results.push({ fileId, jobId: job!.id });
        } catch (err) {
          results.push({ fileId, error: (err as Error).message });
        }
      }

      // Update batch name with actual file info
      if (batchId) {
        const names = results.filter((r) => r.jobId).map((r) => r.fileId);
        const failedCount = results.filter((r) => r.error).length;
        await db.update(jobBatches).set({
          totalJobs: results.filter((r) => r.jobId).length,
          failedJobs: failedCount,
          status: results.filter((r) => r.jobId).length === 0 ? 'failed' : 'processing',
          updatedAt: new Date(),
        }).where(eq(jobBatches.id, batchId));
      }

      await db
        .update(oauthConnectors)
        .set({ lastSyncAt: new Date(), updatedAt: new Date() })
        .where(eq(oauthConnectors.id, connectorId));

      res.json({ batchId, results, synced: results.filter((r) => r.jobId).length });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  },
);

// ─── POST /google/gmail/sync ─────────────────────────────────────────────────

router.post(
  '/google/gmail/sync',
  requireAuth,
  requireRole('analyst', 'editor', 'admin'),
  validate(syncGmailSchema),
  tokenCost(3, 'connector_sync'),
  async (req: Request, res: Response): Promise<void> => {
    const userId = req.user!.sub;
    const { connectorId, query, maxThreads } = req.body as z.infer<typeof syncGmailSchema>;

    try {
      const threads = await listGmailThreads(connectorId, query, maxThreads);
      const results: Array<{ threadId: string; jobId?: string; error?: string }> = [];

      for (const thread of threads) {
        try {
          const messages = await getGmailThread(connectorId, thread.id);
          const text = gmailThreadToText(messages);

          if (!text.trim()) {
            results.push({ threadId: thread.id, error: 'Empty thread' });
            continue;
          }

          const subject = messages[0]?.subject || 'Gmail Thread';

          const [job] = await db
            .insert(jobs)
            .values({
              userId,
              type: 'kex_extract',
              status: 'pending',
              input: {
                source: 'gmail',
                threadId: thread.id,
                subject,
                connectorId,
              },
            })
            .returning();

          await addKexJob(job!.id, { userId, type: 'kex_extract', input: { text, fileName: `Gmail: ${subject}` } });

          await db.insert(connectorSyncJobs).values({
            connectorId,
            userId,
            sourceType: 'gmail_thread',
            sourceId: thread.id,
            sourceName: subject,
            kexJobId: job!.id,
            status: 'processing',
          });

          results.push({ threadId: thread.id, jobId: job!.id });
        } catch (err) {
          results.push({ threadId: thread.id, error: (err as Error).message });
        }
      }

      await db
        .update(oauthConnectors)
        .set({ lastSyncAt: new Date(), updatedAt: new Date() })
        .where(eq(oauthConnectors.id, connectorId));

      res.json({ results, synced: results.filter((r) => r.jobId).length });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  },
);

// ─── POST /google/calendar/sync ──────────────────────────────────────────────

router.post(
  '/google/calendar/sync',
  requireAuth,
  requireRole('analyst', 'editor', 'admin'),
  validate(syncCalendarSchema),
  tokenCost(3, 'connector_sync'),
  async (req: Request, res: Response): Promise<void> => {
    const userId = req.user!.sub;
    const { connectorId, timeMin, timeMax } = req.body as z.infer<typeof syncCalendarSchema>;

    try {
      const events = await listCalendarEvents(connectorId, timeMin, timeMax);
      if (events.length === 0) {
        res.json({ results: [], synced: 0, message: 'No calendar events found' });
        return;
      }

      const text = calendarEventsToText(events);

      const [job] = await db
        .insert(jobs)
        .values({
          userId,
          type: 'kex_extract',
          status: 'pending',
          input: {
            source: 'google_calendar',
            eventCount: events.length,
            connectorId,
          },
        })
        .returning();

      await addKexJob(job!.id, {
        userId,
        type: 'kex_extract',
        input: { text, fileName: `Google Calendar: ${events.length} events` },
      });

      await db.insert(connectorSyncJobs).values({
        connectorId,
        userId,
        sourceType: 'calendar_events',
        sourceId: 'batch',
        sourceName: `${events.length} calendar events`,
        kexJobId: job!.id,
        status: 'processing',
      });

      await db
        .update(oauthConnectors)
        .set({ lastSyncAt: new Date(), updatedAt: new Date() })
        .where(eq(oauthConnectors.id, connectorId));

      res.json({ jobId: job!.id, eventsProcessed: events.length, synced: 1 });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  },
);

// ═══════════════════════════════════════════════════════════════════════════════
// Microsoft Sync Operations
// ═══════════════════════════════════════════════════════════════════════════════

// ─── GET /microsoft/onedrive/files ───────────────────────────────────────────

router.get(
  '/microsoft/onedrive/files',
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    const connectorId = req.query['connectorId'] as string;
    const folderId = req.query['folderId'] as string | undefined;

    if (!connectorId) {
      res.status(400).json({ error: 'connectorId is required' });
      return;
    }

    try {
      const result = await listOneDriveFiles(connectorId, folderId);
      res.json({ files: result.items, nextLink: result.nextLink });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  },
);

// ─── POST /microsoft/onedrive/sync ───────────────────────────────────────────

router.post(
  '/microsoft/onedrive/sync',
  requireAuth,
  requireRole('analyst', 'editor', 'admin'),
  validate(syncOneDriveSchema),
  tokenCost(5, 'connector_sync'),
  async (req: Request, res: Response): Promise<void> => {
    const userId = req.user!.sub;
    const { connectorId, itemIds } = req.body as z.infer<typeof syncOneDriveSchema>;

    try {
      const results: Array<{ itemId: string; jobId?: string; error?: string }> = [];

      for (const itemId of itemIds) {
        try {
          const { content, mimeType } = await downloadOneDriveFile(connectorId, itemId);

          const [job] = await db
            .insert(jobs)
            .values({
              userId,
              type: 'kex_extract',
              status: 'pending',
              input: {
                source: 'onedrive',
                itemId,
                mimeType,
                connectorId,
              },
            })
            .returning();

          await addKexJob(job!.id, {
            userId,
            type: 'kex_upload',
            input: {
              fileBase64: content.toString('base64'),
              mimetype: mimeType,
              originalFilename: `OneDrive_${itemId}`,
            },
          });

          await db.insert(connectorSyncJobs).values({
            connectorId,
            userId,
            sourceType: 'onedrive_file',
            sourceId: itemId,
            kexJobId: job!.id,
            status: 'processing',
          });

          results.push({ itemId, jobId: job!.id });
        } catch (err) {
          results.push({ itemId, error: (err as Error).message });
        }
      }

      await db
        .update(oauthConnectors)
        .set({ lastSyncAt: new Date(), updatedAt: new Date() })
        .where(eq(oauthConnectors.id, connectorId));

      res.json({ results, synced: results.filter((r) => r.jobId).length });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  },
);

// ─── POST /microsoft/outlook/sync ────────────────────────────────────────────

router.post(
  '/microsoft/outlook/sync',
  requireAuth,
  requireRole('analyst', 'editor', 'admin'),
  validate(syncOutlookSchema),
  tokenCost(3, 'connector_sync'),
  async (req: Request, res: Response): Promise<void> => {
    const userId = req.user!.sub;
    const { connectorId, query, maxMessages } = req.body as z.infer<typeof syncOutlookSchema>;

    try {
      const messages = await listOutlookMessages(connectorId, undefined, maxMessages);
      if (messages.length === 0) {
        res.json({ results: [], synced: 0, message: 'No messages found' });
        return;
      }

      const text = outlookMessagesToText(messages);

      const [job] = await db
        .insert(jobs)
        .values({
          userId,
          type: 'kex_extract',
          status: 'pending',
          input: {
            source: 'outlook',
            messageCount: messages.length,
            query,
            connectorId,
          },
        })
        .returning();

      await addKexJob(job!.id, {
        userId,
        type: 'kex_extract',
        input: { text, fileName: `Outlook: ${messages.length} messages` },
      });

      await db.insert(connectorSyncJobs).values({
        connectorId,
        userId,
        sourceType: 'outlook_email',
        sourceId: 'batch',
        sourceName: `${messages.length} emails`,
        kexJobId: job!.id,
        status: 'processing',
      });

      await db
        .update(oauthConnectors)
        .set({ lastSyncAt: new Date(), updatedAt: new Date() })
        .where(eq(oauthConnectors.id, connectorId));

      res.json({ jobId: job!.id, messagesProcessed: messages.length, synced: 1 });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  },
);

// ═══════════════════════════════════════════════════════════════════════════════
// Slack Sync Operations
// ═══════════════════════════════════════════════════════════════════════════════

// ─── GET /slack/channels ─────────────────────────────────────────────────────

router.get(
  '/slack/channels',
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    const connectorId = req.query['connectorId'] as string;
    if (!connectorId) {
      res.status(400).json({ error: 'connectorId is required' });
      return;
    }

    try {
      const channels = await listChannels(connectorId);
      res.json({ channels });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  },
);

// ─── POST /slack/sync ────────────────────────────────────────────────────────
// Sync messages from Slack channels into KEX

router.post(
  '/slack/sync',
  requireAuth,
  requireRole('analyst', 'editor', 'admin'),
  tokenCost(3, 'connector_sync'),
  async (req: Request, res: Response): Promise<void> => {
    const userId = req.user!.sub;
    const connectorId = req.body.connectorId as string;
    const channelIds = req.body.channelIds as string[];
    const messageLimit = (req.body.messageLimit as number) || 100;

    if (!connectorId || !channelIds || channelIds.length === 0) {
      res.status(400).json({ error: 'connectorId and channelIds are required' });
      return;
    }

    try {
      const results: Array<{ channelId: string; jobId?: string; error?: string }> = [];

      for (const channelId of channelIds) {
        try {
          const messages = await getChannelHistory(connectorId, channelId, messageLimit);
          if (messages.length === 0) {
            results.push({ channelId, error: 'No messages found' });
            continue;
          }

          // Get channel name from the channel list
          const channels = await listChannels(connectorId);
          const channel = channels.find((c) => c.id === channelId);
          const channelName = channel?.name || channelId;

          const text = await channelMessagesToText(connectorId, channelName, messages);

          const [job] = await db
            .insert(jobs)
            .values({
              userId,
              type: 'kex_extract',
              status: 'pending',
              input: {
                source: 'slack',
                channelId,
                channelName,
                messageCount: messages.length,
                connectorId,
              },
            })
            .returning();

          await addKexJob(job!.id, {
            userId,
            type: 'kex_extract',
            input: { text, fileName: `Slack #${channelName}: ${messages.length} messages` },
          });

          await db.insert(connectorSyncJobs).values({
            connectorId,
            userId,
            sourceType: 'slack_channel',
            sourceId: channelId,
            sourceName: `#${channelName}`,
            kexJobId: job!.id,
            status: 'processing',
          });

          results.push({ channelId, jobId: job!.id });
        } catch (err) {
          results.push({ channelId, error: (err as Error).message });
        }
      }

      await db
        .update(oauthConnectors)
        .set({ lastSyncAt: new Date(), updatedAt: new Date() })
        .where(eq(oauthConnectors.id, connectorId));

      res.json({ results, synced: results.filter((r) => r.jobId).length });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  },
);

// ═══════════════════════════════════════════════════════════════════════════════
// GitHub Sync Operations
// ═══════════════════════════════════════════════════════════════════════════════

// ─── GET /github/repos ───────────────────────────────────────────────────────

router.get(
  '/github/repos',
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    const connectorId = req.query['connectorId'] as string;
    if (!connectorId) {
      res.status(400).json({ error: 'connectorId is required' });
      return;
    }
    try {
      const repos = await listRepos(connectorId);
      res.json({ repos });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  },
);

// ─── POST /github/sync ──────────────────────────────────────────────────────
// Sync repo README, issues, and PRs into KEX

router.post(
  '/github/sync',
  requireAuth,
  requireRole('analyst', 'editor', 'admin'),
  tokenCost(5, 'connector_sync'),
  async (req: Request, res: Response): Promise<void> => {
    const userId = req.user!.sub;
    const connectorId = req.body.connectorId as string;
    const repoFullNames = req.body.repos as string[]; // e.g. ["owner/repo"]
    const includeIssues = req.body.includeIssues !== false;
    const includePRs = req.body.includePRs !== false;

    if (!connectorId || !repoFullNames || repoFullNames.length === 0) {
      res.status(400).json({ error: 'connectorId and repos are required' });
      return;
    }

    try {
      const results: Array<{ repo: string; jobIds: string[]; error?: string }> = [];

      for (const fullName of repoFullNames) {
        try {
          const [owner, repo] = fullName.split('/');
          if (!owner || !repo) {
            results.push({ repo: fullName, jobIds: [], error: 'Invalid repo format (use owner/repo)' });
            continue;
          }

          const jobIds: string[] = [];

          // Sync README
          const readme = await getRepoReadme(connectorId, owner, repo);
          if (readme) {
            const repos = await listRepos(connectorId);
            const repoData = repos.find((r) => r.full_name === fullName);
            const text = repoData ? repoToText(repoData, readme) : `Repository: ${fullName}\n\n${readme}`;

            const [job] = await db.insert(jobs).values({
              userId, type: 'kex_extract', status: 'pending',
              input: { source: 'github', repo: fullName, type: 'readme', connectorId },
            }).returning();

            await addKexJob(job!.id, { userId, type: 'kex_extract', input: { text, fileName: `GitHub ${fullName} README` } });
            await db.insert(connectorSyncJobs).values({
              connectorId, userId, sourceType: 'github_repo', sourceId: fullName,
              sourceName: `${fullName} README`, kexJobId: job!.id, status: 'processing',
            });
            jobIds.push(job!.id);
          }

          // Sync Issues
          if (includeIssues) {
            const issues = await listIssues(connectorId, owner, repo, 'all', 50);
            if (issues.length > 0) {
              const text = issuesToText(issues, fullName);
              const [job] = await db.insert(jobs).values({
                userId, type: 'kex_extract', status: 'pending',
                input: { source: 'github', repo: fullName, type: 'issues', count: issues.length, connectorId },
              }).returning();

              await addKexJob(job!.id, { userId, type: 'kex_extract', input: { text, fileName: `GitHub ${fullName} Issues` } });
              await db.insert(connectorSyncJobs).values({
                connectorId, userId, sourceType: 'github_issues', sourceId: fullName,
                sourceName: `${fullName} ${issues.length} issues`, kexJobId: job!.id, status: 'processing',
              });
              jobIds.push(job!.id);
            }
          }

          // Sync PRs
          if (includePRs) {
            const prs = await listPRs(connectorId, owner, repo, 'all', 50);
            if (prs.length > 0) {
              const text = prsToText(prs, fullName);
              const [job] = await db.insert(jobs).values({
                userId, type: 'kex_extract', status: 'pending',
                input: { source: 'github', repo: fullName, type: 'prs', count: prs.length, connectorId },
              }).returning();

              await addKexJob(job!.id, { userId, type: 'kex_extract', input: { text, fileName: `GitHub ${fullName} PRs` } });
              await db.insert(connectorSyncJobs).values({
                connectorId, userId, sourceType: 'github_prs', sourceId: fullName,
                sourceName: `${fullName} ${prs.length} PRs`, kexJobId: job!.id, status: 'processing',
              });
              jobIds.push(job!.id);
            }
          }

          results.push({ repo: fullName, jobIds });
        } catch (err) {
          results.push({ repo: fullName, jobIds: [], error: (err as Error).message });
        }
      }

      await db.update(oauthConnectors)
        .set({ lastSyncAt: new Date(), updatedAt: new Date() })
        .where(eq(oauthConnectors.id, connectorId));

      res.json({ results, synced: results.reduce((sum, r) => sum + r.jobIds.length, 0) });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  },
);

// ─── GET /sync-jobs ──────────────────────────────────────────────────────────

router.get(
  '/sync-jobs',
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    const userId = req.user!.sub;
    const connectorId = req.query['connectorId'] as string | undefined;

    let query = db
      .select()
      .from(connectorSyncJobs)
      .where(eq(connectorSyncJobs.userId, userId))
      .orderBy(desc(connectorSyncJobs.createdAt))
      .limit(100);

    const syncJobs = await query;
    res.json({ syncJobs });
  },
);

export default router;
