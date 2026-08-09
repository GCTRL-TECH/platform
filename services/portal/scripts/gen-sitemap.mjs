#!/usr/bin/env node
// Generates public/sitemap.xml from the static route list + every doc slug
// in the docs registry, so it can never drift out of sync with the app.
// Run via `npm run gen:sitemap`, or automatically as part of `prebuild`.

import { writeFileSync, readdirSync, readFileSync } from 'node:fs'
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
  { path: '/blog', priority: '0.7', changefreq: 'weekly' },
  { path: '/use-cases', priority: '0.7', changefreq: 'monthly' },
  { path: '/integrations', priority: '0.7', changefreq: 'monthly' },
  { path: '/imprint', priority: '0.2', changefreq: 'yearly' },
  { path: '/privacy', priority: '0.2', changefreq: 'yearly' },
  { path: '/skill.md', priority: '0.5', changefreq: 'monthly' },
]

// Pull every doc slug straight out of the content directory rather than
// parsing registry.ts (which is TS) — avoids a build step just to read a list.
const contentDir = path.join(root, 'src/pages/docs/content')
const docSlugs = readdirSync(contentDir)
  .filter((f) => f.endsWith('.md'))
  .map((f) => f.replace(/\.md$/, ''))
  .sort()

// A post's own frontmatter `date:` is its real publication date. Stamping the
// build date on every blog URL instead would tell crawlers that all posts
// changed on every deploy, which devalues the lastmod signal entirely.
function frontmatterDate(file) {
  const raw = readFileSync(file, 'utf8')
  const block = raw.match(/^---\n([\s\S]*?)\n---/)?.[1]
  const date = block?.match(/^date:\s*(\S+)/m)?.[1]
  return date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null
}

// Blog posts are directory-driven too: dropping one .md into the blog content
// dir is the whole publishing contract (see src/pages/blog/registry.ts).
const blogDir = path.join(root, 'src/pages/blog/content')
let blogPosts = []
try {
  blogPosts = readdirSync(blogDir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => ({ slug: f.replace(/\.md$/, ''), date: frontmatterDate(path.join(blogDir, f)) }))
    .sort((a, b) => a.slug.localeCompare(b.slug))
} catch {
  // no blog content yet - fine
}

// Fallback for routes with no content date of their own (static + docs pages).
const lastmod = process.env.SITEMAP_LASTMOD || new Date().toISOString().slice(0, 10)

const urls = [
  ...STATIC_ROUTES.map((r) => ({ loc: `${SITE_URL}${r.path}`, lastmod, priority: r.priority, changefreq: r.changefreq })),
  ...docSlugs.map((slug) => ({ loc: `${SITE_URL}/docs/${slug}`, lastmod, priority: '0.6', changefreq: 'monthly' })),
  ...blogPosts.map((p) => ({
    loc: `${SITE_URL}/blog/${p.slug}`,
    lastmod: p.date || lastmod,
    priority: '0.6',
    changefreq: 'monthly',
  })),
]

const body = urls
  .map(
    (u) => `  <url>
    <loc>${u.loc}</loc>
    <lastmod>${u.lastmod}</lastmod>
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
