import { generateLicenseKey, validateLicenseKeyFormat } from '../licenseKey.js';

process.env.LICENSE_HMAC_SECRET = 'test-secret-for-jest';

test('generateLicenseKey produces GCTRL-XXXX-XXXX-XXXX-XXXX-XXXX format', () => {
  const key = generateLicenseKey();
  expect(key).toMatch(/^GCTRL-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}$/);
});

test('validateLicenseKeyFormat accepts valid key', () => {
  const key = generateLicenseKey();
  expect(validateLicenseKeyFormat(key)).toBe(true);
});

test('validateLicenseKeyFormat rejects tampered checksum', () => {
  const key = generateLicenseKey();
  const tampered = key.slice(0, -1) + (key.endsWith('X') ? 'Y' : 'X');
  expect(validateLicenseKeyFormat(tampered)).toBe(false);
});

test('validateLicenseKeyFormat rejects wrong prefix', () => {
  expect(validateLicenseKeyFormat('WRONG-AABB-CCDD-EEFF-GGHH-IIII')).toBe(false);
});
