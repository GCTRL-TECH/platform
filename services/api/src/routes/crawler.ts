import { Router, Request, Response } from 'express';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../models/db.js';
import { jobs, jobBatches } from '../models/schema.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { tokenCost } from '../middleware/tokenMeter.js';
import { addKexJob } from '../services/queue.js';
import { crawlWebsite } from '../connectors/web-crawler.js';

const router = Router();

// ─── Schemas ─────────────────────────────────────────────────────────────────

const crawlSchema = z.object({
  url: z.string().url('Must be a valid URL'),
  maxDepth: z.number().int().min(1).max(10).optional().default(3),
  maxPages: z.number().int().min(1).max(200).optional().default(50),
  sameDomainOnly: z.boolean().optional().default(true),
  ontologyId: z.string().uuid().optional(),
  discoveryMode: z.enum(['discover', 'strict']).optional().default('discover'),
  compilationId: z.string().uuid().optional(),
});

// ─── POST /crawl ─────────────────────────────────────────────────────────────

router.post(
  '/crawl',
  requireAuth,
  requireRole('analyst', 'editor', 'admin'),
  validate(crawlSchema),
  tokenCost(10, 'web_crawl'),
  async (req: Request, res: Response): Promise<void> => {
    const userId = req.user!.sub;
    const { url, maxDepth, maxPages, sameDomainOnly, ontologyId, discoveryMode, compilationId } = req.body as z.infer<typeof crawlSchema>;

    try {
      // Crawl the website
      const pages = await crawlWebsite({ startUrl: url, maxDepth, maxPages, sameDomainOnly });

      const successPages = pages.filter((p) => p.text.trim().length > 50 && !p.error);

      if (successPages.length === 0) {
        res.json({ crawled: 0, message: 'No extractable content found on this website' });
        return;
      }

      // Look up compilation name for batch display
      const domain = new URL(url).hostname;
      let compilationName: string | null = null;
      if (compilationId) {
        try {
          const { compilations } = await import('../models/schema.js');
          const [comp] = await db.select({ name: compilations.name }).from(compilations).where(eq(compilations.id, compilationId)).limit(1);
          compilationName = comp?.name ?? null;
        } catch { /* non-fatal */ }
      }

      // Create batch
      const [batch] = await db.insert(jobBatches).values({
        userId,
        name: `Web: ${domain} (${successPages.length} pages)`,
        source: 'web_crawl',
        sourceMetadata: { url, domain, maxDepth, maxPages, compilationId, compilationName },
        totalJobs: successPages.length,
        status: 'processing',
      }).returning();

      const batchId = batch!.id;
      const results: Array<{ url: string; title: string; jobId: string }> = [];

      for (const page of successPages) {
        const pageName = (page.title || '').trim() || page.url || `Page ${results.length + 1}`;
        const [job] = await db.insert(jobs).values({
          userId,
          type: 'kex_extract',
          status: 'pending',
          batchId,
          input: {
            source: 'web_crawl',
            fileName: pageName,
            url: page.url,
            ...(ontologyId ? { ontologyId, discoveryMode } : {}),
            ...(compilationId ? { compilationId } : {}),
          },
        }).returning();

        await addKexJob(job!.id, {
          userId,
          type: 'kex_extract',
          input: {
            text: `Title: ${page.title}\nURL: ${page.url}\n\n${page.text}`,
            ...(ontologyId ? { ontologyId, discoveryMode } : {}),
          },
        });

        results.push({ url: page.url, title: page.title, jobId: job!.id });
      }

      res.json({
        batchId,
        url,
        domain,
        crawled: pages.length,
        extracted: successPages.length,
        results,
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  },
);

// ─── POST /crawl/preview ─────────────────────────────────────────────────────
// Preview what would be crawled without creating jobs

router.post(
  '/crawl/preview',
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    const { url, maxDepth = 2, maxPages = 10, sameDomainOnly = true } = req.body as {
      url: string; maxDepth?: number; maxPages?: number; sameDomainOnly?: boolean;
    };

    if (!url) { res.status(400).json({ error: 'url is required' }); return; }

    try {
      const pages = await crawlWebsite({ startUrl: url, maxDepth, maxPages: Math.min(maxPages, 20), sameDomainOnly });

      res.json({
        url,
        pages: pages.map((p) => ({
          url: p.url,
          title: p.title,
          textLength: p.text.length,
          linkCount: p.links.length,
          status: p.statusCode,
          error: p.error,
        })),
        total: pages.length,
        extractable: pages.filter((p) => p.text.length > 50 && !p.error).length,
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  },
);

export default router;
