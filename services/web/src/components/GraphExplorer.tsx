import {
  useState,
  useEffect,
  useRef,
  useCallback,
  type MouseEvent,
} from 'react'
import { Search, X, ZoomIn, ZoomOut, Maximize2, AlertCircle, Network } from 'lucide-react'
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

interface NodePosition {
  x: number
  y: number
}

export interface GraphExplorerProps {
  compilationId: string
  className?: string
}

// ─── Constants ────────────────────────────────────────────────────────────────

const CANVAS_W = 800
const CANVAS_H = 600
const NODE_R = 20

const TYPE_COLORS: Record<string, string> = {
  Person: '#6366f1',
  Organization: '#f59e0b',
  Location: '#10b981',
  Event: '#ec4899',
  Product: '#3b82f6',
  Concept: '#8b5cf6',
}
const DEFAULT_COLOR = '#64748b'

function nodeColor(type: string): string {
  return TYPE_COLORS[type] ?? DEFAULT_COLOR
}

function truncate(s: string, n = 15): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s
}

// ─── Force-directed layout ────────────────────────────────────────────────────

function buildInitialPositions(nodes: GraphNode[]): Map<string, NodePosition> {
  const map = new Map<string, NodePosition>()
  const count = nodes.length
  if (count === 0) return map

  if (count === 1) {
    map.set(nodes[0].id, { x: CANVAS_W / 2, y: CANVAS_H / 2 })
    return map
  }

  // Place in a circle initially
  nodes.forEach((node, i) => {
    const angle = (2 * Math.PI * i) / count - Math.PI / 2
    const radius = Math.min(CANVAS_W, CANVAS_H) * 0.35
    map.set(node.id, {
      x: CANVAS_W / 2 + radius * Math.cos(angle),
      y: CANVAS_H / 2 + radius * Math.sin(angle),
    })
  })

  return map
}

function runForceSimulation(
  nodes: GraphNode[],
  edges: GraphEdge[],
  initialPositions: Map<string, NodePosition>
): Map<string, NodePosition> {
  if (nodes.length === 0) return initialPositions

  // Copy positions
  const pos = new Map<string, NodePosition>()
  nodes.forEach((n) => {
    const p = initialPositions.get(n.id) ?? { x: CANVAS_W / 2, y: CANVAS_H / 2 }
    pos.set(n.id, { ...p })
  })

  const ITERATIONS = 120
  const REPULSION = 4000
  const SPRING_LENGTH = 120
  const SPRING_K = 0.05
  const DAMPING = 0.85
  const PADDING = NODE_R + 10

  // Build adjacency set for quick lookup
  const connected = new Set<string>()
  edges.forEach((e) => {
    connected.add(`${e.source}:${e.target}`)
    connected.add(`${e.target}:${e.source}`)
  })

  const vel = new Map<string, NodePosition>()
  nodes.forEach((n) => vel.set(n.id, { x: 0, y: 0 }))

  for (let iter = 0; iter < ITERATIONS; iter++) {
    const force = new Map<string, NodePosition>()
    nodes.forEach((n) => force.set(n.id, { x: 0, y: 0 }))

    // Repulsion between all pairs
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const ni = nodes[i], nj = nodes[j]
        const pi = pos.get(ni.id)!
        const pj = pos.get(nj.id)!
        const dx = pi.x - pj.x
        const dy = pi.y - pj.y
        const dist = Math.max(Math.sqrt(dx * dx + dy * dy), 1)
        const repForce = REPULSION / (dist * dist)
        const fx = (dx / dist) * repForce
        const fy = (dy / dist) * repForce
        const fi = force.get(ni.id)!
        const fj = force.get(nj.id)!
        fi.x += fx; fi.y += fy
        fj.x -= fx; fj.y -= fy
      }
    }

    // Spring attraction on edges
    edges.forEach((e) => {
      const ps = pos.get(e.source)
      const pt = pos.get(e.target)
      if (!ps || !pt) return
      const dx = pt.x - ps.x
      const dy = pt.y - ps.y
      const dist = Math.max(Math.sqrt(dx * dx + dy * dy), 1)
      const stretch = dist - SPRING_LENGTH
      const fx = (dx / dist) * stretch * SPRING_K
      const fy = (dy / dist) * stretch * SPRING_K
      const fs = force.get(e.source)!
      const ft = force.get(e.target)!
      fs.x += fx; fs.y += fy
      ft.x -= fx; ft.y -= fy
    })

    // Center gravity (weak pull toward center)
    nodes.forEach((n) => {
      const p = pos.get(n.id)!
      const f = force.get(n.id)!
      f.x += (CANVAS_W / 2 - p.x) * 0.005
      f.y += (CANVAS_H / 2 - p.y) * 0.005
    })

    // Update velocities + positions
    nodes.forEach((n) => {
      const v = vel.get(n.id)!
      const f = force.get(n.id)!
      v.x = (v.x + f.x) * DAMPING
      v.y = (v.y + f.y) * DAMPING
      const p = pos.get(n.id)!
      p.x = Math.max(PADDING, Math.min(CANVAS_W - PADDING, p.x + v.x))
      p.y = Math.max(PADDING, Math.min(CANVAS_H - PADDING, p.y + v.y))
    })
  }

  return pos
}

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
    <div className="absolute right-0 top-0 h-full w-72 rounded-r-xl border-l border-slate-700/60 bg-slate-900/95 backdrop-blur-sm flex flex-col">
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
  const [positions, setPositions] = useState<Map<string, NodePosition>>(new Map())

  // UI state
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null)
  const [neighborLoading, setNeighborLoading] = useState(false)
  const [highlightedId, setHighlightedId] = useState<string | null>(null)

  // Search
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<GraphNode[]>([])
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchLoading, setSearchLoading] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Pan + zoom state
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState<NodePosition>({ x: 0, y: 0 })
  const isPanning = useRef(false)
  const panStart = useRef<{ mx: number; my: number; px: number; py: number }>({
    mx: 0, my: 0, px: 0, py: 0
  })
  const svgRef = useRef<SVGSVGElement>(null)

  // ── Non-passive wheel listener for zoom (React 17+ makes onWheel passive) ─

  useEffect(() => {
    const el = svgRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      setZoom((z) => Math.max(0.5, Math.min(3, z - e.deltaY * 0.001)))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  // ── Load initial graph data ──────────────────────────────────────────────

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)

    apiGet<GraphData>(`/kg/compilations/${compilationId}/graph?limit=200`)
      .then((data) => {
        if (cancelled) return
        const newNodes = data.nodes ?? []
        const newEdges = data.edges ?? []
        setNodes(newNodes)
        setEdges(newEdges)
        const initial = buildInitialPositions(newNodes)
        const settled = runForceSimulation(newNodes, newEdges, initial)
        setPositions(settled)
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

    return () => { cancelled = true }
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
      const existingKeys = new Set(prev.map((e) => `${e.source}:${e.target}`))
      const added = newEdges.filter((e) => !existingKeys.has(`${e.source}:${e.target}`))
      if (added.length === 0) return prev
      return [...prev, ...added]
    })
  }, [])

  // Re-run layout when nodes change (after neighbor load)
  const prevNodeCount = useRef(0)
  useEffect(() => {
    if (nodes.length > 0 && nodes.length !== prevNodeCount.current) {
      prevNodeCount.current = nodes.length
      setPositions((prev) => {
        // Keep existing positions, place new nodes near center
        const extended = new Map(prev)
        nodes.forEach((n) => {
          if (!extended.has(n.id)) {
            const angle = Math.random() * 2 * Math.PI
            const r = 80 + Math.random() * 60
            extended.set(n.id, {
              x: CANVAS_W / 2 + r * Math.cos(angle),
              y: CANVAS_H / 2 + r * Math.sin(angle),
            })
          }
        })
        return runForceSimulation(nodes, edges, extended)
      })
    }
  }, [nodes, edges])

  // ── Load neighbors ────────────────────────────────────────────────────────

  const handleLoadNeighbors = useCallback(async (nodeLabel: string) => {
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
  }, [mergeGraph])

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
    setHighlightedId(node.id)
    setSelectedNode(node)

    // If node is already in graph, pan to center on it
    const pos = positions.get(node.id)
    if (pos) {
      setPan({ x: CANVAS_W / 2 - pos.x * zoom, y: CANVAS_H / 2 - pos.y * zoom })
    } else {
      // Node not in graph — load neighbors to bring it in
      mergeGraph([node], [])
      handleLoadNeighbors(node.label)
    }
  }

  // ── Pan + Zoom ────────────────────────────────────────────────────────────

  function handleMouseDown(e: MouseEvent<SVGSVGElement>) {
    // Only pan on direct svg background click (not node)
    if ((e.target as Element).tagName === 'svg' || (e.target as Element).tagName === 'rect') {
      isPanning.current = true
      panStart.current = { mx: e.clientX, my: e.clientY, px: pan.x, py: pan.y }
    }
  }

  function handleMouseMove(e: MouseEvent<SVGSVGElement>) {
    if (!isPanning.current) return
    setPan({
      x: panStart.current.px + (e.clientX - panStart.current.mx),
      y: panStart.current.py + (e.clientY - panStart.current.my),
    })
  }

  function handleMouseUp() {
    isPanning.current = false
  }

  function handleReset() {
    setZoom(1)
    setPan({ x: 0, y: 0 })
  }

  // ── Node click ────────────────────────────────────────────────────────────

  function handleNodeClick(node: GraphNode, e: MouseEvent) {
    e.stopPropagation()
    setSelectedNode((prev) => (prev?.id === node.id ? null : node))
    setHighlightedId((prev) => (prev === node.id ? null : node.id))
  }

  function handleSvgClick() {
    setSelectedNode(null)
    setHighlightedId(null)
  }

  // ── Derived view transform ────────────────────────────────────────────────

  // We'll apply zoom + pan as a SVG group transform instead of viewBox manipulation
  // This gives cleaner behavior with fixed-size SVG container
  const transform = `translate(${pan.x}, ${pan.y}) scale(${zoom})`

  // ── Render ────────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className={cn('flex items-center justify-center rounded-xl bg-slate-900 border border-slate-800', className)} style={{ height: 480 }}>
        <div className="flex flex-col items-center gap-3">
          <span className="h-8 w-8 animate-spin rounded-full border-2 border-slate-700 border-t-indigo-500" />
          <p className="text-sm text-slate-500">Loading graph…</p>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className={cn('flex items-center justify-center rounded-xl bg-slate-900 border border-slate-800', className)} style={{ height: 480 }}>
        <div className="flex flex-col items-center gap-3 text-center">
          <AlertCircle size={28} className="text-red-400" />
          <p className="text-sm text-slate-400">{error}</p>
        </div>
      </div>
    )
  }

  if (nodes.length === 0) {
    return (
      <div className={cn('flex items-center justify-center rounded-xl bg-slate-900 border border-slate-800', className)} style={{ height: 480 }}>
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
    <div className={cn('relative rounded-xl border border-slate-700/60 bg-slate-950 overflow-hidden', className)}>
      {/* ── Top bar ── */}
      <div className="absolute left-0 right-0 top-0 z-10 flex items-center gap-2 border-b border-slate-800/80 bg-slate-950/90 backdrop-blur-sm px-3 py-2">
        {/* Search */}
        <div className="relative flex-1 max-w-xs">
          <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 pointer-events-none" />
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

        {/* Zoom controls */}
        <div className="flex items-center gap-1">
          <button
            onClick={() => setZoom((z) => Math.min(3, +(z + 0.2).toFixed(1)))}
            className="flex h-7 w-7 items-center justify-center rounded-md border border-slate-700 bg-slate-800 text-slate-400 hover:text-slate-200 hover:bg-slate-700 transition-colors"
            title="Zoom in"
          >
            <ZoomIn size={13} />
          </button>
          <button
            onClick={() => setZoom((z) => Math.max(0.5, +(z - 0.2).toFixed(1)))}
            className="flex h-7 w-7 items-center justify-center rounded-md border border-slate-700 bg-slate-800 text-slate-400 hover:text-slate-200 hover:bg-slate-700 transition-colors"
            title="Zoom out"
          >
            <ZoomOut size={13} />
          </button>
          <button
            onClick={handleReset}
            className="flex h-7 w-7 items-center justify-center rounded-md border border-slate-700 bg-slate-800 text-slate-400 hover:text-slate-200 hover:bg-slate-700 transition-colors"
            title="Reset view"
          >
            <Maximize2 size={12} />
          </button>
        </div>
      </div>

      {/* ── SVG canvas ── */}
      <svg
        ref={svgRef}
        viewBox={`0 0 ${CANVAS_W} ${CANVAS_H}`}
        className="w-full cursor-grab select-none"
        style={{ height: 520, marginTop: 41 /* top bar height */ }}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onClick={handleSvgClick}
      >
        {/* Arrow marker definition */}
        <defs>
          <marker
            id="arrowhead"
            markerWidth="8"
            markerHeight="8"
            refX="7"
            refY="3"
            orient="auto"
          >
            <path d="M0,0 L0,6 L8,3 z" fill="#475569" />
          </marker>
          <marker
            id="arrowhead-highlight"
            markerWidth="8"
            markerHeight="8"
            refX="7"
            refY="3"
            orient="auto"
          >
            <path d="M0,0 L0,6 L8,3 z" fill="#6366f1" />
          </marker>
        </defs>

        {/* Background hit area for pan */}
        <rect x={0} y={0} width={CANVAS_W} height={CANVAS_H} fill="transparent" />

        {/* Main group with pan+zoom transform */}
        <g transform={transform}>
          {/* ── Edges ── */}
          {edges.map((edge) => {
            const src = positions.get(edge.source)
            const tgt = positions.get(edge.target)
            if (!src || !tgt) return null
            const isHighlighted =
              highlightedId === edge.source || highlightedId === edge.target

            // Shorten line so arrow doesn't overlap node circle
            const dx = tgt.x - src.x
            const dy = tgt.y - src.y
            const len = Math.sqrt(dx * dx + dy * dy)
            if (len < 1) return null
            const ux = dx / len
            const uy = dy / len
            const x1 = src.x + ux * NODE_R
            const y1 = src.y + uy * NODE_R
            const x2 = tgt.x - ux * (NODE_R + 6)
            const y2 = tgt.y - uy * (NODE_R + 6)

            return (
              <g key={`${edge.source}:${edge.target}:${edge.type}`}>
                <line
                  x1={x1} y1={y1} x2={x2} y2={y2}
                  stroke={isHighlighted ? '#6366f1' : '#334155'}
                  strokeWidth={isHighlighted ? 1.5 : 1}
                  strokeOpacity={isHighlighted ? 0.9 : 0.6}
                  markerEnd={isHighlighted ? 'url(#arrowhead-highlight)' : 'url(#arrowhead)'}
                />
              </g>
            )
          })}

          {/* ── Nodes ── */}
          {nodes.map((node) => {
            const pos = positions.get(node.id)
            if (!pos) return null
            const color = nodeColor(node.type)
            const isSelected = selectedNode?.id === node.id
            const isHighlighted = highlightedId === node.id
            const isDimmed = highlightedId !== null && !isHighlighted && !isSelected

            return (
              <g
                key={node.id}
                transform={`translate(${pos.x}, ${pos.y})`}
                onClick={(e) => handleNodeClick(node, e)}
                className="cursor-pointer"
                style={{ opacity: isDimmed ? 0.35 : 1 }}
              >
                {/* Selection ring */}
                {(isSelected || isHighlighted) && (
                  <circle
                    r={NODE_R + 5}
                    fill="none"
                    stroke={color}
                    strokeWidth={1.5}
                    strokeOpacity={0.5}
                  />
                )}

                {/* Main circle */}
                <circle
                  r={NODE_R}
                  fill={`${color}33`}
                  stroke={color}
                  strokeWidth={isSelected ? 2.5 : 1.5}
                />

                {/* Type initial letter */}
                <text
                  textAnchor="middle"
                  dominantBaseline="central"
                  fontSize={11}
                  fontWeight={600}
                  fill={color}
                  style={{ userSelect: 'none', pointerEvents: 'none' }}
                >
                  {(node.type?.[0] ?? '?').toUpperCase()}
                </text>

                {/* Label below */}
                <text
                  y={NODE_R + 12}
                  textAnchor="middle"
                  dominantBaseline="auto"
                  fontSize={9}
                  fill="#94a3b8"
                  style={{ userSelect: 'none', pointerEvents: 'none' }}
                >
                  {truncate(node.label)}
                </text>
              </g>
            )
          })}
        </g>
      </svg>

      {/* ── Type legend (bottom left) ── */}
      <div className="absolute bottom-3 left-3 flex flex-wrap gap-2 z-10">
        {Object.entries(TYPE_COLORS).map(([type, color]) => (
          <div key={type} className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full" style={{ backgroundColor: color }} />
            <span className="text-[10px] text-slate-500">{type}</span>
          </div>
        ))}
      </div>

      {/* ── Node side panel ── */}
      {selectedNode && (
        <NodePanel
          node={selectedNode}
          onClose={() => { setSelectedNode(null); setHighlightedId(null) }}
          onLoadNeighbors={handleLoadNeighbors}
          loading={neighborLoading}
        />
      )}
    </div>
  )
}
