/**
 * Cloud Storage Connectors
 * S3-compatible (AWS S3, GCS, Azure Blob, MinIO), Dropbox
 * Lists objects, downloads files, feeds to KEX.
 * Uses native fetch + S3 signature — no AWS SDK needed.
 */

import { createHmac, createHash } from 'crypto';

export interface S3Config {
  provider: 's3' | 'gcs' | 'azure' | 'minio';
  endpoint: string;       // e.g. https://s3.amazonaws.com, https://storage.googleapis.com
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
}

export interface StorageObject {
  key: string;
  size: number;
  lastModified: string;
  etag?: string;
}

// ─── S3-compatible (AWS, GCS, MinIO) ─────────────────────────────────────────

export async function listS3Objects(config: S3Config, prefix = '', maxKeys = 100): Promise<StorageObject[]> {
  const url = `${config.endpoint}/${config.bucket}?list-type=2&prefix=${encodeURIComponent(prefix)}&max-keys=${maxKeys}`;
  const headers = signS3Request('GET', `/${config.bucket}`, config);

  const resp = await fetch(url, { headers });
  if (!resp.ok) throw new Error(`S3 list error: ${resp.status} ${await resp.text()}`);

  const xml = await resp.text();
  return parseS3ListResponse(xml);
}

export async function downloadS3Object(config: S3Config, key: string): Promise<{ content: Buffer; contentType: string }> {
  const url = `${config.endpoint}/${config.bucket}/${encodeURIComponent(key)}`;
  const headers = signS3Request('GET', `/${config.bucket}/${key}`, config);

  const resp = await fetch(url, { headers });
  if (!resp.ok) throw new Error(`S3 download error: ${resp.status}`);

  const contentType = resp.headers.get('content-type') || 'application/octet-stream';
  const buffer = Buffer.from(await resp.arrayBuffer());
  return { content: buffer, contentType };
}

function signS3Request(method: string, path: string, config: S3Config): Record<string, string> {
  const now = new Date();
  const dateStamp = now.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
  const shortDate = dateStamp!.slice(0, 8);

  const headers: Record<string, string> = {
    'Host': new URL(config.endpoint).host,
    'x-amz-date': dateStamp!,
    'x-amz-content-sha256': 'UNSIGNED-PAYLOAD',
  };

  // Simplified signing (for basic operations)
  const credential = `${config.accessKeyId}/${shortDate}/${config.region}/s3/aws4_request`;
  const signedHeaders = Object.keys(headers).sort().join(';').toLowerCase();

  const canonicalRequest = [
    method, path, '',
    ...Object.entries(headers).sort().map(([k, v]) => `${k.toLowerCase()}:${v}`),
    '', signedHeaders, 'UNSIGNED-PAYLOAD',
  ].join('\n');

  const stringToSign = [
    'AWS4-HMAC-SHA256', dateStamp,
    `${shortDate}/${config.region}/s3/aws4_request`,
    createHash('sha256').update(canonicalRequest).digest('hex'),
  ].join('\n');

  const signingKey = getS3SignatureKey(config.secretAccessKey, shortDate!, config.region, 's3');
  const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');

  headers['Authorization'] = `AWS4-HMAC-SHA256 Credential=${credential}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return headers;
}

function getS3SignatureKey(key: string, dateStamp: string, region: string, service: string): Buffer {
  const kDate = createHmac('sha256', `AWS4${key}`).update(dateStamp).digest();
  const kRegion = createHmac('sha256', kDate).update(region).digest();
  const kService = createHmac('sha256', kRegion).update(service).digest();
  return createHmac('sha256', kService).update('aws4_request').digest();
}

function parseS3ListResponse(xml: string): StorageObject[] {
  const objects: StorageObject[] = [];
  const contentRegex = /<Contents>([\s\S]*?)<\/Contents>/g;
  let match;

  while ((match = contentRegex.exec(xml)) !== null) {
    const block = match[1]!;
    const key = block.match(/<Key>(.*?)<\/Key>/)?.[1] || '';
    const size = parseInt(block.match(/<Size>(.*?)<\/Size>/)?.[1] || '0');
    const lastModified = block.match(/<LastModified>(.*?)<\/LastModified>/)?.[1] || '';
    const etag = block.match(/<ETag>(.*?)<\/ETag>/)?.[1]?.replace(/"/g, '');

    if (key && !key.endsWith('/')) {
      objects.push({ key, size, lastModified, etag });
    }
  }

  return objects;
}

// ─── Dropbox ─────────────────────────────────────────────────────────────────

export interface DropboxConfig {
  accessToken: string;
}

export async function listDropboxFiles(config: DropboxConfig, path = ''): Promise<StorageObject[]> {
  const resp = await fetch('https://api.dropboxapi.com/2/files/list_folder', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${config.accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ path: path || '', recursive: false, limit: 100 }),
  });

  if (!resp.ok) throw new Error(`Dropbox list error: ${resp.status}`);

  const data = await resp.json() as { entries: Array<{ '.tag': string; name: string; path_lower: string; size?: number; server_modified?: string }> };

  return data.entries
    .filter((e) => e['.tag'] === 'file')
    .map((e) => ({
      key: e.path_lower,
      size: e.size || 0,
      lastModified: e.server_modified || '',
    }));
}

export async function downloadDropboxFile(config: DropboxConfig, path: string): Promise<{ content: Buffer; contentType: string }> {
  const resp = await fetch('https://content.dropboxapi.com/2/files/download', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${config.accessToken}`,
      'Dropbox-API-Arg': JSON.stringify({ path }),
    },
  });

  if (!resp.ok) throw new Error(`Dropbox download error: ${resp.status}`);

  const contentType = resp.headers.get('content-type') || 'application/octet-stream';
  const buffer = Buffer.from(await resp.arrayBuffer());
  return { content: buffer, contentType };
}

// ─── Helper: get mimetype from filename ──────────────────────────────────────

export function mimeFromKey(key: string): string {
  const ext = key.split('.').pop()?.toLowerCase() || '';
  const mimeMap: Record<string, string> = {
    pdf: 'application/pdf',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    csv: 'text/csv',
    json: 'application/json',
    xml: 'application/xml',
    txt: 'text/plain',
    md: 'text/markdown',
    html: 'text/html',
    rtf: 'application/rtf',
    epub: 'application/epub+zip',
    odt: 'application/vnd.oasis.opendocument.text',
    eml: 'message/rfc822',
    msg: 'application/vnd.ms-outlook',
    yaml: 'application/x-yaml',
    yml: 'application/x-yaml',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    tiff: 'image/tiff',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    mp4: 'video/mp4',
    webm: 'video/webm',
  };
  return mimeMap[ext] || 'application/octet-stream';
}
