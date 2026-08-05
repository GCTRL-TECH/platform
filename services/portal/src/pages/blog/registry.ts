// Blog content model. Unlike the docs registry (metadata in DOC_GROUPS), every
// blog post is fully self-describing: ONE markdown file in ./content/ with a
// minimal frontmatter block. The automated publishing pipeline therefore only
// ever adds a single file per post - slugs, ordering, sitemap entries and
// prerender routes all derive from the files themselves.
//
// Frontmatter contract (hand-rolled parser below, house style - no new deps):
//   ---
//   title: The post title
//   date: 2026-08-05
//   description: Meta description, ideally 120-157 chars, used for SEO.
//   tags: [self-hosted, rag]
//   ---
//   ...markdown body...

export type BlogPost = {
  slug: string
  title: string
  date: string // ISO yyyy-mm-dd
  description: string
  tags: string[]
  body: string
}

const RAW = import.meta.glob('./content/*.md', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const meta: Record<string, string> = {}
  if (!raw.startsWith('---\n')) return { meta, body: raw }
  const end = raw.indexOf('\n---', 4)
  if (end === -1) return { meta, body: raw }
  for (const line of raw.slice(4, end).split('\n')) {
    const idx = line.indexOf(':')
    if (idx === -1) continue
    const key = line.slice(0, idx).trim()
    let value = line.slice(idx + 1).trim()
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1)
    if (key) meta[key] = value
  }
  const body = raw.slice(end + 4).replace(/^\s*\n/, '')
  return { meta, body }
}

function parseTags(value: string | undefined): string[] {
  if (!value) return []
  return value
    .replace(/^\[/, '')
    .replace(/\]$/, '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
}

export const BLOG_POSTS: BlogPost[] = Object.entries(RAW)
  .map(([path, raw]) => {
    const slug = path.replace('./content/', '').replace(/\.md$/, '')
    const { meta, body } = parseFrontmatter(raw)
    return {
      slug,
      title: meta['title'] ?? slug,
      date: meta['date'] ?? '1970-01-01',
      description: meta['description'] ?? '',
      tags: parseTags(meta['tags']),
      body,
    }
  })
  // A post without a real title or date is treated as a draft and not listed.
  .filter((p) => p.title !== p.slug && p.date !== '1970-01-01')
  .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.slug.localeCompare(b.slug)))

export function getBlogPost(slug: string): BlogPost | undefined {
  return BLOG_POSTS.find((p) => p.slug === slug)
}

export function formatBlogDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  })
}
