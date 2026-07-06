/**
 * EmbedNodeContext — right-hand node context drawer for the embeddable graph
 * page (mirrors the full explorer's "Column 3", trimmed for the embed).
 *
 * The full explorer's NodeDetail* tabs fetch through `useApiQuery` (the JWT
 * client that redirects to /login on 401) — exactly what an anonymous iframe
 * embed must never do. This variant makes the same reads with BARE axios and
 * the embed's `?token=` ApiKey (same pattern as EmbedGraphPage's graph load):
 *   - Overview:    GET /kg/compilations/:id/entity/:name (+ local fallback)
 *   - Connections: pure in-memory graph snapshot (no request)
 *   - Source Text: GET /kex/chunks?entity=…&compilationId=…
 * Without a token (public embed) it degrades gracefully to local-only data
 * and hides the Source Text tab.
 *
 * Read-only by design: no delete/correct affordances, no load-more.
 */

import { Suspense, lazy, useEffect, useMemo, useState } from 'react'
import axios from 'axios'
import { AlertCircle, ArrowLeft, ArrowRight, Copy, Check, FileText, Network, X } from 'lucide-react'
import { getNodeColor, resolveTypeLabel } from '@/components/graph-explorer/colors'
import { NodeDetailOverview } from '@/components/graph-explorer/NodeDetailOverview'
import type {
  ChunksResponse,
  EntityDetail,
  EntityDetailResponse,
  GraphEdge,
  GraphNode,
} from '@/components/graph-explorer/types'

const MarkdownView = lazy(() => import('@/components/graph-explorer/MarkdownView'))

type Tab = 'overview' | 'connections' | 'chunks'

interface EmbedNodeContextProps {
  baseUrl: string
  /** The embed's ApiKey (`?token=`). null = public embed → local-only data. */
  token: string | null
  compilationId: string
  entityName: string
  localNode: GraphNode | null
  nodes: GraphNode[]
  edges: GraphEdge[]
  onClose: () => void
  /** Select another entity by display name (neighbor / mention click). */
  onNavigate: (name: string) => void
}

function authHeaders(token: string): Record<string, string> {
  return { Authorization: `ApiKey ${token}` }
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div>
      <p className="text-sm font-semibold text-slate-100 tabular-nums">{value}</p>
      <p className="text-[9px] uppercase tracking-wide text-slate-500">{label}</p>
    </div>
  )
}

/** Read-only connections list from the in-memory snapshot, grouped by relation. */
function EmbedConnections({
  entityId,
  nodes,
  edges,
  onNavigate,
}: {
  entityId: string | null
  nodes: GraphNode[]
  edges: GraphEdge[]
  onNavigate: (name: string) => void
}) {
  const grouped = useMemo(() => {
    const map = new Map<string, { direction: 'in' | 'out'; neighbor: GraphNode }[]>()
    if (!entityId) return map
    const nodeById = new Map(nodes.map((n) => [n.id, n]))
    const add = (rel: string, entry: { direction: 'in' | 'out'; neighbor: GraphNode }) => {
      const arr = map.get(rel) ?? []
      arr.push(entry)
      map.set(rel, arr)
    }
    for (const e of edges) {
      if (e.source === entityId) {
        const neighbor = nodeById.get(e.target)
        if (neighbor) add(e.type, { direction: 'out', neighbor })
      } else if (e.target === entityId) {
        const neighbor = nodeById.get(e.source)
        if (neighbor) add(e.type, { direction: 'in', neighbor })
      }
    }
    return map
  }, [entityId, nodes, edges])

  const relationKeys = Array.from(grouped.keys()).sort()
  const total = relationKeys.reduce((acc, k) => acc + (grouped.get(k)?.length ?? 0), 0)

  if (total === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-8 text-center">
        <Network size={22} className="text-slate-700" />
        <p className="text-sm text-slate-500">No connections in this view.</p>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <p className="text-[10px] uppercase tracking-wide text-slate-500">
        {total} connection{total === 1 ? '' : 's'} across {relationKeys.length} relation{relationKeys.length === 1 ? '' : 's'}
      </p>
      {relationKeys.map((rel) => {
        const items = grouped.get(rel) ?? []
        return (
          <section key={rel}>
            <header className="mb-1.5 flex items-center gap-2">
              <span className="inline-flex items-center rounded-md border border-slate-700 bg-slate-800/60 px-2 py-0.5 text-[10px] font-mono uppercase tracking-wide text-slate-300">
                {rel}
              </span>
              <span className="text-[10px] text-slate-600 tabular-nums">{items.length}</span>
            </header>
            <ul className="divide-y divide-slate-800 rounded-lg border border-slate-800 overflow-hidden">
              {items.map((c, i) => (
                <li key={`${rel}-${c.neighbor.id}-${i}`}>
                  <button
                    onClick={() => onNavigate(c.neighbor.label)}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-slate-800/50 transition-colors"
                  >
                    {c.direction === 'out' ? (
                      <ArrowRight size={11} className="text-slate-500 shrink-0" />
                    ) : (
                      <ArrowLeft size={11} className="text-slate-500 shrink-0" />
                    )}
                    <span
                      className="h-2 w-2 rounded-full shrink-0"
                      style={{ backgroundColor: getNodeColor(c.neighbor, 'type') }}
                    />
                    <span className="truncate text-xs text-slate-200">{c.neighbor.label}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )
      })}
    </div>
  )
}

/** Source-text chunks mentioning the entity, fetched with the embed ApiKey. */
function EmbedChunks({
  baseUrl,
  token,
  compilationId,
  entityName,
  onNavigate,
}: {
  baseUrl: string
  token: string
  compilationId: string
  entityName: string
  onNavigate: (name: string) => void
}) {
  const [data, setData] = useState<ChunksResponse | null>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')

  useEffect(() => {
    let cancelled = false
    setState('loading')
    setData(null)
    axios
      .get<ChunksResponse>(
        `${baseUrl}/kex/chunks?entity=${encodeURIComponent(entityName)}&compilationId=${encodeURIComponent(compilationId)}&limit=20`,
        { headers: authHeaders(token), timeout: 60_000 },
      )
      .then((res) => { if (!cancelled) { setData(res.data); setState('ready') } })
      .catch(() => { if (!cancelled) setState('error') })
    return () => { cancelled = true }
  }, [baseUrl, token, compilationId, entityName])

  if (state === 'loading') {
    return (
      <div className="flex items-center justify-center py-10">
        <span className="h-5 w-5 animate-spin rounded-full border-2 border-slate-700 border-t-indigo-500" />
      </div>
    )
  }
  if (state === 'error') {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
        <AlertCircle size={14} /> Failed to load source text.
      </div>
    )
  }

  const chunks = data?.chunks ?? []
  if (chunks.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
        <FileText size={22} className="text-slate-700" />
        <p className="text-sm text-slate-500">No chunks found mentioning this entity.</p>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <p className="text-[10px] uppercase tracking-wide text-slate-500">
        {chunks.length} chunk{chunks.length === 1 ? '' : 's'}
        {data?.total !== undefined && data.total > chunks.length && (
          <span className="ml-1 normal-case tracking-normal text-slate-600">
            (of {data.total.toLocaleString()} total)
          </span>
        )}
      </p>
      {chunks.map((chunk) => {
        // entity_mentions come back as objects — normalize to display names.
        const mentions = Array.from(
          new Set(
            (chunk.entityMentions ?? [])
              .map((m) =>
                typeof m === 'string'
                  ? m
                  : (m as { text?: string })?.text ?? (m as { name?: string })?.name ?? (m as { label?: string })?.label ?? '',
              )
              .map((s) => s.trim())
              .filter(Boolean),
          ),
        )
        return (
          <article key={chunk.id} className="rounded-xl border border-slate-800 bg-slate-900/60 overflow-hidden">
            <header className="border-b border-slate-800 px-3 py-2">
              <p className="truncate text-xs font-medium text-slate-400">{chunk.source ?? 'Source text'}</p>
            </header>
            <div className="px-3 py-3">
              <Suspense
                fallback={
                  <div className="flex items-center gap-2 text-xs text-slate-500">
                    <span className="h-3 w-3 animate-spin rounded-full border border-slate-700 border-t-indigo-500" />
                    Rendering…
                  </div>
                }
              >
                <MarkdownView>{chunk.content ?? ''}</MarkdownView>
              </Suspense>
            </div>
            {mentions.length > 0 && (
              <div className="border-t border-slate-800 px-3 py-2 flex flex-wrap gap-1">
                <span className="text-[10px] uppercase tracking-wide text-slate-600 mr-1 self-center">Mentions:</span>
                {mentions.map((name) => (
                  <button
                    key={name}
                    onClick={() => onNavigate(name)}
                    className="inline-flex rounded-full border border-slate-700 bg-slate-800/60 px-2 py-0.5 text-[10px] text-slate-300 hover:border-indigo-500/40 hover:text-indigo-200 transition-colors"
                  >
                    {name}
                  </button>
                ))}
              </div>
            )}
          </article>
        )
      })}
    </div>
  )
}

export function EmbedNodeContext({
  baseUrl,
  token,
  compilationId,
  entityName,
  localNode,
  nodes,
  edges,
  onClose,
  onNavigate,
}: EmbedNodeContextProps) {
  const [tab, setTab] = useState<Tab>('overview')
  const [copied, setCopied] = useState(false)
  const [detail, setDetail] = useState<EntityDetail | null>(null)
  const [detailError, setDetailError] = useState<string | null>(null)

  // Entity detail via the embed ApiKey (skipped for tokenless public embeds —
  // the drawer then runs on the local snapshot alone).
  useEffect(() => {
    setDetail(null)
    setDetailError(null)
    if (!token) return
    let cancelled = false
    axios
      .get<EntityDetailResponse>(
        `${baseUrl}/kg/compilations/${encodeURIComponent(compilationId)}/entity/${encodeURIComponent(entityName)}`,
        { headers: authHeaders(token), timeout: 60_000 },
      )
      .then((res) => { if (!cancelled) setDetail(res.data.entity ?? null) })
      .catch((e: unknown) => {
        if (cancelled) return
        const status = (e as { response?: { status?: number } })?.response?.status
        setDetailError(
          status === 404
            ? 'No details found for this entity in this graph.'
            : 'Could not load entity details.',
        )
      })
    return () => { cancelled = true }
  }, [baseUrl, token, compilationId, entityName])

  const headerNode: GraphNode = localNode ?? {
    id: detail?.id ?? entityName,
    label: detail?.label ?? entityName,
    type: detail?.type ?? 'Entity',
    properties: detail?.properties ?? {},
  }
  const color = getNodeColor(headerNode, 'type')
  const typeLabel = resolveTypeLabel(headerNode)

  const counts = useMemo(() => {
    let inDeg = 0
    let outDeg = 0
    const neighbors = new Set<string>()
    const id = localNode?.id ?? entityName
    for (const e of edges) {
      if (e.source === id) { outDeg++; neighbors.add(e.target) }
      else if (e.target === id) { inDeg++; neighbors.add(e.source) }
    }
    return { inDeg, outDeg, neighborCount: neighbors.size }
  }, [edges, localNode, entityName])

  const inDegree = detail?.inDegree ?? counts.inDeg
  const outDegree = detail?.outDegree ?? counts.outDeg

  const TABS: { id: Tab; label: string }[] = [
    { id: 'overview', label: 'Overview' },
    { id: 'connections', label: 'Connections' },
    // Source text needs the ApiKey — hidden on tokenless public embeds.
    ...(token ? [{ id: 'chunks' as Tab, label: 'Source Text' }] : []),
  ]

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-start gap-2 border-b border-slate-800 px-4 py-3">
        <span className="mt-1.5 h-3 w-3 shrink-0 rounded-full" style={{ backgroundColor: color }} />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-semibold text-slate-100">{entityName}</h2>
          <p className="mt-0.5 text-[10px] uppercase tracking-wide text-slate-500">{typeLabel}</p>
        </div>
        <button
          onClick={() => { navigator.clipboard.writeText(entityName); setCopied(true); setTimeout(() => setCopied(false), 1500) }}
          className="rounded-md p-1.5 text-slate-500 hover:bg-slate-800 hover:text-slate-200"
          title="Copy name"
        >
          {copied ? <Check size={13} className="text-emerald-400" /> : <Copy size={13} />}
        </button>
        <button onClick={onClose} className="rounded-md p-1.5 text-slate-500 hover:bg-slate-800 hover:text-slate-200" title="Close">
          <X size={14} />
        </button>
      </header>

      <div className="grid grid-cols-3 gap-1 border-b border-slate-800 bg-slate-900/40 px-4 py-2 text-center">
        <Stat label="In" value={inDegree} />
        <Stat label="Out" value={outDegree} />
        <Stat label="Chunks" value={detail?.chunkCount ?? '—'} />
      </div>

      <nav className="flex border-b border-slate-800 px-2">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={
              'px-2.5 py-2 text-[11px] font-medium border-b-2 -mb-px transition-colors ' +
              (tab === t.id
                ? 'border-indigo-500 text-indigo-300'
                : 'border-transparent text-slate-500 hover:text-slate-300')
            }
          >
            {t.label}
          </button>
        ))}
      </nav>

      {detailError && (
        <div className="mx-4 mt-3 rounded-md border border-amber-700/40 bg-amber-950/30 px-3 py-2 text-[11px] text-amber-300">
          {detailError}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {tab === 'overview' && (
          <NodeDetailOverview
            entityName={entityName}
            detail={detail}
            localNode={localNode}
            colorBy="type"
            inDegree={inDegree}
            outDegree={outDegree}
            neighborCount={counts.neighborCount}
          />
        )}
        {tab === 'connections' && (
          <EmbedConnections
            entityId={localNode?.id ?? null}
            nodes={nodes}
            edges={edges}
            onNavigate={onNavigate}
          />
        )}
        {tab === 'chunks' && token && (
          <EmbedChunks
            baseUrl={baseUrl}
            token={token}
            compilationId={compilationId}
            entityName={entityName}
            onNavigate={onNavigate}
          />
        )}
      </div>
    </div>
  )
}
