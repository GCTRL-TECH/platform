import { computeFingerprint } from '../fingerprint.js';

test('fingerprint returns 64-char hex string', async () => {
  const fp = await computeFingerprint();
  expect(fp).toMatch(/^[a-f0-9]{64}$/);
});

test('fingerprint is deterministic across calls', async () => {
  const fp1 = await computeFingerprint();
  const fp2 = await computeFingerprint();
  expect(fp1).toBe(fp2);
});
