import { randomBytes, createHmac } from 'crypto';

function getHmacSecret(): string {
  return process.env.LICENSE_HMAC_SECRET!;
}

function randomSegment(): string {
  return randomBytes(2).toString('hex').toUpperCase();
}

export function generateLicenseKey(): string {
  const segments = [randomSegment(), randomSegment(), randomSegment(), randomSegment()];
  const body = segments.join('-');
  const checksum = createHmac('sha256', getHmacSecret())
    .update(body)
    .digest('hex')
    .slice(0, 4)
    .toUpperCase();
  return `GCTRL-${body}-${checksum}`;
}

export function validateLicenseKeyFormat(key: string): boolean {
  if (!key.startsWith('GCTRL-')) return false;
  const parts = key.split('-');
  if (parts.length !== 6) return false;
  const body = parts.slice(1, 5).join('-');
  const checksum = parts[5];
  const expected = createHmac('sha256', getHmacSecret())
    .update(body)
    .digest('hex')
    .slice(0, 4)
    .toUpperCase();
  return checksum === expected;
}
