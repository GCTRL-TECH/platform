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

import { useEffect, useMemo, useState } from 'react'
import axios from 'axios'
import { AlertCircle, Loader2 } from 'lucide-react'
import { WorkspaceCanvas } from '@/pages/workspace/WorkspaceCanvas'
import { EmbedNodeContext } from './EmbedNodeContext'
import type { GraphData, GraphEdge, GraphNode } from '@/components/graph-explorer/types'

const BASE_URL = (import.meta.env as Record<string, string | undefined>)['VITE_API_URL'] || '/api'

function parseCompilationId(): string | null {
  const m = /\/embed\/graph\/([^/?#]+)/.exec(window.location.pathname)
  return m ? decodeURIComponent(m[1]) : null
}

type LoadState = 'loading' | 'ready' | 'error'

export default function EmbedGraphPage() {
  const compilationId = useMemo(parseCompilationId, [])
  const searchParams = useMemo(() => new URLSearchParams(window.location.search), [])
  const token = searchParams.get('token')
  const themeParam = searchParams.get('theme') ?? undefined
  const labelsParam = searchParams.get('labels')
  const initialLabels = labelsParam === '0' ? false : labelsParam === '1' ? true : undefined

  const [state, setState] = useState<LoadState>('loading')
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [data, setData] = useState<GraphData | null>(null)
  // Node context drawer: selected entity display name (same convention as the
  // full explorer — nodes are looked up by label first, then id).
  const [selectedName, setSelectedName] = useState<string | null>(null)

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

  function handleSelect(node: GraphNode | null) {
    const name = node ? (node.label || (node.properties?.name as string | undefined) || '') : null
    setSelectedName(name || null)
  }

  return (
    <div className="relative h-screen w-screen overflow-hidden bg-slate-950">
      <WorkspaceCanvas
        nodes={nodes}
        edges={edges}
        selectedId={selectedNode?.id ?? null}
        onSelect={handleSelect}
        theme={themeParam}
        initialLabels={initialLabels}
        datasetKey={compilationId ?? undefined}
        className="h-full w-full"
      />

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
            onClose={() => setSelectedName(null)}
            onNavigate={(name) => setSelectedName(name)}
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
