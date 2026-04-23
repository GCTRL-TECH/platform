/**
 * Microsoft 365 Connector
 * Handles: OneDrive/SharePoint, Outlook Mail
 * Uses Microsoft Graph API.
 */

import { getValidToken } from './token-manager.js';

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

// ─── OneDrive / SharePoint ───────────────────────────────────────────────────

export interface DriveItem {
  id: string;
  name: string;
  size: number;
  lastModifiedDateTime: string;
  webUrl: string;
  file?: { mimeType: string };
  folder?: { childCount: number };
}

export async function listOneDriveFiles(
  connectorId: string,
  folderId?: string,
  top = 50,
): Promise<{ items: DriveItem[]; nextLink?: string }> {
  const token = await getValidToken(connectorId);

  const path = folderId
    ? `/me/drive/items/${folderId}/children`
    : '/me/drive/root/children';

  const resp = await fetch(`${GRAPH_BASE}${path}?$top=${top}&$orderby=lastModifiedDateTime desc`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!resp.ok) throw new Error(`OneDrive API error: ${resp.status} ${await resp.text()}`);

  const data = (await resp.json()) as {
    value: DriveItem[];
    '@odata.nextLink'?: string;
  };

  return { items: data.value, nextLink: data['@odata.nextLink'] };
}

export async function downloadOneDriveFile(
  connectorId: string,
  itemId: string,
): Promise<{ content: Buffer; mimeType: string }> {
  const token = await getValidToken(connectorId);

  const resp = await fetch(`${GRAPH_BASE}/me/drive/items/${itemId}/content`, {
    headers: { Authorization: `Bearer ${token}` },
    redirect: 'follow',
  });

  if (!resp.ok) throw new Error(`OneDrive download error: ${resp.status}`);

  const mimeType = resp.headers.get('content-type') || 'application/octet-stream';
  const buffer = Buffer.from(await resp.arrayBuffer());
  return { content: buffer, mimeType };
}

export async function searchOneDrive(
  connectorId: string,
  query: string,
  top = 25,
): Promise<DriveItem[]> {
  const token = await getValidToken(connectorId);

  const resp = await fetch(
    `${GRAPH_BASE}/me/drive/root/search(q='${encodeURIComponent(query)}')?$top=${top}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );

  if (!resp.ok) throw new Error(`OneDrive search error: ${resp.status}`);

  const data = (await resp.json()) as { value: DriveItem[] };
  return data.value;
}

// ─── Outlook Mail ────────────────────────────────────────────────────────────

export interface OutlookMessage {
  id: string;
  subject: string;
  bodyPreview: string;
  body: { contentType: string; content: string };
  from: { emailAddress: { name: string; address: string } };
  toRecipients: Array<{ emailAddress: { name: string; address: string } }>;
  receivedDateTime: string;
  conversationId: string;
  hasAttachments: boolean;
}

export async function listOutlookMessages(
  connectorId: string,
  filter?: string,
  top = 25,
): Promise<OutlookMessage[]> {
  const token = await getValidToken(connectorId);

  const params = new URLSearchParams({
    $top: String(top),
    $orderby: 'receivedDateTime desc',
    $select: 'id,subject,bodyPreview,body,from,toRecipients,receivedDateTime,conversationId,hasAttachments',
  });

  if (filter) params.set('$filter', filter);

  const resp = await fetch(`${GRAPH_BASE}/me/messages?${params.toString()}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!resp.ok) throw new Error(`Outlook API error: ${resp.status}`);

  const data = (await resp.json()) as { value: OutlookMessage[] };
  return data.value;
}

export async function getOutlookMessage(
  connectorId: string,
  messageId: string,
): Promise<OutlookMessage> {
  const token = await getValidToken(connectorId);

  const resp = await fetch(`${GRAPH_BASE}/me/messages/${messageId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!resp.ok) throw new Error(`Outlook message error: ${resp.status}`);
  return (await resp.json()) as OutlookMessage;
}

export async function searchOutlookMessages(
  connectorId: string,
  query: string,
  top = 25,
): Promise<OutlookMessage[]> {
  const token = await getValidToken(connectorId);

  const resp = await fetch(
    `${GRAPH_BASE}/me/messages?$search="${encodeURIComponent(query)}"&$top=${top}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );

  if (!resp.ok) throw new Error(`Outlook search error: ${resp.status}`);

  const data = (await resp.json()) as { value: OutlookMessage[] };
  return data.value;
}

export function outlookMessageToText(msg: OutlookMessage): string {
  const to = msg.toRecipients
    .map((r) => `${r.emailAddress.name} <${r.emailAddress.address}>`)
    .join(', ');

  // Strip HTML if body is HTML
  let body = msg.body.content;
  if (msg.body.contentType === 'html') {
    body = body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  }

  return [
    `From: ${msg.from.emailAddress.name} <${msg.from.emailAddress.address}>`,
    `To: ${to}`,
    `Date: ${msg.receivedDateTime}`,
    `Subject: ${msg.subject}`,
    '',
    body,
  ].join('\n');
}

export function outlookMessagesToText(messages: OutlookMessage[]): string {
  return messages.map(outlookMessageToText).join('\n\n---\n\n');
}
