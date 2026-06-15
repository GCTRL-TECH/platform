import { Router, Request, Response } from 'express';
import { timingSafeEqual } from 'crypto';
import { db } from '../db/index.js';
import { appVersions } from '../db/schema.js';
import { eq } from 'drizzle-orm';

const router = Router();

/**
 * Constant-time string comparison that doesn't leak length via early return.
 * Compares SHA-equal-length buffers; mismatched lengths return false but still
 * run timingSafeEqual against a same-length copy to keep timing flat.
 */
function tokensMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    // Compare against itself to burn comparable time, then fail.
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}

/**
 * Publish a new app version from CI.
 *
 * Token-gated (NOT behind requireAdmin) so the build pipeline can call it with
 * a shared secret. Mounted at root with the full `/v1/versions` path, matching
 * activate/heartbeat routing.
 */
router.post('/v1/versions', async (req: Request, res: Response): Promise<void> => {
  const expected = process.env.VERSION_PUBLISH_TOKEN;
  if (!expected) {
    res.status(503).json({ error: 'publishing disabled' });
    return;
  }

  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing publish token' });
    return;
  }
  if (!tokensMatch(authHeader.slice(7), expected)) {
    res.status(401).json({ error: 'Invalid publish token' });
    return;
  }

  const { version, changelog, channel } = req.body as {
    version?: string; changelog?: string; channel?: string;
  };

  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) {
    res.status(400).json({ error: 'Invalid version (expected \\d+.\\d+.\\d+)' });
    return;
  }

  // Idempotent: if this exact version already exists, return ok without inserting.
  const [existing] = await db.select().from(appVersions)
    .where(eq(appVersions.version, version)).limit(1);

  if (!existing) {
    // Reuse the exact insert pattern from admin POST /admin/versions.
    await db.insert(appVersions).values({
      version,
      changelog: changelog ?? '',
      channel: channel ?? 'stable',
      updateRequired: false,
      rolloutPercent: 100,
    });
  }

  res.json({ ok: true, version });
});

export default router;
