import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams, useLocation } from 'react-router-dom'
import { Search } from 'lucide-react'
import { SiteHeader } from '@/components/site/SiteHeader'
import { SiteFooter } from '@/components/site/SiteFooter'
import { MarkdownView } from './MarkdownView'
import {
  DOC_GROUPS,
  ALL_PAGES,
  DEFAULT_SLUG,
  getDocContent,
  groupForSlug,
  searchDocs,
  type SearchHit,
} from './registry'

function DocsSearch() {
  const [q, setQ] = useState('')
  const [open, setOpen] = useState(false)
  const navigate = useNavigate()
  const boxRef = useRef<HTMLDivElement>(null)
  const hits = useMemo<SearchHit[]>(() => searchDocs(q), [q])

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [])

  const go = (h: SearchHit) => {
    navigate(`/docs/${h.slug}${h.anchor ? `#${h.anchor}` : ''}`)
    setQ('')
    setOpen(false)
  }

  return (
    <div ref={boxRef} className="relative">
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
        <input
          value={q}
          onChange={(e) => { setQ(e.target.value); setOpen(true) }}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => { if (e.key === 'Enter' && hits[0]) go(hits[0]); if (e.key === 'Escape') setOpen(false) }}
          placeholder="Search documentation…"
          className="w-full rounded-lg border border-slate-800 bg-slate-900/70 py-2 pl-9 pr-3 text-sm text-slate-200 placeholder-slate-500 focus:border-indigo-500/50 focus:outline-none focus:ring-1 focus:ring-indigo-500/40"
        />
      </div>
      {open && hits.length > 0 && (
        <div className="absolute z-30 mt-2 max-h-[24rem] w-full overflow-auto rounded-xl border border-slate-800 bg-slate-950/95 p-1.5 shadow-2xl backdrop-blur">
          {hits.map((h, i) => (
            <button
              key={`${h.slug}-${h.anchor}-${i}`}
              onMouseDown={(e) => { e.preventDefault(); go(h) }}
              className="block w-full rounded-lg px-3 py-2 text-left transition-colors hover:bg-slate-800/80"
            >
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-sm font-medium text-slate-100">{h.heading}</span>
                <span className="shrink-0 text-[10px] uppercase tracking-wide text-slate-500">{h.title}</span>
              </div>
              {h.snippet && <p className="mt-0.5 line-clamp-1 text-xs text-slate-400">{h.snippet}</p>}
            </button>
          ))}
        </div>
      )}
      {open && q.trim().length >= 2 && hits.length === 0 && (
        <div className="absolute z-30 mt-2 w-full rounded-xl border border-slate-800 bg-slate-950/95 px-3 py-3 text-sm text-slate-400 shadow-2xl">
          No results for “{q}”.
        </div>
      )}
    </div>
  )
}

function DocsSidebar({ activeSlug, onNavigate }: { activeSlug: string; onNavigate?: () => void }) {
  return (
    <nav className="space-y-7">
      {DOC_GROUPS.map((group) => (
        <div key={group.group}>
          <p className="mb-2 px-3 text-xs font-semibold uppercase tracking-wider text-slate-500">{group.group}</p>
          <ul className="space-y-0.5">
            {group.pages.map((page) => {
              const active = page.slug === activeSlug
              return (
                <li key={page.slug}>
                  <Link
                    to={`/docs/${page.slug}`}
                    onClick={onNavigate}
                    className={`block rounded-lg px-3 py-1.5 text-sm transition-colors ${
                      active ? 'bg-indigo-500/10 font-medium text-indigo-300' : 'text-slate-400 hover:bg-slate-800/60 hover:text-slate-200'
                    }`}
                  >
                    {page.title}
                  </Link>
                </li>
              )
            })}
          </ul>
        </div>
      ))}
    </nav>
  )
}

export function DocsPage() {
  const { slug: rawSlug } = useParams()
  const slug = rawSlug ?? DEFAULT_SLUG
  const { hash, pathname } = useLocation()
  const content = getDocContent(slug)
  const [mobileNav, setMobileNav] = useState(false)

  const idx = ALL_PAGES.findIndex((p) => p.slug === slug)
  const prev = idx > 0 ? ALL_PAGES[idx - 1] : null
  const next = idx >= 0 && idx < ALL_PAGES.length - 1 ? ALL_PAGES[idx + 1] : null
  const title = ALL_PAGES[idx]?.title ?? 'Documentation'
  const group = groupForSlug(slug)

  // Scroll to the hash anchor (after content renders), else to top on page change.
  useEffect(() => {
    if (hash) {
      const el = document.getElementById(hash.slice(1))
      if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'start' }); return }
    }
    window.scrollTo({ top: 0 })
  }, [pathname, hash])

  return (
    <div className="min-h-screen bg-[#020617]">
      <SiteHeader />
      <div className="mx-auto max-w-7xl px-6 pt-24">
        <div className="lg:grid lg:grid-cols-[16rem_minmax(0,1fr)] lg:gap-10">
          {/* Sidebar */}
          <aside className="lg:sticky lg:top-24 lg:h-[calc(100vh-7rem)] lg:overflow-y-auto lg:pb-12">
            <DocsSearch />
            <div className="mt-6 hidden lg:block">
              <DocsSidebar activeSlug={slug} />
            </div>
            {/* Mobile nav toggle */}
            <button
              onClick={() => setMobileNav((v) => !v)}
              className="mt-4 flex w-full items-center justify-between rounded-lg border border-slate-800 bg-slate-900/70 px-3 py-2 text-sm text-slate-300 lg:hidden"
            >
              <span>Browse docs · {title}</span>
              <span className="text-slate-500">{mobileNav ? '▲' : '▼'}</span>
            </button>
            {mobileNav && (
              <div className="mt-3 lg:hidden">
                <DocsSidebar activeSlug={slug} onNavigate={() => setMobileNav(false)} />
              </div>
            )}
          </aside>

          {/* Content */}
          <main className="min-w-0 pb-20 pt-4 lg:pt-0">
            {content ? (
              <>
                {group && <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-indigo-400">{group}</p>}
                <article className="reveal is-visible">
                  <MarkdownView content={content} />
                </article>
                <div className="mt-14 grid gap-4 border-t border-slate-800 pt-8 sm:grid-cols-2">
                  {prev ? (
                    <Link to={`/docs/${prev.slug}`} className="feature-card-landing block !p-4">
                      <span className="text-xs text-slate-500">← Previous</span>
                      <p className="mt-0.5 font-medium text-slate-200">{prev.title}</p>
                    </Link>
                  ) : <span />}
                  {next && (
                    <Link to={`/docs/${next.slug}`} className="feature-card-landing block !p-4 text-right sm:col-start-2">
                      <span className="text-xs text-slate-500">Next →</span>
                      <p className="mt-0.5 font-medium text-slate-200">{next.title}</p>
                    </Link>
                  )}
                </div>
              </>
            ) : (
              <div className="py-20 text-center">
                <h1 className="text-2xl font-bold text-white">Page not found</h1>
                <p className="mt-2 text-slate-400">No documentation page matches “{slug}”.</p>
                <Link to="/docs" className="btn-cta-secondary mt-6 inline-flex">Back to docs</Link>
              </div>
            )}
          </main>
        </div>
      </div>
      <SiteFooter />
    </div>
  )
}
