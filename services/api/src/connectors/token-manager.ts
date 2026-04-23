/**
 * Token Manager - handles OAuth token refresh for all providers.
 * Automatically refreshes expired tokens before making API calls.
 */

import { eq } from 'drizzle-orm';
import { db } from '../models/db.js';
import { oauthConnectors } from '../models/schema.js';
import { getProviderConfig } from './oauth-config.js';

export async function getValidToken(connectorId: string): Promise<string> {
  const [connector] = await db
    .select()
    .from(oauthConnectors)
    .where(eq(oauthConnectors.id, connectorId))
    .limit(1);

  if (!connector) throw new Error(`Connector ${connectorId} not found`);
  if (!connector.isActive) throw new Error(`Connector ${connectorId} is disabled`);

  // Check if token is still valid (with 5-minute buffer)
  const expiresAt = connector.tokenExpiresAt;
  if (expiresAt && expiresAt.getTime() > Date.now() + 5 * 60 * 1000) {
    return connector.accessToken;
  }

  // Token expired - refresh it
  if (!connector.refreshToken) {
    throw new Error(`Connector ${connectorId} has no refresh token and access token expired`);
  }

  const config = await getProviderConfig(connector.provider);

  const params = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    refresh_token: connector.refreshToken,
    grant_type: 'refresh_token',
  });

  const resp = await fetch(config.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });

  if (!resp.ok) {
    const errorBody = await resp.text();
    console.error(`[TokenManager] Refresh failed for ${connectorId}:`, errorBody);
    // Mark connector as inactive
    await db
      .update(oauthConnectors)
      .set({ isActive: false, updatedAt: new Date() })
      .where(eq(oauthConnectors.id, connectorId));
    throw new Error(`Token refresh failed: ${resp.status}`);
  }

  const tokens = (await resp.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
  };

  const newExpiresAt = tokens.expires_in
    ? new Date(Date.now() + tokens.expires_in * 1000)
    : new Date(Date.now() + 3600 * 1000); // default 1 hour

  await db
    .update(oauthConnectors)
    .set({
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token || connector.refreshToken,
      tokenExpiresAt: newExpiresAt,
      updatedAt: new Date(),
    })
    .where(eq(oauthConnectors.id, connectorId));

  console.log(`[TokenManager] Refreshed token for connector ${connectorId}`);
  return tokens.access_token;
}
