import { LicenseCache } from '../license.js';

test('canSpend returns false when balance is 0 on free tier', () => {
  const cache = new LicenseCache();
  cache.setFromClaims({ tier: 'free', creditsBalance: 0, overdraftLimit: 0 } as any);
  expect(cache.canSpend(1)).toBe(false);
});

test('canSpend returns true when balance is positive', () => {
  const cache = new LicenseCache();
  cache.setFromClaims({ tier: 'pro', creditsBalance: 500, overdraftLimit: -10000 } as any);
  expect(cache.canSpend(100)).toBe(true);
});

test('canSpend allows overdraft for paid tiers', () => {
  const cache = new LicenseCache();
  cache.setFromClaims({ tier: 'starter', creditsBalance: -4000, overdraftLimit: -5000 } as any);
  expect(cache.canSpend(500)).toBe(true);   // -4000 - 500 = -4500 > -5000
  expect(cache.canSpend(1500)).toBe(false); // -4000 - 1500 = -5500 < -5000
});
