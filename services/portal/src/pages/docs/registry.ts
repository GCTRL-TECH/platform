// Documentation registry: groups → pages, raw markdown loading, and a flat
// search index. Markdown lives in ./content/*.md and is bundled via Vite ?raw.

export type DocPage = { slug: string; title: string }
export type DocGroup = { group: string; pages: DocPage[] }

export const DOC_GROUPS: DocGroup[] = [
  {
    group: 'Getting started',
    pages: [
      { slug: 'introduction', title: 'Introduction' },
      { slug: 'installation', title: 'Installation' },
      { slug: 'activation', title: 'Activation & Setup' },
      { slug: 'quickstart', title: 'Quickstart' },
    ],
  },
  {
    group: 'Setup & performance',
    pages: [
      { slug: 'llm-providers', title: 'LLM Providers' },
      { slug: 'infrastructure', title: 'Infrastructure & Ollama' },
      { slug: 'performance', title: 'Performance Guide' },
    ],
  },
  {
    group: 'Architecture',
    pages: [
      { slug: 'architecture', title: 'Architecture' },
      { slug: 'modules', title: 'The Four Modules' },
      { slug: 'memory-layers', title: 'Memory Layers' },
    ],
  },
  {
    group: 'Agents & integration',
    pages: [
      { slug: 'agents-mcp', title: 'Agents & MCP' },
      { slug: 'memory-skill', title: 'The GCTRL Memory Skill' },
    ],
  },
  {
    group: 'Enterprise',
    pages: [
      { slug: 'access-control', title: 'Access Control' },
      { slug: 'compliance', title: 'Compliance & Sovereignty' },
    ],
  },
  {
    group: 'Reference',
    pages: [
      { slug: 'benchmarks', title: 'Benchmarks' },
      { slug: 'faq', title: 'FAQ & Troubleshooting' },
    ],
  },
]

export const DEFAULT_SLUG = 'introduction'

// All markdown, eagerly bundled. Keys look like './content/introduction.md'.
const RAW = import.meta.glob('./content/*.md', { query: '?raw', import: 'default', eager: true }) as Record<string, string>

export const ALL_PAGES: DocPage[] = DOC_GROUPS.flatMap((g) => g.pages)

export function getDocContent(slug: string): string | null {
  return RAW[`./content/${slug}.md`] ?? null
}

export function groupForSlug(slug: string): string | null {
  return DOC_GROUPS.find((g) => g.pages.some((p) => p.slug === slug))?.group ?? null
}

// ── Search index ─────────────────────────────────────────────────────────────
export type SearchHit = { slug: string; title: string; group: string; heading: string; anchor: string; snippet: string }

// GitHub-style slugify for heading anchors (react-markdown headings get matching ids).
export function slugifyHeading(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
}

type IndexEntry = { slug: string; title: string; group: string; heading: string; anchor: string; body: string }

const INDEX: IndexEntry[] = (() => {
  const entries: IndexEntry[] = []
  for (const group of DOC_GROUPS) {
    for (const page of group.pages) {
      const md = getDocContent(page.slug)
      if (!md) continue
      // Split on ## / ### headings; everything before the first heading is the intro.
      const lines = md.split('\n')
      let heading = page.title
      let anchor = ''
      let buf: string[] = []
      const flush = () => {
        const body = buf.join(' ').replace(/[#*`>|_]/g, ' ').replace(/\s+/g, ' ').trim()
        if (body || heading) entries.push({ slug: page.slug, title: page.title, group: group.group, heading, anchor, body })
        buf = []
      }
      for (const line of lines) {
        const m = /^(#{2,3})\s+(.*)$/.exec(line)
        if (m) {
          flush()
          heading = m[2].trim()
          anchor = slugifyHeading(heading)
        } else if (!/^#\s/.test(line)) {
          buf.push(line)
        }
      }
      flush()
    }
  }
  return entries
})()

export function searchDocs(query: string, limit = 8): SearchHit[] {
  const q = query.trim().toLowerCase()
  if (q.length < 2) return []
  const terms = q.split(/\s+/).filter(Boolean)
  const scored: { e: IndexEntry; score: number }[] = []
  for (const e of INDEX) {
    const hay = `${e.title} ${e.heading} ${e.body}`.toLowerCase()
    let score = 0
    for (const t of terms) {
      if (!hay.includes(t)) { score = -1; break }
      if (e.title.toLowerCase().includes(t)) score += 5
      if (e.heading.toLowerCase().includes(t)) score += 3
      score += 1
    }
    if (score > 0) scored.push({ e, score })
  }
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, limit).map(({ e }) => {
    const idx = e.body.toLowerCase().indexOf(terms[0])
    const start = Math.max(0, idx - 40)
    const snippet = (idx >= 0 ? (start > 0 ? '…' : '') + e.body.slice(start, start + 120) : e.body.slice(0, 120)).trim()
    return { slug: e.slug, title: e.title, group: e.group, heading: e.heading, anchor: e.anchor, snippet }
  })
}
