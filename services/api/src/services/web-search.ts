/**
 * Web search enrichment for RAG pipeline.
 * Searches the web for additional context when graph + vector confidence is low.
 * Uses DuckDuckGo HTML search (no API key needed) + Trafilatura-style scraping.
 */

const SEARCH_TIMEOUT = 10000;
const SCRAPE_TIMEOUT = 8000;
const MAX_RESULTS = 3;

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
  content?: string;  // scraped full text (first 500 chars)
  imageUrl?: string;
}

/**
 * Search DuckDuckGo HTML for a query. No API key needed.
 * Returns titles, URLs, and snippets.
 */
async function searchDuckDuckGo(query: string): Promise<WebSearchResult[]> {
  try {
    const encoded = encodeURIComponent(query);
    const resp = await fetch(`https://html.duckduckgo.com/html/?q=${encoded}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; GCTRL/1.0)',
      },
      signal: AbortSignal.timeout(SEARCH_TIMEOUT),
    });

    if (!resp.ok) return [];
    const html = await resp.text();

    // Parse results from DDG HTML response
    const results: WebSearchResult[] = [];
    const resultRegex = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g;
    const snippetRegex = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;

    const links: { url: string; title: string }[] = [];
    let match;
    while ((match = resultRegex.exec(html)) !== null) {
      const url = decodeURIComponent(match[1].replace(/.*uddg=/, '').split('&')[0] || match[1]);
      const title = match[2].replace(/<[^>]*>/g, '').trim();
      if (url.startsWith('http') && title) {
        links.push({ url, title });
      }
    }

    const snippets: string[] = [];
    while ((match = snippetRegex.exec(html)) !== null) {
      snippets.push(match[1].replace(/<[^>]*>/g, '').trim());
    }

    for (let i = 0; i < Math.min(links.length, MAX_RESULTS); i++) {
      results.push({
        title: links[i].title,
        url: links[i].url,
        snippet: snippets[i] || '',
      });
    }

    return results;
  } catch (err) {
    console.warn(`[WebSearch] DuckDuckGo search failed: ${err}`);
    return [];
  }
}

/**
 * Try to find an image URL for a person/entity from the web.
 * Uses DuckDuckGo image search.
 */
async function searchImages(query: string): Promise<string | undefined> {
  try {
    const encoded = encodeURIComponent(query + ' photo');
    const resp = await fetch(`https://html.duckduckgo.com/html/?q=${encoded}&iax=images&ia=images`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; GCTRL/1.0)' },
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) return undefined;
    const html = await resp.text();

    // Try to find an image URL in the results
    const imgMatch = html.match(/https:\/\/[^"'\s]*\.(?:jpg|jpeg|png|webp)/i);
    return imgMatch ? imgMatch[0] : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Scrape the first N characters of text from a URL.
 */
async function scrapeUrl(url: string): Promise<string> {
  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; GCTRL/1.0)' },
      signal: AbortSignal.timeout(SCRAPE_TIMEOUT),
    });
    if (!resp.ok) return '';
    const html = await resp.text();

    // Basic HTML to text: strip tags, decode entities, clean whitespace
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, ' ')
      .trim();

    return text.slice(0, 800);
  } catch {
    return '';
  }
}

/**
 * Full web search pipeline: search → scrape top results → return enriched results.
 */
export async function webSearch(
  query: string,
  options?: { includeImages?: boolean; maxResults?: number },
): Promise<{
  results: WebSearchResult[];
  imageUrl?: string;
}> {
  const maxResults = options?.maxResults || MAX_RESULTS;

  // Search
  const searchResults = await searchDuckDuckGo(query);
  if (searchResults.length === 0) {
    return { results: [] };
  }

  // Scrape top results for content (in parallel)
  const scrapePromises = searchResults.slice(0, maxResults).map(async (result) => {
    const content = await scrapeUrl(result.url);
    return { ...result, content: content || result.snippet };
  });
  const enrichedResults = await Promise.all(scrapePromises);

  // Optionally search for images
  let imageUrl: string | undefined;
  if (options?.includeImages) {
    imageUrl = await searchImages(query);
  }

  return {
    results: enrichedResults,
    imageUrl,
  };
}

/**
 * Check if a query looks like it's about a person (for image search).
 */
export function looksLikePersonQuery(query: string): boolean {
  const personPatterns = [
    /who is/i, /wer ist/i, /tell me about/i, /erzähl.*über/i,
    /biography/i, /biografie/i, /founder/i, /gründer/i,
    /professor/i, /scientist/i, /researcher/i, /ceo/i,
  ];
  return personPatterns.some((p) => p.test(query));
}

