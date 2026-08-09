#!/usr/bin/env node
// Refreshes the "## Articles" section at the end of public/llms.txt from the
// blog content directory. Everything above that heading is hand-written prose
// (the intro, capabilities, docs and site sections) and is preserved verbatim —
// this script only ever rewrites the machine-generated blog listing, so a new
// post shows up for LLM crawlers without anyone editing llms.txt by hand.
// Run via `npm run gen:llms`, or automatically as part of `prebuild`.

import { writeFileSync, readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')
const SITE_URL = 'https://gctrl.tech'
const HEADING = '## Articles'

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

const outPath = path.join(root, 'public/llms.txt')
const current = readFileSync(outPath, 'utf8')

// Everything before the generated heading is hand-written and stays untouched.
const idx = current.indexOf(`\n${HEADING}`)
const head = (idx === -1 ? current : current.slice(0, idx)).replace(/\s+$/, '')

const listing = posts
  .map((p) => `- [${p.title}](${SITE_URL}/blog/${p.slug}): ${p.description}`)
  .join('\n')

writeFileSync(outPath, `${head}\n\n${HEADING}\n\n${listing}\n`)
console.log(`[gen-llms] wrote ${outPath} with ${posts.length} articles`)
