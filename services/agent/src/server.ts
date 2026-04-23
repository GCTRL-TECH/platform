import express from 'express';
import { licenseCache } from './license.js';
import { usageQueue } from './usageQueue.js';
import { calculateCredits } from './credits.js';
import type { CreditAction } from './credits.js';

const app = express();
app.use(express.json());

app.post('/check', (req, res) => {
  const { action, chars } = req.body as { action: CreditAction; chars?: number };

  if (!licenseCache.isValid()) {
    res.status(403).json({ allowed: false, reason: 'License invalid or expired' });
    return;
  }

  if (licenseCache.isUpdateRequired()) {
    res.status(403).json({
      allowed: false,
      reason: 'Required update pending. Run: curl -fsSL https://gctrl.tech/update | bash',
    });
    return;
  }

  const credits = calculateCredits(action, chars ?? 0);
  if (!licenseCache.canSpend(credits)) {
    res.status(402).json({ allowed: false, reason: 'Insufficient credits', balance: licenseCache.getBalance() });
    return;
  }

  licenseCache.deductLocal(credits);
  res.json({ allowed: true, credits_spent: credits, balance: licenseCache.getBalance() });
});

app.post('/report', (req, res) => {
  const { action, chars_processed, credits_spent } = req.body as {
    action: string;
    chars_processed: number;
    credits_spent: number;
  };
  usageQueue.enqueue({ action, chars_processed, credits_spent });
  res.json({ ok: true });
});

app.get('/status', (_req, res) => {
  res.json({
    valid: licenseCache.isValid(),
    tier: licenseCache.getTier(),
    balance: licenseCache.getBalance(),
    updateAvailable: licenseCache.isUpdateAvailable(),
    updateRequired: licenseCache.isUpdateRequired(),
    latestVersion: licenseCache.getLatestVersion(),
  });
});

export function startLocalServer(port = 7070) {
  app.listen(port, '127.0.0.1', () => {
    console.log(`gctrl-agent local server on 127.0.0.1:${port}`);
  });
}
