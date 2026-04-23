import { Router, Request, Response } from 'express';
import { db } from '../db/index.js';
import { licenses, users, tokenUsage } from '../db/schema.js';
import { eq, sql } from 'drizzle-orm';
import { verifyLicenseJWT, signLicenseJWT } from '../lib/jwt.js';
import { getCurrentVersion } from '../lib/version.js';

const router = Router();

router.post('/v1/heartbeat', async (req: Request, res: Response): Promise<void> => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing license JWT' });
    return;
  }

  let claims;
  try {
    claims = await verifyLicenseJWT(authHeader.slice(7));
  } catch {
    res.status(401).json({ error: 'Invalid or expired license JWT' });
    return;
  }

  const { usage_report } = req.body;

  if (Array.isArray(usage_report) && usage_report.length > 0) {
    const records = usage_report.map((u: { action: string; chars_processed: number; credits_spent: number; timestamp: string }) => ({
      userId: claims.sub,
      licenseId: claims.licenseId,
      action: u.action,
      charsProcessed: u.chars_processed,
      creditsSpent: u.credits_spent,
      isOverdraft: u.credits_spent < 0,
      createdAt: new Date(u.timestamp),
    }));

    await db.insert(tokenUsage).values(records);

    const totalSpent = records.reduce((sum, r) => sum + r.creditsSpent, 0);
    await db.update(users)
      .set({ creditsBalance: sql`credits_balance - ${totalSpent}` })
      .where(eq(users.id, claims.sub));
  }

  await db.update(licenses)
    .set({ lastHeartbeatAt: new Date(), status: 'active' })
    .where(eq(licenses.id, claims.licenseId));

  const [user] = await db.select().from(users).where(eq(users.id, claims.sub)).limit(1);
  const { version, updateAvailable, updateRequired } = await getCurrentVersion(user.tier);

  const newJwt = await signLicenseJWT({
    sub: user.id,
    licenseId: claims.licenseId,
    tier: user.tier,
    creditsBalance: user.creditsBalance,
    overdraftLimit: user.overdraftLimit,
    hardwareFingerprint: claims.hardwareFingerprint,
    latestVersion: version,
    updateAvailable,
    updateRequired,
  });

  res.json({
    license_jwt: newJwt,
    credits_balance: user.creditsBalance,
    tier: user.tier,
    latest_version: version,
    update_available: updateAvailable,
    update_required: updateRequired,
  });
});

export default router;
