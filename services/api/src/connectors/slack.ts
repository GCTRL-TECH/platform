/**
 * Slack Connector
 * Handles: Channels, Messages, Threads
 * Uses Slack Web API with OAuth2 bot token.
 */

import { getValidToken } from './token-manager.js';

const SLACK_API = 'https://slack.com/api';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SlackChannel {
  id: string;
  name: string;
  is_channel: boolean;
  is_private: boolean;
  topic?: { value: string };
  purpose?: { value: string };
  num_members?: number;
}

export interface SlackMessage {
  type: string;
  user?: string;
  text: string;
  ts: string;
  thread_ts?: string;
  reply_count?: number;
}

export interface SlackUser {
  id: string;
  name: string;
  real_name?: string;
  profile?: { display_name?: string; email?: string };
}

// ─── Helper ──────────────────────────────────────────────────────────────────

async function slackApi(
  connectorId: string,
  method: string,
  params?: Record<string, string>,
): Promise<Record<string, unknown>> {
  const token = await getValidToken(connectorId);

  const url = new URL(`${SLACK_API}/${method}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, v);
    }
  }

  const resp = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!resp.ok) throw new Error(`Slack API error: ${resp.status}`);

  const data = (await resp.json()) as Record<string, unknown>;
  if (!data.ok) {
    throw new Error(`Slack API error: ${data.error as string}`);
  }

  return data;
}

// ─── Channels ────────────────────────────────────────────────────────────────

export async function listChannels(
  connectorId: string,
  types = 'public_channel,private_channel',
  limit = 100,
): Promise<SlackChannel[]> {
  const data = await slackApi(connectorId, 'conversations.list', {
    types,
    limit: String(limit),
    exclude_archived: 'true',
  });

  return (data.channels as SlackChannel[]) || [];
}

// ─── Messages ────────────────────────────────────────────────────────────────

export async function getChannelHistory(
  connectorId: string,
  channelId: string,
  limit = 100,
  oldest?: string,
): Promise<SlackMessage[]> {
  const params: Record<string, string> = {
    channel: channelId,
    limit: String(limit),
  };
  if (oldest) params.oldest = oldest;

  const data = await slackApi(connectorId, 'conversations.history', params);
  return (data.messages as SlackMessage[]) || [];
}

export async function getThreadReplies(
  connectorId: string,
  channelId: string,
  threadTs: string,
): Promise<SlackMessage[]> {
  const data = await slackApi(connectorId, 'conversations.replies', {
    channel: channelId,
    ts: threadTs,
  });

  return (data.messages as SlackMessage[]) || [];
}

// ─── Users ───────────────────────────────────────────────────────────────────

const userCache = new Map<string, SlackUser>();

export async function getUser(connectorId: string, userId: string): Promise<SlackUser | null> {
  if (userCache.has(userId)) return userCache.get(userId)!;

  try {
    const data = await slackApi(connectorId, 'users.info', { user: userId });
    const user = data.user as SlackUser;
    userCache.set(userId, user);
    return user;
  } catch {
    return null;
  }
}

// ─── Text Conversion ─────────────────────────────────────────────────────────

export async function channelMessagesToText(
  connectorId: string,
  channelName: string,
  messages: SlackMessage[],
): Promise<string> {
  const lines: string[] = [`Channel: #${channelName}`, ''];

  for (const msg of messages.reverse()) {
    let userName = msg.user || 'unknown';
    if (msg.user) {
      const user = await getUser(connectorId, msg.user);
      if (user) {
        userName = user.real_name || user.profile?.display_name || user.name;
      }
    }

    const ts = new Date(parseFloat(msg.ts) * 1000).toISOString();
    lines.push(`[${ts}] ${userName}: ${msg.text}`);

    // Include thread context
    if (msg.reply_count && msg.reply_count > 0 && msg.thread_ts) {
      lines.push(`  (thread with ${msg.reply_count} replies)`);
    }
  }

  return lines.join('\n');
}
