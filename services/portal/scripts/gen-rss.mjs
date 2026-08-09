#!/usr/bin/env node
// Generates public/rss.xml from the blog content directory, so the feed can
// never drift out of sync with what is actually published (one .md file in
// src/pages/blog/content is the whole publishing contract).
// Run via `npm run gen:rss`, or automatically as part of `prebuild`.

import { writeFileSync, readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')
const SITE_URL = 'https://gctrl.tech'

// Same minimal frontmatter contract as src/pages/blog/registry.ts — parsed by
// hand here too rather than pulling in a YAML dependency for four keys.
function parseFrontmatter(raw) {
  const meta = {}
  const block = raw.match(/^---\n([\s\S]*?)\n---/)?.[1]
  if (!block) return meta
  for (const line of block.split('\n')) {
    const idx = line.indexOf(':')
    if (idx === -1) continue
    const key = line.slice(0, idx).trim()
    let value = line.slice(idx + 1).trim()
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1)
    if (key) meta[key] = value
  }
  return meta
}

function esc(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// RSS 2.0 requires RFC 822 dates; toUTCString() emits the RFC 1123 form
// ("Wed, 05 Aug 2026 00:00:00 GMT"), which validators accept.
function rfc822(iso) {
  const d = new Date(`${iso}T00:00:00Z`)
  return Number.isNaN(d.getTime()) ? new Date(0).toUTCString() : d.toUTCString()
}

const blogDir = path.join(root, 'src/pages/blog/content')
let posts = []
try {
  posts = readdirSync(blogDir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => {
      const slug = f.replace(/\.md$/, '')
      const meta = parseFrontmatter(readFileSync(path.join(blogDir, f), 'utf8'))
      return {
        slug,
        title: meta['title'] ?? slug,
        date: meta['date'] ?? '1970-01-01',
        description: meta['description'] ?? '',
      }
    })
    // Same draft rule as the registry: no real title or date means unpublished.
    .filter((p) => p.title !== p.slug && p.date !== '1970-01-01')
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.slug.localeCompare(b.slug)))
} catch {
  // no blog content yet - fine
}

const items = posts
  .map(
    (p) => `    <item>
      <title>${esc(p.title)}</title>
      <link>${SITE_URL}/blog/${p.slug}</link>
      <guid isPermaLink="true">${SITE_URL}/blog/${p.slug}</guid>
      <description>${esc(p.description)}</description>
      <pubDate>${rfc822(p.date)}</pubDate>
    </item>`,
  )
  .join('\n')

const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>GCTRL Blog</title>
    <link>${SITE_URL}/blog</link>
    <description>Engineering notes on self-hosted knowledge graphs, GraphRAG, sovereign AI memory and compliance.</description>
    <language>en</language>
    <atom:link href="${SITE_URL}/rss.xml" rel="self" type="application/rss+xml"/>
${items}
  </channel>
</rss>
`

const outPath = path.join(root, 'public/rss.xml')
writeFileSync(outPath, xml)
console.log(`[gen-rss] wrote ${outPath} with ${posts.length} items`)
