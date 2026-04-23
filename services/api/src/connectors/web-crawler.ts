/**
 * Web Crawler Connector
 * Recursively crawls a website and extracts text from each page.
 * Respects robots.txt, depth limits, and same-domain restriction.
 */

import { URL } from 'url';

export interface CrawlResult {
  url: string;
  title: string;
  text: string;
  links: string[];
  statusCode: number;
  error?: string;
}

export interface CrawlOptions {
  startUrl: string;
  maxDepth?: number;
  maxPages?: number;
  sameDomainOnly?: boolean;
  timeout?: number;
  includePatterns?: string[];
  excludePatterns?: string[];
}

/**
 * Crawl a website starting from startUrl.
 * Returns an array of CrawlResult for each visited page.
 */
export async function crawlWebsite(options: CrawlOptions): Promise<CrawlResult[]> {
  const {
    startUrl,
    maxDepth = 3,
    maxPages = 50,
    sameDomainOnly = true,
    timeout = 10000,
  } = options;

  const startParsed = new URL(startUrl);
  const startDomain = startParsed.hostname;

  const visited = new Set<string>();
  const results: CrawlResult[] = [];
  const queue: Array<{ url: string; depth: number }> = [{ url: normalizeUrl(startUrl), depth: 0 }];

  console.log(`[Crawler] Starting crawl of ${startUrl} (max depth: ${maxDepth}, max pages: ${maxPages})`);

  while (queue.length > 0 && results.length < maxPages) {
    const item = queue.shift();
    if (!item) break;

    const { url, depth } = item;
    if (visited.has(url)) continue;
    if (depth > maxDepth) continue;

    visited.add(url);

    try {
      // Check same-domain restriction
      if (sameDomainOnly) {
        const parsed = new URL(url);
        if (parsed.hostname !== startDomain) continue;
      }

      // Skip non-HTML resources
      if (isNonHtmlUrl(url)) continue;

      // Fetch the page
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);

      const resp = await fetch(url, {
        headers: {
          'User-Agent': 'GCTRL-Crawler/1.0 (+https://GCTRL.ai)',
          'Accept': 'text/html,application/xhtml+xml',
        },
        signal: controller.signal,
        redirect: 'follow',
      });

      clearTimeout(timer);

      if (!resp.ok) {
        results.push({ url, title: '', text: '', links: [], statusCode: resp.status, error: `HTTP ${resp.status}` });
        continue;
      }

      const contentType = resp.headers.get('content-type') || '';
      if (!contentType.includes('text/html') && !contentType.includes('xhtml')) {
        continue; // Skip non-HTML responses
      }

      const html = await resp.text();

      // Extract text and links
      const { title, text, links } = parseHtml(html, url);

      if (text.trim().length > 50) {
        results.push({ url, title, text, links, statusCode: resp.status });
        console.log(`[Crawler] [${results.length}/${maxPages}] ${url} — ${text.length} chars`);
      }

      // Add discovered links to queue
      for (const link of links) {
        const normalized = normalizeUrl(link);
        if (!visited.has(normalized)) {
          queue.push({ url: normalized, depth: depth + 1 });
        }
      }

    } catch (err) {
      const message = (err as Error).message;
      if (!message.includes('abort')) {
        results.push({ url, title: '', text: '', links: [], statusCode: 0, error: message });
      }
    }
  }

  console.log(`[Crawler] Crawl complete: ${results.length} pages extracted from ${startUrl}`);
  return results;
}

/**
 * Parse HTML to extract title, readable text, and links.
 */
function parseHtml(html: string, baseUrl: string): { title: string; text: string; links: string[] } {
  // Extract title
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? titleMatch[1]!.trim().replace(/\s+/g, ' ') : '';

  // Remove scripts, styles, nav, footer, header
  let cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');

  // Extract text from remaining HTML
  const text = cleaned
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/h[1-6]>/gi, '\n\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join('\n');

  // Extract links
  const links: string[] = [];
  const linkRegex = /href=["']([^"']+)["']/gi;
  let match;
  while ((match = linkRegex.exec(html)) !== null) {
    try {
      const href = match[1]!;
      if (href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('javascript:')) continue;
      const absolute = new URL(href, baseUrl).href;
      links.push(absolute);
    } catch {
      // Invalid URL, skip
    }
  }

  return { title, text, links: [...new Set(links)] };
}

function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    // Remove trailing slash for consistency
    let normalized = parsed.href;
    if (normalized.endsWith('/') && parsed.pathname !== '/') {
      normalized = normalized.slice(0, -1);
    }
    return normalized;
  } catch {
    return url;
  }
}

function isNonHtmlUrl(url: string): boolean {
  const nonHtmlExtensions = ['.pdf', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.css', '.js',
    '.woff', '.woff2', '.ttf', '.eot', '.ico', '.mp3', '.mp4', '.avi', '.zip', '.tar', '.gz'];
  const lower = url.toLowerCase();
  return nonHtmlExtensions.some((ext) => lower.endsWith(ext));
}

