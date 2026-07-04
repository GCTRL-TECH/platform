/**
 * GraphWorkspace — the prominent multi-viewport graph explorer (Phase 3).
 *
 * Three columns, window-manager style:
 *   1. Graphs   — pick / search a compilation
 *   2. Canvas   — the interactive force graph (WorkspaceCanvas)
 *   3. Context  — the selected node's overview, connections, and the source
 *                 chunks behind it (classification-filtered) in an Obsidian-style
 *                 reader. Selecting a node in column 2 drives column 3 directly —
 *                 no modal, no slide-over.
 */

import { Component, useEffect, useMemo, useRef, useState, type ReactNode, type PointerEvent as ReactPointerEvent } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import {
  ArrowLeft, Search, Network, Hash, Copy, Check, X, PanelRightClose, PanelRightOpen,
  PanelLeftClose, PanelLeftOpen, Share2,
} from 'lucide-react'
import { useApiQuery } from '@/hooks/useApi'
import { useQueryClient } from '@tanstack/react-query'
import { cn } from '@/lib/utils'
import { useGraphData } from '@/components/graph-explorer/hooks'
import { getNodeColor, resolveTypeLabel } from '@/components/graph-explorer/colors'
import type { EntityDetailResponse, GraphNode } from '@/components/graph-explorer/types'
import { NodeDetailOverview } from '@/components/graph-explorer/NodeDetailOverview'
import { NodeDetailConnections } from '@/components/graph-explorer/NodeDetailConnections'
import { NodeDetailChunks } from '@/components/graph-explorer/NodeDetailChunks'
import { NodeDetailSource } from '@/components/graph-explorer/NodeDetailSource'
import { NodeDetailDossier } from '@/components/graph-explorer/NodeDetailDossier'
import { WorkspaceCanvas } from './WorkspaceCanvas'
import { EmbedShareDialog } from './EmbedShareDialog'

interface CompilationSummary {
  id: string
  name: string
  nodeCount: number
  edgeCount: number
  classification: string
  embedPublic?: boolean
}

const CLS_BADGE: Record<string, string> = {
  PUBLIC: 'badge-green', INTERNAL: 'badge-blue', CONFIDENTIAL: 'badge-yellow', RESTRICTED: 'badge-red',
}

type DetailTab = 'overview' | 'dossier' | 'connections' | 'chunks' | 'source'

function readNum(key: string, def: number): number {
  try {
    const v = localStorage.getItem(key)
    if (v != null) { const n = parseInt(v, 10); if (!Number.isNaN(n)) return n }
  } catch { /* ignore */ }
  return def
}

/** Pointer-drag column resize. `side` = which edge the handle sits on relative to
 *  the column it resizes ('right' → dragging right grows it; 'left' → dragging
 *  left grows it). Clamped, and the final width is persisted on pointer-up. */
function useColResize(
  width: number, setWidth: (w: number) => void,
  side: 'left' | 'right', min: number, getMax: () => number, storeKey: string,
) {
  const start = useRef<{ x: number; w: number } | null>(null)
  const widthRef = useRef(width); widthRef.current = width
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* ignore */ }
    start.current = { x: e.clientX, w: widthRef.current }
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'col-resize'
  }
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!start.current) return
    const dx = e.clientX - start.current.x
    const raw = side === 'right' ? start.current.w + dx : start.current.w - dx
    setWidth(Math.max(min, Math.min(getMax(), Math.round(raw))))
  }
  const end = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!start.current) return
    start.current = null
    document.body.style.userSelect = ''
    document.body.style.cursor = ''
    try { localStorage.setItem(storeKey, String(widthRef.current)) } catch { /* ignore */ }
    try { e.currentTarget.releasePointerCapture?.(e.pointerId) } catch { /* ignore */ }
  }
  return { onPointerDown, onPointerMove, onPointerUp: end, onPointerCancel: end }
}

const HANDLE_CLS = 'w-1 shrink-0 cursor-col-resize bg-slate-800/60 hover:bg-indigo-500/50 transition-colors'

export function GraphWorkspace() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const compilationId = id ?? ''
  const queryClient = useQueryClient()

  const { data: compsData } = useApiQuery<{ compilations: CompilationSummary[] }>(['kg', 'compilations'], '/kg/compilations')
  const comps = compsData?.compilations ?? []
  const current = comps.find((c) => c.id === compilationId)

  const { nodes, edges, nodeCount, edgeCount, truncated, isLoading, error, mergeNeighbors } = useGraphData(compilationId)

  const [shareOpen, setShareOpen] = useState(false)

  const [pickerQuery, setPickerQuery] = useState('')
  const [selectedName, setSelectedName] = useState<string | null>(null)
  const [contextOpen, setContextOpen] = useState(true)

  // Collapsible/resizable columns (persisted).
  const [pickerOpen, setPickerOpen] = useState<boolean>(() => {
    try { return localStorage.getItem('gw.pickerOpen') !== '0' } catch { return true }
  })
  const [pickerWidth, setPickerWidth] = useState<number>(() => readNum('gw.pickerWidth', 240))
  const [contextWidth, setContextWidth] = useState<number>(() => readNum('gw.contextWidth', 380))
  function togglePicker() {
    setPickerOpen((v) => { const nv = !v; try { localStorage.setItem('gw.pickerOpen', nv ? '1' : '0') } catch { /* */ } return nv })
  }
  const pickerResize = useColResize(pickerWidth, setPickerWidth, 'right', 180, () => 420, 'gw.pickerWidth')
  const contextResize = useColResize(contextWidth, setContextWidth, 'left', 280, () => Math.min(window.innerWidth * 0.7, 900), 'gw.contextWidth')

  const filteredComps = comps.filter((c) => c.name.toLowerCase().includes(pickerQuery.toLowerCase()))

  // Left-column mode: search compilations ("Graphs") or nodes within this graph.
  const [leftTab, setLeftTab] = useState<'graphs' | 'nodes'>('graphs')
  const [nodeQuery, setNodeQuery] = useState('')
  const [peekId, setPeekId] = useState<string | null>(null) // hovered search result → camera jumps here

  // Deep-link: /graphs/:id/workspace?focus=<entityName(s)> (e.g. from a Talk-to-
  // Graph source) → select + center the node so the user can trace the chunk's
  // origin. `focus` may carry several candidate names separated by newlines (a
  // chunk mentions many entities; only some are real nodes). We pick the FIRST
  // candidate that resolves to an actual node — matched exactly, then
  // case-insensitively — so the click always lands on a real, selected node.
  const [searchParams] = useSearchParams()
  const focusParam = searchParams.get('focus')
  const focusApplied = useRef(false)
  useEffect(() => {
    if (focusApplied.current || !focusParam || nodes.length === 0) return
    const candidates = focusParam.split('\n').map((s) => s.trim()).filter(Boolean)
    if (candidates.length === 0) return

    // Score every node against the candidate mentions and pick the best.
    // Mentions are often partial ("Fabio" for node "Fabio Chiaramonte") or generic
    // ("German"), so we go beyond exact match: exact > word-prefix > substring,
    // weighting earlier candidates higher and de-prioritising email/URL-ish labels
    // (so "Fabio" lands on the person, not "fabio@fjalla.net").
    const nameOf = (x: GraphNode) =>
      (x.label || (x.properties?.name as string | undefined) || x.id || '').trim()
    const looksTechnical = (s: string) => /[@/]|https?:|\.\w{2,}$/.test(s)

    let bestNode: GraphNode | null = null
    let bestScore = -Infinity
    for (let idx = 0; idx < candidates.length; idx++) {
      const lc = candidates[idx].toLowerCase()
      if (lc.length < 2) continue
      const candWeight = candidates.length - idx // earlier mention = higher
      const escaped = lc.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const wordRe = new RegExp(`\\b${escaped}\\b`)
      for (const node of nodes) {
        const label = nameOf(node)
        const ll = label.toLowerCase()
        if (!ll) continue
        let base = 0
        if (ll === lc) base = 100
        else if (ll.startsWith(lc + ' ') || ll.startsWith(lc + ',')) base = 80
        else if (wordRe.test(ll)) base = 60
        else if (ll.includes(lc)) base = 40
        else if (lc.includes(ll) && ll.length >= 3) base = 30
        if (base === 0) continue
        // Shorter, non-technical labels are more likely the canonical entity.
        let score = base + candWeight - label.length * 0.1
        if (looksTechnical(label)) score -= 25
        if (score > bestScore) {
          bestScore = score
          bestNode = node
        }
      }
    }

    if (bestNode) {
      focusApplied.current = true
      setSelectedName(nameOf(bestNode) || bestNode.id)
      setContextOpen(true)
      setPeekId(bestNode.id) // centers the camera via WorkspaceCanvas's peek effect
    }
  }, [focusParam, nodes])

  const nodeResults = useMemo<GraphNode[]>(() => {
    const q = nodeQuery.trim().toLowerCase()
    if (!q) return []
    const named = (n: GraphNode) => (n.label || (n.properties?.name as string | undefined) || n.id)
    const matched = nodes.filter((n) => named(n).toLowerCase().includes(q))
    // Prefix matches first, then by name; cap for performance.
    matched.sort((a, b) => {
      const an = named(a).toLowerCase(), bn = named(b).toLowerCase()
      const ap = an.startsWith(q) ? 0 : 1, bp = bn.startsWith(q) ? 0 : 1
      return ap - bp || an.localeCompare(bn)
    })
    return matched.slice(0, 100)
  }, [nodes, nodeQuery])

  const selectedNode = useMemo<GraphNode | null>(() => {
    if (!selectedName) return null
    return nodes.find((n) => n.label === selectedName) ?? nodes.find((n) => n.id === selectedName) ?? null
  }, [nodes, selectedName])

  function handleSelect(node: GraphNode | null) {
    const name = node ? (node.label || (node.properties?.name as string | undefined) || '') : null
    setSelectedName(name || null)
    if (name) setContextOpen(true)
  }

  return (
    <div className="flex h-full flex-col bg-slate-950">
      {/* Header bar */}
      <div className="flex h-12 shrink-0 items-center gap-3 border-b border-slate-800 px-4">
        <button onClick={() => navigate(`/graphs/${compilationId}`)} className="btn-ghost text-slate-500 hover:text-slate-300" title="Back to graph details">
          <ArrowLeft size={16} />
        </button>
        <h1 className="text-sm font-semibold text-slate-100">{current?.name ?? 'Graph Workspace'}</h1>
        {current && <span className={cn(CLS_BADGE[current.classification] ?? 'badge-slate', 'text-[10px]')}>{current.classification}</span>}
        {/* True totals from the API. When the canvas shows only the degree-ordered
            core, say so explicitly so differently-sized graphs visibly differ and
            the user knows it's a subset. */}
        <span className="text-xs text-slate-600">
          {truncated ? (
            <>
              showing <span className="tabular-nums text-slate-400">{nodes.length.toLocaleString()}</span> of{' '}
              <span className="tabular-nums text-slate-400">{nodeCount.toLocaleString()}</span> nodes ·{' '}
              <span className="tabular-nums text-slate-400">{edges.length.toLocaleString()}</span> of{' '}
              <span className="tabular-nums text-slate-400">{edgeCount.toLocaleString()}</span> edges
            </>
          ) : (
            <>
              <span className="tabular-nums">{nodeCount.toLocaleString()}</span> nodes ·{' '}
              <span className="tabular-nums">{edgeCount.toLocaleString()}</span> edges
              {nodes.length > 400 && (
                <span className="text-slate-700"> · zoom &amp; pan to explore all</span>
              )}
            </>
          )}
        </span>
        <div className="ml-auto flex items-center gap-1">
          {current && (
            <button onClick={() => setShareOpen(true)} className="btn-ghost text-slate-500 hover:text-slate-300" title="Share / embed this graph">
              <Share2 size={16} />
            </button>
          )}
          <button onClick={() => setContextOpen((v) => !v)} className="btn-ghost text-slate-500 hover:text-slate-300" title={contextOpen ? 'Hide context' : 'Show context'}>
            {contextOpen ? <PanelRightClose size={16} /> : <PanelRightOpen size={16} />}
          </button>
        </div>
      </div>

      {current && (
        <EmbedShareDialog
          open={shareOpen}
          onClose={() => setShareOpen(false)}
          compilationId={current.id}
          compilationName={current.name}
          embedPublic={current.embedPublic ?? false}
          onEmbedPublicChange={(enabled) => {
            queryClient.setQueryData<{ compilations: CompilationSummary[] }>(['kg', 'compilations'], (prev) =>
              prev ? { compilations: prev.compilations.map((c) => (c.id === current.id ? { ...c, embedPublic: enabled } : c)) } : prev,
            )
          }}
        />
      )}

      <div className="flex min-h-0 flex-1">
        {/* Column 1 — graph picker (collapsible + resizable) */}
        {pickerOpen ? (
          <>
            <div className="flex shrink-0 flex-col border-r border-slate-800" style={{ width: pickerWidth }}>
              {/* Tabs: search graphs or nodes + collapse */}
              <div className="flex items-center gap-1 border-b border-slate-800 p-2">
                <div className="flex flex-1 overflow-hidden rounded-md border border-slate-700 bg-slate-800/60 text-[11px]">
                  <button onClick={() => setLeftTab('graphs')} className={cn('flex-1 px-2 py-1', leftTab === 'graphs' ? 'bg-slate-700 text-slate-100' : 'text-slate-500 hover:text-slate-300')}>Graphs</button>
                  <button onClick={() => setLeftTab('nodes')} className={cn('flex-1 px-2 py-1', leftTab === 'nodes' ? 'bg-slate-700 text-slate-100' : 'text-slate-500 hover:text-slate-300')}>Nodes</button>
                </div>
                <button onClick={togglePicker} title="Collapse panel" className="btn-ghost shrink-0 text-slate-500 hover:text-slate-300">
                  <PanelLeftClose size={15} />
                </button>
              </div>

              {leftTab === 'graphs' ? (
                <>
                  <div className="border-b border-slate-800 p-2">
                    <div className="relative">
                      <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500" />
                      <input value={pickerQuery} onChange={(e) => setPickerQuery(e.target.value)} placeholder="Find a graph…"
                        className="w-full rounded-md border border-slate-700 bg-slate-800/80 py-1.5 pl-7 pr-2 text-xs text-slate-200 placeholder-slate-500 focus:border-indigo-500 focus:outline-none" />
                    </div>
                  </div>
                  <div className="flex-1 overflow-y-auto p-1.5">
                    {filteredComps.map((c) => (
                      <button key={c.id} onClick={() => { navigate(`/graphs/${c.id}/workspace`); setSelectedName(null) }}
                        className={cn('mb-0.5 flex w-full flex-col items-start gap-0.5 rounded-md px-2.5 py-2 text-left transition-colors',
                          c.id === compilationId ? 'bg-indigo-500/15 ring-1 ring-indigo-500/30' : 'hover:bg-slate-800/60')}>
                        <span className="truncate text-xs font-medium text-slate-200">{c.name}</span>
                        <span className="flex items-center gap-2 text-[10px] text-slate-500">
                          <span className={cn(CLS_BADGE[c.classification] ?? 'badge-slate', 'text-[9px]')}>{c.classification}</span>
                          {c.nodeCount.toLocaleString()} nodes
                        </span>
                      </button>
                    ))}
                    {filteredComps.length === 0 && <p className="px-2 py-4 text-center text-[11px] text-slate-600">No graphs.</p>}
                  </div>
                </>
              ) : (
                <>
                  <div className="border-b border-slate-800 p-2">
                    <div className="relative">
                      <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500" />
                      <input value={nodeQuery} onChange={(e) => setNodeQuery(e.target.value)} placeholder="Find a node…" autoFocus
                        className="w-full rounded-md border border-slate-700 bg-slate-800/80 py-1.5 pl-7 pr-2 text-xs text-slate-200 placeholder-slate-500 focus:border-indigo-500 focus:outline-none" />
                    </div>
                  </div>
                  {/* Hover a result → the canvas jumps to that node; click → select it. */}
                  <div className="flex-1 overflow-y-auto p-1.5" onMouseLeave={() => setPeekId(null)}>
                    {nodeQuery.trim() === '' && (
                      <p className="px-2 py-4 text-center text-[11px] text-slate-600">Type to search nodes. Hover a result to jump to it on the canvas.</p>
                    )}
                    {nodeQuery.trim() !== '' && nodeResults.length === 0 && (
                      <p className="px-2 py-4 text-center text-[11px] text-slate-600">No matching nodes.</p>
                    )}
                    {nodeResults.map((n) => {
                      const name = n.label || (n.properties?.name as string | undefined) || n.id
                      const active = selectedName === name
                      return (
                        <button key={n.id}
                          onMouseEnter={() => setPeekId(n.id)}
                          onClick={() => handleSelect(n)}
                          className={cn('mb-0.5 flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left transition-colors',
                            active ? 'bg-indigo-500/15 ring-1 ring-indigo-500/30' : 'hover:bg-slate-800/60')}>
                          <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: getNodeColor(n, 'type') }} />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-xs text-slate-200">{name}</span>
                            <span className="block truncate text-[10px] text-slate-500">{resolveTypeLabel(n)}</span>
                          </span>
                        </button>
                      )
                    })}
                    {nodeResults.length === 100 && (
                      <p className="px-2 py-2 text-center text-[10px] text-slate-600">Showing first 100 — refine your search.</p>
                    )}
                  </div>
                </>
              )}
            </div>
            <div {...pickerResize} className={HANDLE_CLS} title="Drag to resize" />
          </>
        ) : (
          <div className="flex w-9 shrink-0 flex-col items-center border-r border-slate-800 py-2">
            <button onClick={togglePicker} title="Show graph list" className="btn-ghost text-slate-500 hover:text-slate-300">
              <PanelLeftOpen size={15} />
            </button>
          </div>
        )}

        {/* Column 2 — canvas */}
        <div className="relative min-w-0 flex-1">
          {isLoading && (
            <div className="absolute inset-0 z-10 flex items-center justify-center bg-slate-950/40">
              <span className="h-7 w-7 animate-spin rounded-full border-2 border-slate-700 border-t-blue-500" />
            </div>
          )}
          {error && (
            <div className="absolute inset-0 z-10 flex items-center justify-center text-sm text-red-400">Failed to load graph: {error.message}</div>
          )}
          <WorkspaceCanvas nodes={nodes} edges={edges} selectedId={selectedNode?.id ?? null} onSelect={handleSelect} peekNodeId={peekId} datasetKey={compilationId} />
        </div>

        {/* Column 3 — node context (resizable) */}
        {contextOpen && (
          <>
            <div {...contextResize} className={HANDLE_CLS} title="Drag to resize" />
            <div className="flex shrink-0 flex-col border-l border-slate-800" style={{ width: contextWidth }}>
            {selectedName ? (
              <NodeContext
                key={selectedName}
                compilationId={compilationId}
                entityName={selectedName}
                localNode={selectedNode}
                nodes={nodes}
                edges={edges}
                onClose={() => setSelectedName(null)}
                onNavigate={(name) => { setSelectedName(name); void mergeNeighbors(name) }}
                onLoadMore={() => mergeNeighbors(selectedName)}
              />
            ) : (
              <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
                <Network size={22} className="text-slate-700" />
                <p className="text-sm text-slate-500">Select a node</p>
                <p className="text-[11px] text-slate-600">Click any node in the graph to see its details, connections, and the source text behind it.</p>
              </div>
            )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

// ─── Node context panel (column 3) ───────────────────────────────────────────────

function NodeContext({
  compilationId, entityName, localNode, nodes, edges, onClose, onNavigate, onLoadMore,
}: {
  compilationId: string
  entityName: string
  localNode: GraphNode | null
  nodes: GraphNode[]
  edges: { source: string; target: string; type: string }[]
  onClose: () => void
  onNavigate: (name: string) => void
  onLoadMore: () => Promise<void> | void
}) {
  const [tab, setTab] = useState<DetailTab>('overview')
  const [copied, setCopied] = useState(false)

  const { data: detailData, isLoading, error, refetch } = useApiQuery<EntityDetailResponse>(
    ['kg', 'compilations', compilationId, 'entity', entityName],
    `/kg/compilations/${encodeURIComponent(compilationId)}/entity/${encodeURIComponent(entityName)}`,
    { enabled: !!entityName, retry: 1 },
  )
  const detail = detailData?.entity ?? null
  // A 404 means this exact name has no node in scope (e.g. a label that differs
  // from the stored `name`); any other error is a transient/server failure. Both
  // must surface a clear, recoverable message — never leave the panel "stuck"
  // silently showing zeros with no explanation.
  const detailError = error
    ? ((error as { response?: { status?: number } })?.response?.status === 404
        ? 'No details found for this entity in this graph.'
        : 'Could not load entity details.')
    : null

  const headerNode: GraphNode = localNode ?? {
    id: detail?.id ?? entityName, label: detail?.label ?? entityName, type: detail?.type ?? 'Entity', properties: detail?.properties ?? {},
  }
  const color = getNodeColor(headerNode, 'type')
  const typeLabel = resolveTypeLabel(headerNode)

  const counts = useMemo(() => {
    let inDeg = 0, outDeg = 0
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

  const TABS: { id: DetailTab; label: string }[] = [
    { id: 'overview', label: 'Overview' },
    { id: 'dossier', label: 'Dossier' },
    { id: 'connections', label: 'Connections' },
    { id: 'chunks', label: 'Source Text' },
    { id: 'source', label: 'Provenance' },
  ]

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-start gap-2 border-b border-slate-800 px-4 py-3">
        <span className="mt-1.5 h-3 w-3 shrink-0 rounded-full" style={{ backgroundColor: color }} />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-semibold text-slate-100">{entityName}</h2>
          <p className="mt-0.5 text-[10px] uppercase tracking-wide text-slate-500">{typeLabel}</p>
        </div>
        <button onClick={() => { navigator.clipboard.writeText(entityName); setCopied(true); setTimeout(() => setCopied(false), 1500) }}
          className="rounded-md p-1.5 text-slate-500 hover:bg-slate-800 hover:text-slate-200" title="Copy name">
          {copied ? <Check size={13} className="text-emerald-400" /> : <Copy size={13} />}
        </button>
        <button onClick={onClose} className="rounded-md p-1.5 text-slate-500 hover:bg-slate-800 hover:text-slate-200" title="Close"><X size={14} /></button>
      </header>

      <div className="grid grid-cols-3 gap-1 border-b border-slate-800 bg-slate-900/40 px-4 py-2 text-center">
        <Stat label="In" value={inDegree} />
        <Stat label="Out" value={outDegree} />
        <Stat label="Chunks" value={detail?.chunkCount ?? '—'} />
      </div>

      <nav className="flex border-b border-slate-800 px-2">
        {TABS.map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={cn('px-2.5 py-2 text-[11px] font-medium border-b-2 -mb-px transition-colors',
              tab === t.id ? 'border-indigo-500 text-indigo-300' : 'border-transparent text-slate-500 hover:text-slate-300')}>
            {t.label}
          </button>
        ))}
      </nav>

      {/* A failed entity-detail fetch is surfaced inline (with retry) so the panel
          is never silently stuck on zeros. The graph/connections still work off
          local data, so this is a notice, not a full-panel takeover. */}
      {detailError && (
        <div className="mx-4 mt-3 flex items-start gap-2 rounded-md border border-amber-700/40 bg-amber-950/30 px-3 py-2 text-[11px] text-amber-300">
          <span className="flex-1">{detailError}</span>
          <button onClick={() => void refetch()} className="shrink-0 rounded border border-amber-700/50 px-2 py-0.5 text-amber-200 hover:bg-amber-900/40">
            Retry
          </button>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {/* A render fault in any tab must never blank the whole workspace and
            strand the user (no way back). Reset on tab change via `key`. */}
        <DetailBoundary key={tab}>
          {tab === 'overview' && (
            <NodeDetailOverview entityName={entityName} detail={detail} localNode={localNode} colorBy="type"
              inDegree={inDegree} outDegree={outDegree} neighborCount={counts.neighborCount} />
          )}
          {tab === 'dossier' && (
            <NodeDetailDossier entityName={entityName} enabled={tab === 'dossier'} onNavigateToEntity={onNavigate} />
          )}
          {tab === 'connections' && (
            <NodeDetailConnections entityName={entityName} entityId={localNode?.id ?? null} compilationId={compilationId} nodes={nodes} edges={edges as never}
              colorBy="type" onNavigateToEntity={onNavigate} onLoadMoreNeighbors={onLoadMore} />
          )}
          {tab === 'chunks' && (
            <NodeDetailChunks entityName={entityName} compilationId={compilationId} enabled={tab === 'chunks'} onNavigateToEntity={onNavigate} />
          )}
          {tab === 'source' && (
            <NodeDetailSource detail={detail} isLoading={isLoading} entityName={entityName}
              compilationId={compilationId} enabled={tab === 'source'} onNavigateToEntity={onNavigate} />
          )}
        </DetailBoundary>
      </div>
    </div>
  )
}

/** Isolates a node-detail tab so a render fault shows an inline error instead of
 *  blanking the workspace (which left the user with no way back). */
class DetailBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  constructor(props: { children: ReactNode }) {
    super(props)
    this.state = { error: null }
  }
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  render() {
    if (this.state.error) {
      return (
        <div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
          <p className="text-sm font-medium text-red-300">Couldn't render this panel</p>
          <p className="max-w-xs break-words text-xs text-red-400/80">{this.state.error.message}</p>
          <button
            onClick={() => this.setState({ error: null })}
            className="mt-1 rounded-md border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-700"
          >
            Retry
          </button>
        </div>
      )
    }
    return this.props.children
  }
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div>
      <p className="text-[9px] uppercase tracking-wide text-slate-500">{label}</p>
      <p className="text-sm font-semibold tabular-nums text-slate-100 flex items-center justify-center gap-1">
        {label === 'Chunks' && <Hash size={10} className="text-slate-600" />}{value}
      </p>
    </div>
  )
}
