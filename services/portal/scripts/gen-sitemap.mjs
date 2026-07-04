#!/usr/bin/env node
// Generates public/sitemap.xml from the static route list + every doc slug
// in the docs registry, so it can never drift out of sync with the app.
// Run via `npm run gen:sitemap`, or automatically as part of `prebuild`.

import { writeFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')
const SITE_URL = 'https://gctrl.tech'

// Static marketing routes (see src/App.tsx). Auth-gated app routes
// (dashboard, login, settings, etc.) are intentionally excluded — they are
// not meant to be indexed.
const STATIC_ROUTES = [
  { path: '/', priority: '1.0', changefreq: 'weekly' },
  { path: '/docs', priority: '0.8', changefreq: 'weekly' },
  { path: '/pricing', priority: '0.8', changefreq: 'monthly' },
  { path: '/use-cases', priority: '0.7', changefreq: 'monthly' },
  { path: '/integrations', priority: '0.7', changefreq: 'monthly' },
  { path: '/imprint', priority: '0.2', changefreq: 'yearly' },
  { path: '/privacy', priority: '0.2', changefreq: 'yearly' },
]

// Pull every doc slug straight out of the content directory rather than
// parsing registry.ts (which is TS) — avoids a build step just to read a list.
const contentDir = path.join(root, 'src/pages/docs/content')
const docSlugs = readdirSync(contentDir)
  .filter((f) => f.endsWith('.md'))
  .map((f) => f.replace(/\.md$/, ''))
  .sort()

const lastmod = process.env.SITEMAP_LASTMOD || new Date().toISOString().slice(0, 10)

const urls = [
  ...STATIC_ROUTES.map((r) => ({ loc: `${SITE_URL}${r.path}`, priority: r.priority, changefreq: r.changefreq })),
  ...docSlugs.map((slug) => ({ loc: `${SITE_URL}/docs/${slug}`, priority: '0.6', changefreq: 'monthly' })),
]

const body = urls
  .map(
    (u) => `  <url>
    <loc>${u.loc}</loc>
    <lastmod>${lastmod}</lastmod>
    <changefreq>${u.changefreq}</changefreq>
    <priority>${u.priority}</priority>
  </url>`,
  )
  .join('\n')

const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${body}
</urlset>
`

const outPath = path.join(root, 'public/sitemap.xml')
writeFileSync(outPath, xml)
console.log(`[gen-sitemap] wrote ${outPath} with ${urls.length} URLs (${docSlugs.length} doc pages)`)

// Sanity check: make sure we didn't silently produce an empty/broken sitemap.
if (urls.length < STATIC_ROUTES.length + 5) {
  console.error('[gen-sitemap] suspiciously few URLs — check content dir path')
  process.exit(1)
}
