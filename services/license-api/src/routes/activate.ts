import { Router, Request, Response } from 'express';
import { db } from '../db/index.js';
import { licenses, users } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { validateLicenseKeyFormat } from '../lib/licenseKey.js';
import { signLicenseJWT } from '../lib/jwt.js';
import { generateRegistryToken } from '../lib/registryToken.js';
import { getCurrentVersion } from '../lib/version.js';

const router = Router();

router.post('/v1/activate', async (req: Request, res: Response): Promise<void> => {
  const { license_key, hardware_fingerprint } = req.body;

  if (!license_key || !hardware_fingerprint) {
    res.status(400).json({ error: 'license_key and hardware_fingerprint required' });
    return;
  }

  if (!validateLicenseKeyFormat(license_key)) {
    res.status(400).json({ error: 'Invalid license key format' });
    return;
  }

  const license = await db.query.licenses.findFirst({
    where: eq(licenses.licenseKey, license_key),
    with: { user: true },
  });

  if (!license) {
    res.status(404).json({ error: 'License key not found' });
    return;
  }

  if (license.status === 'revoked') {
    res.status(403).json({ error: 'License has been revoked' });
    return;
  }

  if (license.hardwareFingerprint && license.hardwareFingerprint !== hardware_fingerprint) {
    const reassignmentsThisMonth = license.seatReassignments;
    const lastReassignment = license.lastReassignmentAt;
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const limit = license.tier === 'free' ? 5 : 20;
    if (lastReassignment && lastReassignment > thirtyDaysAgo && reassignmentsThisMonth >= limit) {
      res.status(403).json({ error: `Maximum seat reassignments (${limit}/30 days) reached. Reset at gctrl.tech/dashboard or contact support.` });
      return;
    }

    await db.update(licenses)
      .set({ seatReassignments: reassignmentsThisMonth + 1, lastReassignmentAt: new Date() })
      .where(eq(licenses.id, license.id));
  }

  await db.update(licenses)
    .set({ status: 'active', hardwareFingerprint: hardware_fingerprint, activatedAt: new Date(), lastHeartbeatAt: new Date() })
    .where(eq(licenses.id, license.id));

  const user = (license as any).user;
  const { version, updateAvailable, updateRequired } = await getCurrentVersion(user.tier);

  const jwt = await signLicenseJWT({
    sub: user.id,
    licenseId: license.id,
    tier: user.tier,
    creditsBalance: user.creditsBalance,
    overdraftLimit: user.overdraftLimit,
    hardwareFingerprint: hardware_fingerprint,
    latestVersion: version,
    updateAvailable,
    updateRequired,
  });

  const registryToken = await generateRegistryToken(user.id);

  res.json({
    license_jwt: jwt,
    registry_token: registryToken,
    tier: user.tier,
    credits_balance: user.creditsBalance,
    latest_version: version,
  });
});

export default router;
