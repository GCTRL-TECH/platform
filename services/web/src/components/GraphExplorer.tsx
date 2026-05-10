import {
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
  Suspense,
  lazy,
} from 'react'
import { Search, X, AlertCircle, Network, Box, Square } from 'lucide-react'
import { apiGet } from '@/lib/api'
import { cn } from '@/lib/utils'

// ─── Types ────────────────────────────────────────────────────────────────────

interface GraphNode {
  id: string
  label: string
  type: string
  properties: Record<string, unknown>
}

interface GraphEdge {
  source: string
  target: string
  type: string
}

interface GraphData {
  nodes: GraphNode[]
  edges: GraphEdge[]
}

export interface GraphExplorerProps {
  compilationId: string
  className?: string
}

type ViewMode = '2d' | '3d'

// react-force-graph data shape — node has free-form fields, links use source/target.
// We extend GraphNode with optional simulation/runtime fields the libs add internally.
interface FGNode extends GraphNode {
  // simulation will mutate x/y/z/vx/vy/vz on the node objects directly
  x?: number
  y?: number
  z?: number
}

interface FGLink {
  source: string
  target: string
  type: string
}

interface FGData {
  nodes: FGNode[]
  links: FGLink[]
}

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_DISPLAY_NODES = 500

const TYPE_COLORS: Record<string, string> = {
  Person: '#6366f1',
  Organization: '#f59e0b',
  Location: '#10b981',
  Event: '#ec4899',
  Product: '#3b82f6',
  Concept: '#8b5cf6',
}
const DEFAULT_COLOR = '#94a3b8'
const BG_COLOR = '#020617'

function nodeColor(type: string): string {
  return TYPE_COLORS[type] ?? DEFAULT_COLOR
}

// ─── Lazy-loaded force-graph components (SSR safety + chunk split) ────────────

const ForceGraph2D = lazy(() =>
  import('react-force-graph-2d').then((m) => ({ default: m.default }))
)

const ForceGraph3D = lazy(() =>
  import('react-force-graph-3d').then((m) => ({ default: m.default }))
)

// ─── Side panel ───────────────────────────────────────────────────────────────

function NodePanel({
  node,
  onClose,
  onLoadNeighbors,
  loading,
}: {
  node: GraphNode
  onClose: () => void
  onLoadNeighbors: (nodeLabel: string) => void
  loading: boolean
}) {
  const color = nodeColor(node.type)
  const entries = Object.entries(node.properties ?? {}).filter(
    ([k]) => k !== 'id' && k !== 'label' && k !== 'type'
  )

  return (
    <div className="absolute right-0 top-0 h-full w-72 rounded-r-xl border-l border-slate-700/60 bg-slate-900/95 backdrop-blur-sm flex flex-col z-20">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-slate-800 px-4 py-3">
        <div className="flex items-center gap-2 min-w-0">
          <span
            className="h-3 w-3 rounded-full shrink-0"
            style={{ backgroundColor: color }}
          />
          <span className="text-sm font-semibold text-slate-100 truncate">{node.label}</span>
        </div>
        <button
          onClick={onClose}
          className="ml-2 shrink-0 text-slate-500 hover:text-slate-300 transition-colors"
        >
          <X size={14} />
        </button>
      </div>

      {/* Type badge */}
      <div className="border-b border-slate-800 px-4 py-2">
        <span
          className="inline-block rounded-md px-2 py-0.5 text-xs font-medium"
          style={{ backgroundColor: `${color}22`, color }}
        >
          {node.type || 'Unknown'}
        </span>
      </div>

      {/* Properties */}
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-2">
        {entries.length === 0 ? (
          <p className="text-xs text-slate-600 italic">No additional properties</p>
        ) : (
          entries.map(([k, v]) => (
            <div key={k}>
              <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-600">{k}</p>
              <p className="text-xs text-slate-300 break-words">
                {v === null || v === undefined
                  ? '—'
                  : typeof v === 'object'
                  ? JSON.stringify(v)
                  : String(v)}
              </p>
            </div>
          ))
        )}
      </div>

      {/* Action */}
      <div className="border-t border-slate-800 px-4 py-3">
        <button
          onClick={() => onLoadNeighbors(node.label)}
          disabled={loading}
          className="w-full flex items-center justify-center gap-2 rounded-lg border border-indigo-500/40 bg-indigo-500/10 px-3 py-2 text-xs font-medium text-indigo-300 hover:bg-indigo-500/20 transition-colors disabled:opacity-50"
        >
          {loading ? (
            <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-indigo-400/30 border-t-indigo-400" />
          ) : (
            <Network size={13} />
          )}
          Load Neighbors
        </button>
      </div>
    </div>
  )
}

// ─── Main Component ───────────────────────────────────────────────────────────

export function GraphExplorer({ compilationId, className }: GraphExplorerProps) {
  // Graph data
  const [nodes, setNodes] = useState<GraphNode[]>([])
  const [edges, setEdges] = useState<GraphEdge[]>([])

  // UI state
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null)
  const [neighborLoading, setNeighborLoading] = useState(false)
  const [viewMode, setViewMode] = useState<ViewMode>('2d')

  // Search
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<GraphNode[]>([])
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchLoading, setSearchLoading] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Container dimensions (force-graph needs explicit width/height)
  const containerRef = useRef<HTMLDivElement>(null)
  const [dimensions, setDimensions] = useState({ width: 800, height: 560 })

  // Refs to the underlying ForceGraph instances (for centering on a node etc.)
  const fg2dRef = useRef<unknown>(null)
  const fg3dRef = useRef<unknown>(null)

  // ── Track container size with ResizeObserver ─────────────────────────────

  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    const updateSize = () => {
      const rect = el.getBoundingClientRect()
      // Account for ~41px top toolbar inside the container
      const w = Math.max(300, Math.floor(rect.width))
      const h = Math.max(300, Math.floor(rect.height) - 41)
      setDimensions((prev) =>
        prev.width === w && prev.height === h ? prev : { width: w, height: h }
      )
    }

    updateSize()

    const ro = new ResizeObserver(updateSize)
    ro.observe(el)

    window.addEventListener('resize', updateSize)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', updateSize)
    }
  }, [])

  // ── Load initial graph data ──────────────────────────────────────────────

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)

    apiGet<GraphData>(`/kg/compilations/${compilationId}/graph?limit=200`)
      .then((data) => {
        if (cancelled) return
        setNodes(data.nodes ?? [])
        setEdges(data.edges ?? [])
      })
      .catch((err) => {
        if (cancelled) return
        setError(
          (err as { response?: { data?: { error?: string } } })?.response?.data?.error ??
            'Failed to load graph data'
        )
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [compilationId])

  // ── Merge new nodes/edges into graph ─────────────────────────────────────

  const mergeGraph = useCallback((newNodes: GraphNode[], newEdges: GraphEdge[]) => {
    setNodes((prev) => {
      const existingIds = new Set(prev.map((n) => n.id))
      const added = newNodes.filter((n) => !existingIds.has(n.id))
      if (added.length === 0) return prev
      return [...prev, ...added]
    })
    setEdges((prev) => {
      const existingKeys = new Set(prev.map((e) => `${e.source}:${e.target}:${e.type}`))
      const added = newEdges.filter(
        (e) => !existingKeys.has(`${e.source}:${e.target}:${e.type}`)
      )
      if (added.length === 0) return prev
      return [...prev, ...added]
    })
  }, [])

  // ── Load neighbors ────────────────────────────────────────────────────────

  const handleLoadNeighbors = useCallback(
    async (nodeLabel: string) => {
      setNeighborLoading(true)
      try {
        const data = await apiGet<GraphData>(
          `/kg/graph/entity/${encodeURIComponent(nodeLabel)}/neighbors?depth=1&limit=50`
        )
        mergeGraph(data.nodes ?? [], data.edges ?? [])
      } catch {
        // silent — neighbor load failures are non-critical
      } finally {
        setNeighborLoading(false)
      }
    },
    [mergeGraph]
  )

  // ── Search ────────────────────────────────────────────────────────────────

  useEffect(() => {
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current)
    if (!searchQuery.trim()) {
      setSearchResults([])
      setSearchOpen(false)
      return
    }
    searchDebounceRef.current = setTimeout(async () => {
      setSearchLoading(true)
      try {
        const data = await apiGet<{ nodes: GraphNode[] }>(
          `/kg/graph/search?q=${encodeURIComponent(searchQuery.trim())}&limit=20`
        )
        setSearchResults(data.nodes ?? [])
        setSearchOpen(true)
      } catch {
        setSearchResults([])
      } finally {
        setSearchLoading(false)
      }
    }, 300)

    return () => {
      if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current)
    }
  }, [searchQuery])

  function handleSearchSelect(node: GraphNode) {
    setSearchQuery('')
    setSearchOpen(false)
    setSelectedNode(node)

    // If the node isn't in the local graph yet, pull it + its neighbors in.
    const inGraph = nodes.some((n) => n.id === node.id)
    if (!inGraph) {
      mergeGraph([node], [])
      handleLoadNeighbors(node.label)
      return
    }

    // Try to center the camera on the node. force-graph mutates node objects
    // with x/y(/z) during simulation, so we look up the live ref's data.
    if (viewMode === '2d') {
      const fg = fg2dRef.current as
        | { centerAt?: (x: number, y: number, ms?: number) => void; graphData?: () => FGData }
        | null
      const live = fg?.graphData?.().nodes.find((n) => n.id === node.id)
      if (live && typeof live.x === 'number' && typeof live.y === 'number') {
        fg?.centerAt?.(live.x, live.y, 800)
      }
    } else {
      const fg = fg3dRef.current as
        | {
            cameraPosition?: (
              p: { x: number; y: number; z: number },
              lookAt: { x: number; y: number; z: number },
              ms?: number
            ) => void
            graphData?: () => FGData
          }
        | null
      const live = fg?.graphData?.().nodes.find((n) => n.id === node.id)
      if (
        live &&
        typeof live.x === 'number' &&
        typeof live.y === 'number' &&
        typeof live.z === 'number'
      ) {
        const distance = 120
        const r = Math.hypot(live.x, live.y, live.z) || 1
        fg?.cameraPosition?.(
          {
            x: live.x * (1 + distance / r),
            y: live.y * (1 + distance / r),
            z: live.z * (1 + distance / r),
          },
          { x: live.x, y: live.y, z: live.z },
          800
        )
      }
    }
  }

  // ── Truncate to MAX_DISPLAY_NODES + filter dangling edges ─────────────────

  const truncated = useMemo(() => {
    const limit = MAX_DISPLAY_NODES
    const visibleNodes = nodes.length > limit ? nodes.slice(0, limit) : nodes
    const idSet = new Set(visibleNodes.map((n) => n.id))
    const visibleEdges = edges.filter((e) => idSet.has(e.source) && idSet.has(e.target))
    return { nodes: visibleNodes, edges: visibleEdges, truncated: nodes.length > limit }
  }, [nodes, edges])

  // ── Build force-graph data shape ──────────────────────────────────────────

  const graphData: FGData = useMemo(
    () => ({
      nodes: truncated.nodes.map((n) => ({ ...n })),
      links: truncated.edges.map((e) => ({
        source: e.source,
        target: e.target,
        type: e.type,
      })),
    }),
    [truncated]
  )

  // ── Click handler ────────────────────────────────────────────────────────

  const handleNodeClick = useCallback((n: object) => {
    const node = n as FGNode
    setSelectedNode((prev) =>
      prev?.id === node.id
        ? null
        : { id: node.id, label: node.label, type: node.type, properties: node.properties ?? {} }
    )
  }, [])

  // ── Render ────────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div
        className={cn(
          'flex items-center justify-center rounded-xl bg-slate-900 border border-slate-800',
          className
        )}
        style={{ height: 600 }}
      >
        <div className="flex flex-col items-center gap-3">
          <span className="h-8 w-8 animate-spin rounded-full border-2 border-slate-700 border-t-indigo-500" />
          <p className="text-sm text-slate-500">Loading graph…</p>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div
        className={cn(
          'flex items-center justify-center rounded-xl bg-slate-900 border border-slate-800',
          className
        )}
        style={{ height: 600 }}
      >
        <div className="flex flex-col items-center gap-3 text-center">
          <AlertCircle size={28} className="text-red-400" />
          <p className="text-sm text-slate-400">{error}</p>
        </div>
      </div>
    )
  }

  if (nodes.length === 0) {
    return (
      <div
        className={cn(
          'flex items-center justify-center rounded-xl bg-slate-900 border border-slate-800',
          className
        )}
        style={{ height: 600 }}
      >
        <div className="flex flex-col items-center gap-3 text-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-slate-800">
            <Network size={24} className="text-slate-600" />
          </div>
          <p className="text-sm font-medium text-slate-400">No graph data</p>
          <p className="text-xs text-slate-600">
            This compilation has no graph data yet.
            <br />
            Refresh it to generate the knowledge graph.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div
      ref={containerRef}
      className={cn(
        'relative rounded-xl border border-slate-700/60 bg-slate-950 overflow-hidden',
        className
      )}
      style={{ height: 600 }}
    >
      {/* ── Top bar ── */}
      <div className="absolute left-0 right-0 top-0 z-10 flex items-center gap-2 border-b border-slate-800/80 bg-slate-950/90 backdrop-blur-sm px-3 py-2">
        {/* Search */}
        <div className="relative flex-1 max-w-xs">
          <Search
            size={13}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 pointer-events-none"
          />
          <input
            ref={searchRef}
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onBlur={() => setTimeout(() => setSearchOpen(false), 150)}
            onFocus={() => searchResults.length > 0 && setSearchOpen(true)}
            placeholder="Search entities…"
            className="w-full rounded-lg border border-slate-700 bg-slate-800 pl-8 pr-3 py-1.5 text-xs text-slate-200 placeholder-slate-500 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500/40 transition-colors"
          />
          {searchLoading && (
            <span className="absolute right-2.5 top-1/2 -translate-y-1/2 h-3 w-3 animate-spin rounded-full border border-indigo-400/30 border-t-indigo-400" />
          )}

          {/* Dropdown */}
          {searchOpen && searchResults.length > 0 && (
            <div className="absolute left-0 right-0 top-full mt-1 rounded-lg border border-slate-700 bg-slate-900 shadow-xl overflow-hidden z-20">
              {searchResults.map((node) => (
                <button
                  key={node.id}
                  onMouseDown={() => handleSearchSelect(node)}
                  className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-slate-800 transition-colors"
                >
                  <span
                    className="h-2.5 w-2.5 rounded-full shrink-0"
                    style={{ backgroundColor: nodeColor(node.type) }}
                  />
                  <span className="text-xs text-slate-200 truncate">{node.label}</span>
                  <span className="ml-auto text-[10px] text-slate-600 shrink-0">{node.type}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Stats badge */}
        <span className="ml-auto text-xs text-slate-500 tabular-nums shrink-0">
          {nodes.length.toLocaleString()} nodes · {edges.length.toLocaleString()} edges
        </span>

        {/* 2D / 3D toggle */}
        <div className="flex items-center rounded-md border border-slate-700 bg-slate-900 overflow-hidden">
          <button
            onClick={() => setViewMode('2d')}
            className={cn(
              'flex items-center gap-1 px-2.5 py-1 text-xs font-medium transition-colors',
              viewMode === '2d'
                ? 'bg-indigo-500/15 text-indigo-300'
                : 'text-slate-500 hover:text-slate-300'
            )}
            title="2D view"
          >
            <Square size={11} />
            2D
          </button>
          <button
            onClick={() => setViewMode('3d')}
            className={cn(
              'flex items-center gap-1 px-2.5 py-1 text-xs font-medium border-l border-slate-700 transition-colors',
              viewMode === '3d'
                ? 'bg-indigo-500/15 text-indigo-300'
                : 'text-slate-500 hover:text-slate-300'
            )}
            title="3D view"
          >
            <Box size={11} />
            3D
          </button>
        </div>
      </div>

      {/* ── Truncation banner ── */}
      {truncated.truncated && (
        <div className="absolute left-1/2 top-12 z-10 -translate-x-1/2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-300 shadow-lg backdrop-blur-sm">
          Showing first {MAX_DISPLAY_NODES.toLocaleString()} of{' '}
          {nodes.length.toLocaleString()} nodes — use search to find specific entities
        </div>
      )}

      {/* ── Graph canvas ── */}
      <div
        className="absolute inset-0"
        style={{ marginTop: 41 /* top bar height */ }}
      >
        <Suspense
          fallback={
            <div className="flex h-full items-center justify-center">
              <span className="h-6 w-6 animate-spin rounded-full border-2 border-slate-700 border-t-indigo-500" />
            </div>
          }
        >
          {viewMode === '2d' ? (
            <ForceGraph2D
              ref={fg2dRef as never}
              graphData={graphData}
              width={dimensions.width}
              height={dimensions.height}
              backgroundColor={BG_COLOR}
              nodeLabel="label"
              nodeColor={(n: object) => nodeColor((n as FGNode).type)}
              nodeAutoColorBy="type"
              nodeRelSize={5}
              linkColor={() => '#334155'}
              linkDirectionalArrowLength={4}
              linkDirectionalArrowRelPos={1}
              linkWidth={1}
              onNodeClick={handleNodeClick}
              cooldownTicks={100}
              enableNodeDrag
            />
          ) : (
            <ForceGraph3D
              ref={fg3dRef as never}
              graphData={graphData}
              width={dimensions.width}
              height={dimensions.height}
              backgroundColor={BG_COLOR}
              nodeLabel="label"
              nodeColor={(n: object) => nodeColor((n as FGNode).type)}
              nodeAutoColorBy="type"
              nodeRelSize={5}
              linkColor={() => '#475569'}
              linkOpacity={0.6}
              linkDirectionalArrowLength={3}
              linkDirectionalArrowRelPos={1}
              linkWidth={0.5}
              onNodeClick={handleNodeClick}
              enableNodeDrag
              showNavInfo={false}
            />
          )}
        </Suspense>
      </div>

      {/* ── Type legend (bottom left) ── */}
      <div className="absolute bottom-3 left-3 flex flex-wrap gap-2 z-10 rounded-md bg-slate-950/70 px-2 py-1.5 backdrop-blur-sm">
        {Object.entries(TYPE_COLORS).map(([type, color]) => (
          <div key={type} className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full" style={{ backgroundColor: color }} />
            <span className="text-[10px] text-slate-400">{type}</span>
          </div>
        ))}
      </div>

      {/* ── Node side panel ── */}
      {selectedNode && (
        <NodePanel
          node={selectedNode}
          onClose={() => setSelectedNode(null)}
          onLoadNeighbors={handleLoadNeighbors}
          loading={neighborLoading}
        />
      )}
    </div>
  )
}
