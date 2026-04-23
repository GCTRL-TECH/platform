import { createHmac } from 'crypto';

export async function generateRegistryToken(userId: string): Promise<string> {
  // Short-lived token for pulling from ghcr.io (Phase 4 will wire real GHCR PAT)
  const token = createHmac('sha256', process.env.LICENSE_HMAC_SECRET!)
    .update(`${userId}:${Math.floor(Date.now() / 86400000)}`) // rotates daily
    .digest('hex');
  return token;
}
