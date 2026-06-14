import { useEffect, useMemo, useState, lazy, Suspense } from 'react'
import {
  BookOpenText,
  RefreshCw,
  AlertCircle,
  FileText,
  Network,
  ListTree,
  Boxes,
  History,
  Settings2,
  Check,
  Clock,
  Search,
  ArrowLeft,
  ShieldCheck,
  Lock,
} from 'lucide-react'
import { formatDistanceToNow } from 'date-fns'
import { useQueryClient } from '@tanstack/react-query'
import { useApiQuery } from '@/hooks/useApi'
import { apiGet, apiPost, apiPut } from '@/lib/api'
import { cn } from '@/lib/utils'
import { WikiGraph, rankColor } from './WikiGraph'

const MarkdownView = lazy(
  () => import('@/components/graph-explorer/MarkdownView')
)

// ── Types ───────────────────────────────────────────────────────────────────

type GraphType = 'RAW' | 'WIKI'

interface Compilation {
  id: string
  name: string
  type?: GraphType
  isSystem?: boolean
  lastDistillAt?: string | null
  pageCount?: number
}

interface CompilationsResponse {
  compilations: Compilation[]
}

type WikiKind = 'overview' | 'index' | 'concept' | 'entities' | 'log' | string

interface WikiPageMeta {
  id: string
  kind: WikiKind
  slug: string
  title: string
  entityUri: string | null
  minRank?: number
  classLabels?: string[]
  lastDistilledAt: string | null
}

interface WikiPagesResponse {
  pages: WikiPageMeta[]
}

interface WikiPageFull {
  slug: string
  title: string
  kind: WikiKind
  bodyMd: string
  citations: unknown
  version: number
  minRank?: number
  classLabels?: string[]
  lastDistilledAt: string
}

interface WikiSource {
  id: string
  name: string
  nodeCount: number
  edgeCount: number
}

interface WikiSourcesResponse {
  sources: WikiSource[]
}

// ── Classification display ──────────────────────────────────────────────────

function rankLevelName(rank: number): string {
  if (rank <= 0) return 'PUBLIC'
  if (rank <= 100) return 'INTERNAL'
  if (rank <= 200) return 'CONFIDENTIAL'
  return 'STRICTLY_CONFIDENTIAL'
}

// A compact classification dot + label for the page index and reader header.
function ClassBadge({ rank, compact = false }: { rank: number; compact?: boolean }) {
  const name = rankLevelName(rank)
  const color = rankColor(rank)
  if (compact) {
    return (
      <span
        className="inline-block h-2 w-2 shrink-0 rounded-full"
        style={{ backgroundColor: color }}
        title={name.replace(/_/g, ' ')}
      />
    )
  }
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider"
      style={{ backgroundColor: `${color}1a`, color, boxShadow: `inset 0 0 0 1px ${color}55` }}
    >
      {rank > 0 ? <Lock size={9} /> : <ShieldCheck size={9} />}
      {name.replace(/_/g, ' ')}
    </span>
  )
}

// ── Kind grouping / display ─────────────────────────────────────────────────

const KIND_ORDER: WikiKind[] = [
  'overview',
  'index',
  'concept',
  'entity',
  'entities',
  'log',
  'lint',
]

const KIND_META: Record<string, { label: string; icon: typeof FileText }> = {
  overview: { label: 'Overview', icon: FileText },
  index: { label: 'Index', icon: ListTree },
  concept: { label: 'Concepts', icon: Network },
  entity: { label: 'Entities', icon: Boxes },
  entities: { label: 'Entities', icon: Boxes },
  log: { label: 'Activity Log', icon: History },
  lint: { label: 'Lint Report', icon: AlertCircle },
}

function kindMeta(kind: WikiKind) {
  return KIND_META[kind] ?? { label: kind, icon: FileText }
}

// ── Wikilink rendering ──────────────────────────────────────────────────────

function slugify(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

const WIKI_HASH = '#wiki='

function rewriteWikilinks(md: string): string {
  return md.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, target, label) => {
    const t = String(target).replace(/\s+/g, ' ').trim()
    const text = (label ?? t).toString().replace(/\s+/g, ' ').trim()
    return `[${text}](${WIKI_HASH}${encodeURIComponent(t)})`
  })
}

// ── Page ────────────────────────────────────────────────────────────────────

export function WikiPage() {
  const queryClient = useQueryClient()

  // All compilations — we derive the set of accessible WIKI spaces from these.
  const {
    data: compsData,
    isLoading: compsLoading,
    error: compsError,
  } = useApiQuery<CompilationsResponse>(
    ['kg', 'compilations'],
    '/kg/compilations?limit=100'
  )

  const compilations = compsData?.compilations ?? []
  const wikis = useMemo(
    () => compilations.filter((c) => c.type === 'WIKI'),
    [compilations]
  )
  const rawCompilations = useMemo(
    () => compilations.filter((c) => (c.type ?? 'RAW') === 'RAW'),
    [compilations]
  )

  // Which wiki space is open. Null = show the selector.
  const [selectedWikiId, setSelectedWikiId] = useState<string | null>(null)

  // Auto-enter when exactly one wiki exists; otherwise show the selector.
  useEffect(() => {
    if (selectedWikiId) return
    if (wikis.length === 1) setSelectedWikiId(wikis[0].id)
  }, [wikis, selectedWikiId])

  if (compsLoading) {
    return (
      <div className="flex items-center justify-center py-24">
        <span className="h-8 w-8 animate-spin rounded-full border-2 border-slate-700 border-t-blue-500" />
      </div>
    )
  }

  if (compsError) {
    return (
      <div className="flex flex-col items-center gap-3 py-24 text-center">
        <AlertCircle size={28} className="text-red-400" />
        <p className="text-sm text-slate-400">Failed to load your knowledge wikis.</p>
      </div>
    )
  }

  const activeWiki = wikis.find((w) => w.id === selectedWikiId) ?? null

  if (!activeWiki) {
    return (
      <WikiSelector
        wikis={wikis}
        onSelect={(id) => setSelectedWikiId(id)}
      />
    )
  }

  return (
    <WikiExplorer
      wiki={activeWiki}
      rawCompilations={rawCompilations}
      multiWiki={wikis.length > 1}
      onBack={() => setSelectedWikiId(null)}
      onDistilled={() => {
        queryClient.invalidateQueries({ queryKey: ['kg', 'compilations'] })
      }}
    />
  )
}

// ── Wiki space selector ─────────────────────────────────────────────────────

function WikiSelector({
  wikis,
  onSelect,
}: {
  wikis: Compilation[]
  onSelect: (id: string) => void
}) {
  const [q, setQ] = useState('')
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase()
    const list = needle
      ? wikis.filter((w) => w.name.toLowerCase().includes(needle))
      : wikis
    // System wiki(s) pinned first, then alphabetical.
    return [...list].sort((a, b) => {
      if (!!a.isSystem !== !!b.isSystem) return a.isSystem ? -1 : 1
      return a.name.localeCompare(b.name)
    })
  }, [wikis, q])

  return (
    <div className="animate-slide-up space-y-6">
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-violet-500/10 ring-1 ring-violet-500/30">
          <BookOpenText size={20} className="text-violet-300" />
        </div>
        <div>
          <h2 className="text-2xl font-bold text-slate-100">Knowledge Wikis</h2>
          <p className="mt-1 text-sm text-slate-500">
            Choose a wiki to explore. Each wiki is a distilled, classification-aware
            second brain over its source graphs.
          </p>
        </div>
      </div>

      <div className="relative max-w-md">
        <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search wikis…"
          className="w-full rounded-lg border border-slate-700 bg-slate-900 py-2 pl-9 pr-3 text-sm text-slate-200 placeholder:text-slate-600 focus:border-blue-500/50 focus:outline-none"
        />
      </div>

      {filtered.length === 0 ? (
        <div className="rounded-xl border border-slate-800 bg-slate-900/50 px-4 py-12 text-center">
          <BookOpenText size={28} className="mx-auto text-slate-700" />
          <p className="mt-2 text-sm text-slate-400">
            {wikis.length === 0 ? 'No wikis yet.' : 'No wikis match your search.'}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((w) => (
            <button
              key={w.id}
              onClick={() => onSelect(w.id)}
              className="group flex flex-col gap-2 rounded-xl border border-slate-800 bg-slate-900/60 p-4 text-left transition-colors hover:border-violet-500/40 hover:bg-slate-900"
            >
              <div className="flex items-center justify-between">
                <BookOpenText size={18} className="text-violet-300" />
                {w.isSystem && (
                  <span className="rounded-full bg-violet-500/15 px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-violet-300 ring-1 ring-violet-500/30">
                    System
                  </span>
                )}
              </div>
              <p className="font-semibold text-slate-100 group-hover:text-white">{w.name}</p>
              <p className="flex items-center gap-1.5 text-xs text-slate-500">
                <Clock size={12} />
                {w.lastDistillAt
                  ? `Updated ${formatDistanceToNow(new Date(w.lastDistillAt), { addSuffix: true })}`
                  : 'Not yet distilled'}
                <span className="text-slate-700">·</span>
                {w.pageCount ?? 0} pages
              </p>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Wiki explorer (3-pane: index | graph | content) ─────────────────────────

function WikiExplorer({
  wiki,
  rawCompilations,
  multiWiki,
  onBack,
  onDistilled,
}: {
  wiki: Compilation
  rawCompilations: Compilation[]
  multiWiki: boolean
  onBack: () => void
  onDistilled: () => void
}) {
  const queryClient = useQueryClient()
  const wikiId = wiki.id

  // Pages for the wiki (clearance-filtered server-side).
  const { data: pagesData, isLoading: pagesLoading } =
    useApiQuery<WikiPagesResponse>(
      ['wiki', 'pages', wikiId],
      `/kg/compilations/${wikiId}/wiki`
    )
  const pages = pagesData?.pages ?? []

  // Selected page.
  const [activeSlug, setActiveSlug] = useState<string | null>(null)
  useEffect(() => {
    if (!pages.length) return
    if (activeSlug && pages.some((p) => p.slug === activeSlug)) return
    const pref =
      pages.find((p) => p.kind === 'index') ??
      pages.find((p) => p.kind === 'overview') ??
      pages[0]
    setActiveSlug(pref ? pref.slug : null)
  }, [pages, activeSlug])

  const { data: page, isLoading: pageLoading } = useApiQuery<WikiPageFull>(
    ['wiki', 'page', wikiId, activeSlug ?? 'none'],
    `/kg/compilations/${wikiId}/wiki/${activeSlug}`,
    { enabled: !!activeSlug }
  )

  function navigateWikilink(rawTarget: string) {
    const target = decodeURIComponent(rawTarget)
    const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase()
    const wanted = norm(target)
    const hit =
      pages.find((p) => norm(p.title) === wanted) ??
      pages.find((p) => p.slug === target) ??
      pages.find((p) => p.slug === slugify(target))
    if (hit) setActiveSlug(hit.slug)
  }

  const [showSources, setShowSources] = useState(false)
  const [distilling, setDistilling] = useState(false)
  const [distillMsg, setDistillMsg] = useState<string | null>(null)

  async function handleDistill() {
    setDistilling(true)
    setDistillMsg(null)
    try {
      const res = await apiPost<{ pages_written?: number }>(
        `/kg/compilations/${wikiId}/distill`,
        {}
      )
      setDistillMsg(
        res?.pages_written != null
          ? `Distilled ${res.pages_written} page${res.pages_written === 1 ? '' : 's'}.`
          : 'Distillation complete.'
      )
      await queryClient.invalidateQueries({ queryKey: ['wiki', 'pages', wikiId] })
      await queryClient.invalidateQueries({ queryKey: ['wiki', 'graph', wikiId] })
      onDistilled()
    } catch (e) {
      setDistillMsg(
        (e as { response?: { data?: { error?: string } } })?.response?.data?.error ??
          'Distillation failed.'
      )
    } finally {
      setDistilling(false)
    }
  }

  // Group pages by kind for the index.
  const grouped = KIND_ORDER.map((kind) => ({
    kind,
    items: pages.filter((p) => p.kind === kind),
  })).filter((g) => g.items.length > 0)
  const knownKinds = new Set(KIND_ORDER)
  const otherItems = pages.filter((p) => !knownKinds.has(p.kind))
  if (otherItems.length) grouped.push({ kind: 'other', items: otherItems })

  return (
    <div className="animate-slide-up space-y-4">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          {multiWiki && (
            <button
              onClick={onBack}
              className="mt-1 flex h-9 w-9 items-center justify-center rounded-lg border border-slate-700 text-slate-400 transition-colors hover:border-slate-600 hover:text-slate-200"
              title="Back to wikis"
            >
              <ArrowLeft size={16} />
            </button>
          )}
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-violet-500/10 ring-1 ring-violet-500/30">
            <BookOpenText size={20} className="text-violet-300" />
          </div>
          <div>
            <h2 className="flex items-center gap-2 text-2xl font-bold text-slate-100">
              {wiki.name}
              {wiki.isSystem && (
                <span className="rounded-full bg-violet-500/15 px-2 py-0.5 text-[10px] font-semibold text-violet-300 ring-1 ring-violet-500/30">
                  SYSTEM WIKI
                </span>
              )}
            </h2>
            <p className="mt-1 flex items-center gap-1.5 text-sm text-slate-500">
              <Clock size={13} />
              {wiki.lastDistillAt
                ? `Last updated ${formatDistanceToNow(new Date(wiki.lastDistillAt), { addSuffix: true })}`
                : 'Not yet distilled'}
              <span className="text-slate-700">·</span>
              <span className="text-slate-500">{pages.length} pages visible to you</span>
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowSources((s) => !s)}
            className={cn('btn-secondary', showSources && 'border-blue-500/40 text-blue-300')}
          >
            <Settings2 size={15} />
            Sources
          </button>
          <button onClick={handleDistill} disabled={distilling} className="btn-primary">
            {distilling ? (
              <>
                <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                Distilling…
              </>
            ) : (
              <>
                <RefreshCw size={15} />
                Re-distill now
              </>
            )}
          </button>
        </div>
      </div>

      {distillMsg && (
        <div className="rounded-lg border border-blue-500/20 bg-blue-500/5 px-4 py-2 text-xs text-blue-300">
          {distillMsg}
        </div>
      )}

      {showSources && (
        <SourceSelectionPanel wikiId={wikiId} rawCompilations={rawCompilations} />
      )}

      {/* 3-pane explorer: index | graph | content */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[240px_minmax(0,1fr)_minmax(0,1.1fr)]">
        {/* LEFT: searchable page index */}
        <aside className="rounded-xl border border-slate-800 bg-slate-900/60 p-3 lg:max-h-[calc(100vh-220px)] lg:overflow-y-auto">
          {pagesLoading ? (
            <div className="flex items-center justify-center py-10">
              <span className="h-5 w-5 animate-spin rounded-full border-2 border-slate-700 border-t-blue-500" />
            </div>
          ) : pages.length === 0 ? (
            <div className="px-2 py-8 text-center">
              <p className="text-sm text-slate-400">No pages yet</p>
              <p className="mt-1 text-xs text-slate-600">
                Pick sources and run “Re-distill now”.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {grouped.map((group) => {
                const meta = kindMeta(group.kind)
                const Icon = meta.icon
                return (
                  <div key={group.kind}>
                    <p className="flex items-center gap-1.5 px-2 pb-1 pt-1 text-[10px] font-semibold uppercase tracking-wider text-slate-600">
                      <Icon size={11} />
                      {meta.label}
                    </p>
                    <div className="space-y-0.5">
                      {group.items.map((p) => (
                        <button
                          key={p.slug}
                          onClick={() => setActiveSlug(p.slug)}
                          className={cn(
                            'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors',
                            activeSlug === p.slug
                              ? 'bg-blue-500/10 text-blue-300'
                              : 'text-slate-400 hover:bg-slate-800/60 hover:text-slate-200'
                          )}
                          title={`${p.title} · ${rankLevelName(p.minRank ?? 0).replace(/_/g, ' ')}`}
                        >
                          <ClassBadge rank={p.minRank ?? 0} compact />
                          <span className="truncate">{p.title}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </aside>

        {/* MIDDLE: wiki graph */}
        <div className="min-h-[420px] lg:h-[calc(100vh-220px)]">
          <WikiGraph
            compilationId={wikiId}
            activeSlug={activeSlug}
            onSelectSlug={setActiveSlug}
          />
        </div>

        {/* RIGHT: page content */}
        <main className="min-h-[420px] rounded-xl border border-slate-800 bg-slate-900/40 p-6 lg:max-h-[calc(100vh-220px)] lg:overflow-y-auto">
          {!activeSlug ? (
            <div className="flex flex-col items-center gap-2 py-20 text-center">
              <BookOpenText size={28} className="text-slate-700" />
              <p className="text-sm text-slate-500">Select a page to read.</p>
            </div>
          ) : pageLoading ? (
            <div className="flex items-center justify-center py-20">
              <span className="h-6 w-6 animate-spin rounded-full border-2 border-slate-700 border-t-blue-500" />
            </div>
          ) : page ? (
            <article>
              <header className="mb-4 border-b border-slate-800 pb-3">
                <div className="flex items-center gap-2">
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-violet-400/80">
                    {kindMeta(page.kind).label}
                  </span>
                  <ClassBadge rank={page.minRank ?? 0} />
                </div>
                <h1 className="mt-1.5 text-xl font-bold text-slate-100">{page.title}</h1>
              </header>

              <Suspense fallback={<div className="py-6 text-sm text-slate-500">Rendering…</div>}>
                <WikiMarkdown
                  body={rewriteWikilinks(page.bodyMd ?? '')}
                  onWikilink={navigateWikilink}
                />
              </Suspense>

              <Citations citations={page.citations} />
            </article>
          ) : (
            <div className="py-20 text-center text-sm text-slate-500">Page not found.</div>
          )}
        </main>
      </div>
    </div>
  )
}

// ── Markdown with intercepted wikilinks ─────────────────────────────────────

function WikiMarkdown({
  body,
  onWikilink,
}: {
  body: string
  onWikilink: (slug: string) => void
}) {
  return (
    <div
      className="wiki-body"
      onClick={(e) => {
        const target = e.target as HTMLElement
        const anchor = target.closest('a') as HTMLAnchorElement | null
        if (!anchor) return
        const href = anchor.getAttribute('href') ?? ''
        const idx = href.indexOf(WIKI_HASH)
        if (idx !== -1) {
          e.preventDefault()
          onWikilink(href.slice(idx + WIKI_HASH.length))
        }
      }}
    >
      <MarkdownView>{body}</MarkdownView>
    </div>
  )
}

// ── Citations ───────────────────────────────────────────────────────────────

function Citations({ citations }: { citations: unknown }) {
  const list = Array.isArray(citations) ? citations : []
  if (!list.length) return null
  return (
    <footer className="mt-6 border-t border-slate-800 pt-4">
      <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-slate-600">
        Citations
      </p>
      <ul className="space-y-1">
        {list.map((c, i) => {
          const text =
            typeof c === 'string'
              ? c
              : (c as { title?: string; uri?: string; text?: string })?.title ??
                (c as { uri?: string })?.uri ??
                (c as { text?: string })?.text ??
                JSON.stringify(c)
          return (
            <li key={i} className="text-xs text-slate-500">
              [{i + 1}] {text}
            </li>
          )
        })}
      </ul>
    </footer>
  )
}

// ── Source selection panel ──────────────────────────────────────────────────

function SourceSelectionPanel({
  wikiId,
  rawCompilations,
}: {
  wikiId: string
  rawCompilations: Compilation[]
}) {
  const queryClient = useQueryClient()
  const [selected, setSelected] = useState<Set<string> | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveMsg, setSaveMsg] = useState<string | null>(null)

  const { data, isLoading } = useApiQuery<WikiSourcesResponse>(
    ['wiki', 'sources', wikiId],
    `/kg/compilations/${wikiId}/wiki/sources`
  )

  useEffect(() => {
    if (data && selected === null) {
      setSelected(new Set(data.sources.map((s) => s.id)))
    }
  }, [data, selected])

  const sel = selected ?? new Set<string>()

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev ?? [])
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
    setSaveMsg(null)
  }

  async function save() {
    setSaving(true)
    setSaveMsg(null)
    try {
      await apiPut(`/kg/compilations/${wikiId}/wiki/sources`, {
        sourceCompilationIds: Array.from(sel),
      })
      const fresh = await apiGet<WikiSourcesResponse>(
        `/kg/compilations/${wikiId}/wiki/sources`
      )
      setSelected(new Set(fresh.sources.map((s) => s.id)))
      queryClient.invalidateQueries({ queryKey: ['wiki', 'sources', wikiId] })
      setSaveMsg('Sources saved.')
    } catch (e) {
      setSaveMsg(
        (e as { response?: { data?: { error?: string } } })?.response?.data?.error ??
          'Failed to save sources.'
      )
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-slate-200">Source graphs</h3>
          <p className="text-xs text-slate-500">
            Pick the RAW knowledge graphs this wiki distils from. Each page inherits
            the most-restrictive classification of its sources.
          </p>
        </div>
        <button onClick={save} disabled={saving} className="btn-primary">
          {saving ? (
            <>
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
              Saving…
            </>
          ) : (
            <>
              <Check size={15} />
              Save sources
            </>
          )}
        </button>
      </div>

      {saveMsg && <p className="mb-2 text-xs text-blue-300">{saveMsg}</p>}

      {isLoading ? (
        <div className="flex items-center justify-center py-6">
          <span className="h-5 w-5 animate-spin rounded-full border-2 border-slate-700 border-t-blue-500" />
        </div>
      ) : rawCompilations.length === 0 ? (
        <p className="rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-xs text-amber-400">
          No RAW graphs available. Create or extract a RAW graph first.
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {rawCompilations.map((c) => {
            const checked = sel.has(c.id)
            return (
              <label
                key={c.id}
                className={cn(
                  'flex cursor-pointer items-center gap-2.5 rounded-lg border px-3 py-2 transition-colors',
                  checked
                    ? 'border-blue-500/50 bg-blue-500/10'
                    : 'border-slate-700 bg-slate-900 hover:border-slate-600'
                )}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => toggle(c.id)}
                  className="h-4 w-4 rounded border-slate-600 bg-slate-800 text-blue-500"
                />
                <span className="truncate text-sm text-slate-200">{c.name}</span>
              </label>
            )
          })}
        </div>
      )}
    </div>
  )
}

export default WikiPage
