/**
 * Google Workspace Connector
 * Handles: Google Drive, Gmail, Google Calendar
 * Fetches data and converts to text for KEX extraction.
 */

import { getValidToken } from './token-manager.js';

// ─── Google Drive ────────────────────────────────────────────────────────────

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string;
  size?: string;
  webViewLink?: string;
  parents?: string[];
}

// MIME types that KEX can extract text from
const EXTRACTABLE_MIMETYPES = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.google-apps.document',
  'application/vnd.google-apps.spreadsheet',
  'application/vnd.google-apps.presentation',
  'application/json',
  'application/xml',
  'text/xml',
  'text/plain',
  'text/csv',
  'text/html',
  'text/markdown',
  'application/rtf',
  'application/epub+zip',
  'application/vnd.oasis.opendocument.text',
  'message/rfc822',
  'image/png',
  'image/jpeg',
  'image/tiff',
  'image/bmp',
  'image/gif',
  'image/webp',
  // Audio
  'audio/mpeg',
  'audio/wav',
  'audio/ogg',
  'audio/flac',
  'audio/mp4',
  'audio/webm',
  // Video
  'video/mp4',
  'video/webm',
  'video/quicktime',
  'video/x-msvideo',
  'video/x-matroska',
  'video/mpeg',
  // Data
  'application/vnd.ms-excel',
  'application/vnd.ms-outlook',
  'application/x-yaml',
  'text/yaml',
  'application/toml',
]);

export function isExtractable(mimeType: string): boolean {
  return EXTRACTABLE_MIMETYPES.has(mimeType) || mimeType.startsWith('text/') || mimeType.startsWith('audio/') || mimeType.startsWith('video/');
}

export function isFolder(mimeType: string): boolean {
  return mimeType === 'application/vnd.google-apps.folder';
}

export async function listDriveFiles(
  connectorId: string,
  query?: string,
  pageToken?: string,
  pageSize = 50,
): Promise<{ files: DriveFile[]; nextPageToken?: string }> {
  const token = await getValidToken(connectorId);

  const params = new URLSearchParams({
    pageSize: String(pageSize),
    fields: 'nextPageToken,files(id,name,mimeType,modifiedTime,size,webViewLink,parents)',
    orderBy: 'modifiedTime desc',
  });

  if (query) params.set('q', query);
  if (pageToken) params.set('pageToken', pageToken);

  const resp = await fetch(
    `https://www.googleapis.com/drive/v3/files?${params.toString()}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );

  if (!resp.ok) throw new Error(`Drive API error: ${resp.status} ${await resp.text()}`);

  const data = (await resp.json()) as { files: DriveFile[]; nextPageToken?: string };
  return data;
}

/**
 * List contents of a specific folder.
 */
export async function listFolderContents(
  connectorId: string,
  folderId: string,
  pageToken?: string,
  pageSize = 100,
): Promise<{ files: DriveFile[]; nextPageToken?: string }> {
  return listDriveFiles(connectorId, `'${folderId}' in parents and trashed = false`, pageToken, pageSize);
}

/**
 * Recursively collect all extractable files from a folder and its subfolders.
 * Returns a flat list of files with their full path prefixed to the name.
 */
export async function listFolderRecursive(
  connectorId: string,
  folderId: string,
  pathPrefix = '',
  maxDepth = 10,
): Promise<DriveFile[]> {
  if (maxDepth <= 0) return [];

  const allFiles: DriveFile[] = [];
  let pageToken: string | undefined;

  do {
    const result = await listFolderContents(connectorId, folderId, pageToken, 100);

    for (const file of result.files) {
      if (isFolder(file.mimeType)) {
        // Recurse into subfolder
        const subFiles = await listFolderRecursive(
          connectorId,
          file.id,
          pathPrefix ? `${pathPrefix}/${file.name}` : file.name,
          maxDepth - 1,
        );
        allFiles.push(...subFiles);
      } else if (isExtractable(file.mimeType)) {
        allFiles.push({
          ...file,
          name: pathPrefix ? `${pathPrefix}/${file.name}` : file.name,
        });
      }
    }

    pageToken = result.nextPageToken;
  } while (pageToken);

  return allFiles;
}

/**
 * Get metadata for a single file by ID.
 */
export async function getDriveFile(
  connectorId: string,
  fileId: string,
): Promise<DriveFile> {
  const token = await getValidToken(connectorId);

  const resp = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}?fields=id,name,mimeType,modifiedTime,size,webViewLink,parents`,
    { headers: { Authorization: `Bearer ${token}` } },
  );

  if (!resp.ok) throw new Error(`Drive API error: ${resp.status}`);
  return (await resp.json()) as DriveFile;
}

export async function downloadDriveFile(
  connectorId: string,
  fileId: string,
  mimeType: string,
): Promise<{ content: Buffer; exportedMimeType: string }> {
  const token = await getValidToken(connectorId);

  // Google Docs/Sheets/Slides need export, regular files use direct download
  const isGoogleDoc = mimeType.startsWith('application/vnd.google-apps.');

  let url: string;
  let exportedMimeType: string;

  if (isGoogleDoc) {
    // Export Google Docs to plain text, Sheets to CSV, Slides to plain text
    const exportMap: Record<string, string> = {
      'application/vnd.google-apps.document': 'text/plain',
      'application/vnd.google-apps.spreadsheet': 'text/csv',
      'application/vnd.google-apps.presentation': 'text/plain',
      'application/vnd.google-apps.drawing': 'image/png',
    };
    exportedMimeType = exportMap[mimeType] || 'text/plain';
    url = `https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=${encodeURIComponent(exportedMimeType)}`;
  } else {
    exportedMimeType = mimeType;
    url = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;
  }

  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!resp.ok) throw new Error(`Drive download error: ${resp.status}`);

  const buffer = Buffer.from(await resp.arrayBuffer());
  return { content: buffer, exportedMimeType };
}

// ─── Gmail ───────────────────────────────────────────────────────────────────

export interface GmailThread {
  id: string;
  snippet: string;
  historyId: string;
}

export interface GmailMessage {
  id: string;
  threadId: string;
  subject: string;
  from: string;
  to: string;
  date: string;
  body: string;
}

export async function listGmailThreads(
  connectorId: string,
  query?: string,
  maxResults = 20,
): Promise<GmailThread[]> {
  const token = await getValidToken(connectorId);

  const params = new URLSearchParams({
    maxResults: String(maxResults),
  });
  if (query) params.set('q', query);

  const resp = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/threads?${params.toString()}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );

  if (!resp.ok) throw new Error(`Gmail API error: ${resp.status}`);
  const data = (await resp.json()) as { threads?: GmailThread[] };
  return data.threads || [];
}

export async function getGmailThread(
  connectorId: string,
  threadId: string,
): Promise<GmailMessage[]> {
  const token = await getValidToken(connectorId);

  const resp = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/threads/${threadId}?format=full`,
    { headers: { Authorization: `Bearer ${token}` } },
  );

  if (!resp.ok) throw new Error(`Gmail thread error: ${resp.status}`);

  const data = (await resp.json()) as {
    messages: Array<{
      id: string;
      threadId: string;
      payload: {
        headers: Array<{ name: string; value: string }>;
        body?: { data?: string };
        parts?: Array<{ mimeType: string; body?: { data?: string } }>;
      };
    }>;
  };

  return data.messages.map((msg) => {
    const headers = msg.payload.headers;
    const getHeader = (name: string) =>
      headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value || '';

    // Extract body text (prefer plain text)
    let body = '';
    if (msg.payload.body?.data) {
      body = Buffer.from(msg.payload.body.data, 'base64url').toString('utf-8');
    } else if (msg.payload.parts) {
      const textPart = msg.payload.parts.find((p) => p.mimeType === 'text/plain');
      if (textPart?.body?.data) {
        body = Buffer.from(textPart.body.data, 'base64url').toString('utf-8');
      }
    }

    return {
      id: msg.id,
      threadId: msg.threadId,
      subject: getHeader('Subject'),
      from: getHeader('From'),
      to: getHeader('To'),
      date: getHeader('Date'),
      body,
    };
  });
}

export function gmailThreadToText(messages: GmailMessage[]): string {
  return messages
    .map(
      (m) =>
        `From: ${m.from}\nTo: ${m.to}\nDate: ${m.date}\nSubject: ${m.subject}\n\n${m.body}`,
    )
    .join('\n\n---\n\n');
}

// ─── Google Calendar ─────────────────────────────────────────────────────────

export interface CalendarEvent {
  id: string;
  summary: string;
  description?: string;
  start: { dateTime?: string; date?: string };
  end: { dateTime?: string; date?: string };
  location?: string;
  attendees?: Array<{ email: string; displayName?: string; responseStatus?: string }>;
  organizer?: { email: string; displayName?: string };
}

export async function listCalendarEvents(
  connectorId: string,
  timeMin?: string,
  timeMax?: string,
  maxResults = 50,
): Promise<CalendarEvent[]> {
  const token = await getValidToken(connectorId);

  const params = new URLSearchParams({
    maxResults: String(maxResults),
    singleEvents: 'true',
    orderBy: 'startTime',
  });

  if (timeMin) params.set('timeMin', timeMin);
  else params.set('timeMin', new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString());

  if (timeMax) params.set('timeMax', timeMax);
  else params.set('timeMax', new Date().toISOString());

  const resp = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params.toString()}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );

  if (!resp.ok) throw new Error(`Calendar API error: ${resp.status}`);
  const data = (await resp.json()) as { items?: CalendarEvent[] };
  return data.items || [];
}

export function calendarEventsToText(events: CalendarEvent[]): string {
  return events
    .map((e) => {
      const start = e.start.dateTime || e.start.date || '';
      const end = e.end.dateTime || e.end.date || '';
      const attendees = e.attendees
        ?.map((a) => `${a.displayName || a.email} (${a.responseStatus || 'unknown'})`)
        .join(', ');
      const parts = [
        `Event: ${e.summary}`,
        `When: ${start} to ${end}`,
        e.location ? `Where: ${e.location}` : '',
        e.organizer ? `Organizer: ${e.organizer.displayName || e.organizer.email}` : '',
        attendees ? `Attendees: ${attendees}` : '',
        e.description ? `Description: ${e.description}` : '',
      ].filter(Boolean);
      return parts.join('\n');
    })
    .join('\n\n---\n\n');
}
