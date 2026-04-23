/**
 * OAuth2 Configuration for external connectors.
 *
 * Priority: Database (connector_configs table) > Environment variables
 * Admins can configure OAuth app credentials via the frontend Settings page.
 * Env vars serve as fallback for Docker-level configuration.
 */

import { eq } from 'drizzle-orm';
import { db } from '../models/db.js';
import { connectorConfigs } from '../models/schema.js';

export interface OAuthProviderConfig {
  clientId: string;
  clientSecret: string;
  authUrl: string;
  tokenUrl: string;
  scopes: string[];
  redirectUri: string;
}

const BASE_URL = process.env['GCTRL_BASE_URL'] || 'http://localhost:4000';

// ─── Static provider metadata (URLs, scopes, redirects) ─────────────────────

interface ProviderMeta {
  authUrl: string;
  tokenUrl: string;
  scopes: string[];
  redirectPath: string;
  envClientId: string;
  envClientSecret: string;
}

const PROVIDER_META: Record<string, ProviderMeta> = {
  google: {
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scopes: [
      'https://www.googleapis.com/auth/drive.readonly',
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/calendar.readonly',
      'https://www.googleapis.com/auth/userinfo.email',
    ],
    redirectPath: '/api/connectors/google/callback',
    envClientId: 'GOOGLE_CLIENT_ID',
    envClientSecret: 'GOOGLE_CLIENT_SECRET',
  },
  microsoft: {
    authUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    scopes: ['offline_access', 'User.Read', 'Files.Read.All', 'Mail.Read', 'Calendars.Read'],
    redirectPath: '/api/connectors/microsoft/callback',
    envClientId: 'MICROSOFT_CLIENT_ID',
    envClientSecret: 'MICROSOFT_CLIENT_SECRET',
  },
  slack: {
    authUrl: 'https://slack.com/oauth/v2/authorize',
    tokenUrl: 'https://slack.com/api/oauth.v2.access',
    scopes: [
      'channels:history', 'channels:read', 'groups:history',
      'groups:read', 'users:read', 'users:read.email',
    ],
    redirectPath: '/api/connectors/slack/callback',
    envClientId: 'SLACK_CLIENT_ID',
    envClientSecret: 'SLACK_CLIENT_SECRET',
  },
  github: {
    authUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    scopes: ['repo', 'read:user', 'user:email'],
    redirectPath: '/api/connectors/github/callback',
    envClientId: 'GITHUB_CLIENT_ID',
    envClientSecret: 'GITHUB_CLIENT_SECRET',
  },
};

// ─── Dynamic config loading (DB first, env fallback) ─────────────────────────

export async function getProviderConfig(provider: string): Promise<OAuthProviderConfig> {
  const meta = PROVIDER_META[provider];
  if (!meta) throw new Error(`Unknown OAuth provider: ${provider}`);

  // Try database first
  let clientId = '';
  let clientSecret = '';

  try {
    const [dbConfig] = await db
      .select({ clientId: connectorConfigs.clientId, clientSecret: connectorConfigs.clientSecret, isActive: connectorConfigs.isActive })
      .from(connectorConfigs)
      .where(eq(connectorConfigs.provider, provider))
      .limit(1);

    if (dbConfig && dbConfig.isActive) {
      clientId = dbConfig.clientId;
      clientSecret = dbConfig.clientSecret;
    }
  } catch {
    // DB not available, fall through to env vars
  }

  // Fall back to environment variables
  if (!clientId) clientId = process.env[meta.envClientId] || '';
  if (!clientSecret) clientSecret = process.env[meta.envClientSecret] || '';

  return {
    clientId,
    clientSecret,
    authUrl: meta.authUrl,
    tokenUrl: meta.tokenUrl,
    scopes: meta.scopes,
    redirectUri: `${BASE_URL}${meta.redirectPath}`,
  };
}

// ─── Provider list for frontend ──────────────────────────────────────────────

export interface ProviderInfo {
  id: string;
  name: string;
  description: string;
  setupUrl: string;
  redirectUri: string;
  scopes: string[];
}

export function getProviderList(): ProviderInfo[] {
  return [
    {
      id: 'google',
      name: 'Google Workspace',
      description: 'Connect Google Drive, Gmail, Calendar',
      setupUrl: 'https://console.cloud.google.com/apis/credentials',
      redirectUri: `${BASE_URL}/api/connectors/google/callback`,
      scopes: PROVIDER_META.google!.scopes,
    },
    {
      id: 'microsoft',
      name: 'Microsoft 365',
      description: 'Connect OneDrive, SharePoint, Outlook',
      setupUrl: 'https://portal.azure.com/#blade/Microsoft_AAD_RegisteredApps/ApplicationsListBlade',
      redirectUri: `${BASE_URL}/api/connectors/microsoft/callback`,
      scopes: PROVIDER_META.microsoft!.scopes,
    },
    {
      id: 'slack',
      name: 'Slack',
      description: 'Connect Slack workspace channels',
      setupUrl: 'https://api.slack.com/apps',
      redirectUri: `${BASE_URL}/api/connectors/slack/callback`,
      scopes: PROVIDER_META.slack!.scopes,
    },
    {
      id: 'github',
      name: 'GitHub',
      description: 'Connect GitHub repos, issues, PRs',
      setupUrl: 'https://github.com/settings/developers',
      redirectUri: `${BASE_URL}/api/connectors/github/callback`,
      scopes: PROVIDER_META.github!.scopes,
    },
  ];
}

