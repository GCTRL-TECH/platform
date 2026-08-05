/**
 * EmbedGraphPage — the public/embeddable graph surface (Wave 2 embed).
 *
 * Mounted via an EARLY RETURN in App() *before* ActivationGate/SetupGate/
 * ProtectedRoute — this page must render for a visitor who has never logged
 * in and never will (an iframe on a third-party site). It deliberately does
 * NOT go through react-router's <Routes> (no matched <Route>, so useParams
 * wouldn't populate anyway) — it parses its own path/query directly, and
 * uses a BARE axios call rather than `lib/api`'s `api` client, because that
 * client attaches the viewer's own JWT and redirects to /login on 401 —
 * exactly the two things an anonymous embed must never do.
 *
 * Two auth modes:
 *   - `?token=<key>`  → Authorization: ApiKey <key> against the normal
 *     (owner-scoped) /kg/compilations/:id/graph endpoint. Used for the
 *     "private link" share flow (a read-only, KB-scoped token).
 *   - no token        → GET /public/embed/:id/graph, which only serves data
 *     when the compilation owner has explicitly flipped `embed_public` on,
 *     and only ever PUBLIC-classified nodes/edges (server-enforced).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import axios from 'axios'
import { AlertCircle, Loader2, Search } from 'lucide-react'
import { WorkspaceCanvas } from '@/pages/workspace/WorkspaceCanvas'
import { EmbedNodeContext } from './EmbedNodeContext'
import { matchFocusNode } from '@/lib/graph-focus'
import type { GraphData, GraphEdge, GraphNode } from '@/components/graph-explorer/types'

const BASE_URL = (import.meta.env as Record<string, string | undefined>)['VITE_API_URL'] || '/api'

function parseCompilationId(): string | null {
  const m = /\/embed\/graph\/([^/?#]+)/.exec(window.location.pathname)
  return m ? decodeURIComponent(m[1]) : null
}

/** Display name for a node — same convention the drawer/selection lookup uses
 *  (label first, then a `name` property, then the raw id). */
function nodeDisplayName(node: GraphNode): string {
  return (node.label || (node.properties?.name as string | undefined) || node.id || '').trim()
}

/** Resolve a deep-link / postMessage target within the loaded graph: an explicit
 *  node id is authoritative; otherwise fall back to the shared focus matcher over
 *  the newline-separated `focus` candidates. Returns null when nothing matches. */
function resolveTargetNode(
  nodes: GraphNode[],
  nodeId?: string | null,
  focus?: string | null,
): GraphNode | null {
  if (nodeId) {
    const byId = nodes.find((n) => n.id === nodeId)
    if (byId) return byId
  }
  if (focus) {
    const candidates = focus.split('\n').map((s) => s.trim()).filter(Boolean)
    if (candidates.length > 0) return matchFocusNode(nodes, candidates)
  }
  return null
}

type LoadState = 'loading' | 'ready' | 'error'

export default function EmbedGraphPage() {
  const compilationId = useMemo(parseCompilationId, [])
  const searchParams = useMemo(() => new URLSearchParams(window.location.search), [])
  const token = searchParams.get('token')
  const themeParam = searchParams.get('theme') ?? undefined
  const labelsParam = searchParams.get('labels')
  const initialLabels = labelsParam === '0' ? false : labelsParam === '1' ? true : undefined
  // Deep-link / integration params — all optional; absent → current behavior.
  const nodeParam = searchParams.get('node')            // node id (authoritative)
  const focusParam = searchParams.get('focus')          // newline-separated candidate labels
  const qParam = searchParams.get('q')                  // free-text search on load
  const parentOrigin = searchParams.get('parentOrigin') // postMessage peer origin

  const [state, setState] = useState<LoadState>('loading')
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [data, setData] = useState<GraphData | null>(null)
  // Node context drawer: selected entity display name (same convention as the
  // full explorer — nodes are looked up by label first, then id).
  const [selectedName, setSelectedName] = useState<string | null>(null)
  // Camera peek target id — passed to WorkspaceCanvas.peekNodeId to center the
  // view on a deep-linked / searched node (mirrors the workspace's peek effect).
  const [peekId, setPeekId] = useState<string | null>(null)
  // Whether the current selection arrived via a deep-link / postMessage (→ open
  // the drawer on Source Text) vs. a plain user click (→ Overview).
  const [deepLinked, setDeepLinked] = useState(false)
  const [searchQuery, setSearchQuery] = useState<string>(qParam ?? '')

  // Latest loaded nodes, kept in a ref so the imperative handlers below
  // (postMessage, deep-link resolution) always see current data without
  // re-subscribing. Written during render — the accepted latest-value pattern.
  const nodesRef = useRef<GraphNode[]>([])
  nodesRef.current = data?.nodes ?? []
  const focusApplied = useRef(false)

  // GDPR/embedding hygiene: never leak the host page's URL to the API origin
  // via the Referer header on this cross-site-friendly surface.
  useEffect(() => {
    const meta = document.createElement('meta')
    meta.name = 'referrer'
    meta.content = 'no-referrer'
    document.head.appendChild(meta)
    return () => { document.head.removeChild(meta) }
  }, [])

  useEffect(() => {
    if (!compilationId) {
      setState('error')
      setErrorMsg('Invalid embed link.')
      return
    }
    let cancelled = false
    async function load() {
      try {
        const url = token
          ? `${BASE_URL}/kg/compilations/${encodeURIComponent(compilationId!)}/graph`
          : `${BASE_URL}/public/embed/${encodeURIComponent(compilationId!)}/graph`
        const res = await axios.get<GraphData>(url, {
          headers: token ? { Authorization: `ApiKey ${token}` } : undefined,
          timeout: 120_000,
        })
        if (cancelled) return
        setData(res.data)
        setState('ready')
      } catch (e: unknown) {
        if (cancelled) return
        const status = (e as { response?: { status?: number } })?.response?.status
        if (status === 401 || status === 403) {
          setErrorMsg('This embed link is no longer valid, or has been revoked.')
        } else if (status === 404) {
          setErrorMsg('This graph is not available for embedding.')
        } else {
          setErrorMsg('Could not load this graph.')
        }
        setState('error')
      }
    }
    void load()
    return () => { cancelled = true }
  }, [compilationId, token])

  // ── Cross-frame integration (postMessage) ────────────────────────────────
  // Only wired when an explicit `parentOrigin` is present — a plain embed (no
  // parentOrigin) attaches no listener and posts nothing, so it stays fully
  // backward compatible. Messages only ever drive selection/search within the
  // already-loaded, embed-scoped graph (no navigation, no privilege change).
  const postToParent = useCallback((msg: unknown) => {
    if (!parentOrigin) return
    try { window.parent.postMessage(msg, parentOrigin) } catch { /* ignore */ }
  }, [parentOrigin])

  // Select a node: drive the drawer + notify the parent frame. `peek` also
  // centers the camera (deep-link / search); `deepLink` opens Source Text.
  const selectNode = useCallback((node: GraphNode, opts: { peek: boolean; deepLink: boolean }) => {
    const name = nodeDisplayName(node) || node.id
    setSelectedName(name)
    setDeepLinked(opts.deepLink)
    if (opts.peek) setPeekId(node.id)
    postToParent({ type: 'gctrl:selected', id: node.id, label: name })
  }, [postToParent])

  // Free-text search: highlight/peek the best-matching node (no drawer). Reuses
  // the shared focus matcher over a single candidate so ranking matches the
  // deep-link path.
  const runSearch = useCallback((q: string) => {
    setSearchQuery(q)
    const query = q.trim()
    if (!query) { setPeekId(null); return }
    const best = matchFocusNode(nodesRef.current, [query])
    if (best) setPeekId(best.id)
  }, [])

  // User click on the canvas → select (Overview), and clear any lingering peek
  // so the focus highlight follows the click rather than the old peeked node.
  const handleSelect = useCallback((node: GraphNode | null) => {
    setPeekId(null)
    if (!node) { setSelectedName(null); setDeepLinked(false); return }
    selectNode(node, { peek: false, deepLink: false })
  }, [selectNode])

  // Announce readiness to the parent frame once (capabilities handshake).
  useEffect(() => {
    if (!parentOrigin) return
    try {
      window.parent.postMessage(
        { type: 'gctrl:ready', capabilities: { select: true, search: true } },
        parentOrigin,
      )
    } catch { /* ignore */ }
  }, [parentOrigin])

  // Apply the initial deep-link ONCE after data loads: `node`/`focus` select +
  // center; else a bare `q` runs a search. Missing/unknown params → no-op.
  useEffect(() => {
    if (focusApplied.current) return
    const ns = data?.nodes
    if (!ns || ns.length === 0) return
    focusApplied.current = true
    const target = resolveTargetNode(ns, nodeParam, focusParam)
    if (target) selectNode(target, { peek: true, deepLink: true })
    else if (qParam) runSearch(qParam)
  }, [data, nodeParam, focusParam, qParam, selectNode, runSearch])

  // Inbound postMessage: same resolution as the initial deep-link, but only from
  // the declared parentOrigin. Absent parentOrigin → listener never attached.
  useEffect(() => {
    if (!parentOrigin) return
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== parentOrigin) return
      const msg = event.data as { type?: string; node?: string; focus?: string; q?: string } | null
      if (!msg || typeof msg !== 'object') return
      if (msg.type === 'gctrl:select') {
        const target = resolveTargetNode(nodesRef.current, msg.node, msg.focus)
        if (target) selectNode(target, { peek: true, deepLink: true })
      } else if (msg.type === 'gctrl:search') {
        runSearch(msg.q ?? '')
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [parentOrigin, selectNode, runSearch])

  if (state === 'error') {
    return (
      <div className="flex h-screen w-screen flex-col items-center justify-center gap-3 bg-slate-950 px-6 text-center">
        <AlertCircle size={28} className="text-red-400" />
        <p className="max-w-sm text-sm text-slate-300">{errorMsg ?? 'This embed link is invalid.'}</p>
      </div>
    )
  }

  if (state === 'loading' || !data) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-slate-950">
        <Loader2 size={22} className="animate-spin text-slate-500" />
      </div>
    )
  }

  const nodes: GraphNode[] = data.nodes ?? []
  const edges: GraphEdge[] = data.edges ?? []

  const selectedNode =
    selectedName
      ? nodes.find((n) => n.label === selectedName) ?? nodes.find((n) => n.id === selectedName) ?? null
      : null

  return (
    <div className="relative h-screen w-screen overflow-hidden bg-slate-950">
      <WorkspaceCanvas
        nodes={nodes}
        edges={edges}
        selectedId={selectedNode?.id ?? null}
        onSelect={handleSelect}
        peekNodeId={peekId}
        theme={themeParam}
        initialLabels={initialLabels}
        datasetKey={compilationId ?? undefined}
        className="h-full w-full"
      />

      {/* Minimal free-text search — peeks/highlights the best-matching node.
          Top-center so it clears the canvas's own corner controls. */}
      <div className="absolute left-1/2 top-3 z-30 -translate-x-1/2">
        <div className="relative">
          <Search size={12} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500" />
          <input
            value={searchQuery}
            onChange={(e) => runSearch(e.target.value)}
            placeholder="Search nodes…"
            className="w-56 rounded-lg border border-slate-700 bg-slate-900/90 py-1.5 pl-7 pr-2 text-xs text-slate-200 placeholder-slate-500 shadow-lg focus:border-indigo-500 focus:outline-none"
          />
        </div>
      </div>

      {/* Node context drawer — overlays the right edge (closable, read-only),
          so the canvas keeps its full size underneath. */}
      {selectedName && compilationId && (
        <div className="absolute inset-y-0 right-0 z-20 w-[340px] max-w-[85vw] border-l border-slate-800 bg-slate-950/95 shadow-2xl backdrop-blur-sm">
          <EmbedNodeContext
            key={selectedName}
            baseUrl={BASE_URL}
            token={token}
            compilationId={compilationId}
            entityName={selectedName}
            localNode={selectedNode}
            nodes={nodes}
            edges={edges}
            initialTab={deepLinked && token ? 'chunks' : undefined}
            onClose={() => { setSelectedName(null); setDeepLinked(false) }}
            onNavigate={(name) => { setSelectedName(name); setDeepLinked(false) }}
          />
        </div>
      )}

      {/* Badge slides left of the drawer while it is open so it never covers it. */}
      <div
        className="pointer-events-none absolute bottom-2 z-30 rounded-md border border-slate-700/60 bg-slate-900/80 px-2 py-1 text-[10px] text-slate-400"
        style={{ right: selectedName && compilationId ? 348 : 8 }}
      >
        GCTRL · {nodes.length.toLocaleString()} nodes
      </div>
    </div>
  )
}
