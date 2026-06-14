/**
 * GraphExplorer — Visual 2D/3D Knowledge-Graph viewer.
 *
 * Thin container. Heavy lifting lives in `./graph-explorer/`:
 *   - hooks (data fetch, metrics, focus mode)
 *   - colors (palette resolution + alpha fading)
 *   - SearchBar / ControlsPanel / Legend
 *   - NodeDetailDrawer + tab components (Obsidian-style read-only viewer)
 *
 * Bug fixes baked into this container:
 *   - Drops `style={{ height: 600 }}` and `overflow-hidden` from previous version;
 *     uses Tailwind `h-[calc(100vh-220px)] min-h-[520px]` so the canvas fills
 *     the available viewport and the slide-over drawer is never clipped.
 *   - Drops `nodeAutoColorBy="type"` on both ForceGraph2D/3D — it overrode the
 *     `nodeColor` callback and broke color coding.
 *   - Node fade + size are driven by hover/click focus and node degree.
 */

import {
  useState,
  useRef,
  useCallback,
  useMemo,
  useEffect,
  Suspense,
  lazy,
} from 'react'
import { cn } from '@/lib/utils'
import { SearchBar } from './graph-explorer/SearchBar'
import { ControlsPanel } from './graph-explorer/ControlsPanel'
import { Legend } from './graph-explorer/Legend'
import { NodeDetailDrawer } from './graph-explorer/NodeDetailDrawer'
import {
  useGraphData,
  useGraphMetrics,
  useFocusMode,
} from './graph-explorer/hooks'
import {
  getNodeColor,
  resolveTypeLabel,
  withAlpha,
} from './graph-explorer/colors'
import type {
  ColorBy,
  GraphEdge,
  GraphNode,
  SizeBy,
  ViewMode,
} from './graph-explorer/types'

// ─── Lazy-loaded canvas (3D chunk only when needed) ───────────────────────────

const ForceGraph2D = lazy(() =>
  import('react-force-graph-2d').then((m) => ({ default: m.default })),
)
const ForceGraph3D = lazy(() =>
  import('react-force-graph-3d').then((m) => ({ default: m.default })),
)

// Render every node up to a perf ceiling (the force sim, not drawing, is the
// cost); the viewport bounds visible density via the zoom clamp below, so the
// user pans to reach the rest rather than seeing a hard "first 500" truncation.
const MAX_DISPLAY_NODES = 4000
const MIN_ZOOM = 0.35
const MAX_ZOOM = 8
const LINK_COLOR_BASE = '#475569'
const LINK_OPACITY_FOCUS = 0.5
const LINK_OPACITY_FADE = 0.08
const NODE_OPACITY_FADE = 0.15

interface CanvasRef {
  zoomToFit?: (ms?: number, padding?: number) => void
  cameraPosition?: (
    pos: { x?: number; y?: number; z?: number },
    lookAt?: { x: number; y: number; z: number },
    transitionMs?: number,
  ) => void
  centerAt?: (x?: number, y?: number, ms?: number) => void
  zoom?: (n: number, ms?: number) => void
  d3ReheatSimulation?: () => void
}

export interface GraphExplorerProps {
  compilationId: string
  className?: string
}

interface Dimensions {
  width: number
  height: number
}

// ─── Component ────────────────────────────────────────────────────────────────

export function GraphExplorer({ compilationId, className }: GraphExplorerProps) {
  // ── data
  const { nodes, edges, isLoading, error, mergeNeighbors } =
    useGraphData(compilationId)

  // ── view + UI state
  const [viewMode, setViewMode] = useState<ViewMode>('2d')
  const [selectedEntityName, setSelectedEntityName] = useState<string | null>(
    null,
  )
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const [clickFocusId, setClickFocusId] = useState<string | null>(null)
  const [colorBy, setColorBy] = useState<ColorBy>('type')
  const [sizeBy, setSizeBy] = useState<SizeBy>('degree')
  const [showLabels, setShowLabels] = useState(false)
  const [typeFilter, setTypeFilter] = useState<Set<string>>(new Set())

  // ── refs
  const containerRef = useRef<HTMLDivElement | null>(null)
  const fg2dRef = useRef<CanvasRef | null>(null)
  const fg3dRef = useRef<CanvasRef | null>(null)

  // ── responsive sizing
  const [dimensions, setDimensions] = useState<Dimensions>({
    width: 800,
    height: 560,
  })
  useEffect(() => {
    if (!containerRef.current) return
    const el = containerRef.current
    const apply = () => {
      const rect = el.getBoundingClientRect()
      setDimensions({
        width: Math.max(200, Math.floor(rect.width)),
        height: Math.max(300, Math.floor(rect.height)),
      })
    }
    apply()
    const ro = new ResizeObserver(apply)
    ro.observe(el)
    const onWin = () => apply()
    window.addEventListener('resize', onWin)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', onWin)
    }
  }, [])

  // ── filter nodes by selected types (empty filter = show all)
  const filteredNodes = useMemo<GraphNode[]>(() => {
    if (typeFilter.size === 0) return nodes
    return nodes.filter((n) => typeFilter.has(resolveTypeLabel(n)))
  }, [nodes, typeFilter])

  // truncate for perf — keep the highest-degree nodes
  const allowedIds = useMemo(
    () => new Set(filteredNodes.map((n) => n.id)),
    [filteredNodes],
  )
  const filteredEdges = useMemo<GraphEdge[]>(
    () =>
      edges.filter(
        (e) => allowedIds.has(e.source) && allowedIds.has(e.target),
      ),
    [edges, allowedIds],
  )
  const metrics = useGraphMetrics(filteredNodes, filteredEdges)

  const displayedNodes = useMemo<GraphNode[]>(() => {
    if (filteredNodes.length <= MAX_DISPLAY_NODES) return filteredNodes
    return [...filteredNodes]
      .sort(
        (a, b) =>
          (metrics.getDegree(b.id) ?? 0) - (metrics.getDegree(a.id) ?? 0),
      )
      .slice(0, MAX_DISPLAY_NODES)
  }, [filteredNodes, metrics])
  const displayedIds = useMemo(
    () => new Set(displayedNodes.map((n) => n.id)),
    [displayedNodes],
  )
  const displayedEdges = useMemo<GraphEdge[]>(
    () =>
      filteredEdges.filter(
        (e) => displayedIds.has(e.source) && displayedIds.has(e.target),
      ),
    [filteredEdges, displayedIds],
  )
  const truncated = filteredNodes.length > MAX_DISPLAY_NODES

  // ── focus mode (hover wins; otherwise sticky click focus)
  const focusId = hoveredId ?? clickFocusId
  const focus = useFocusMode(displayedEdges, focusId)

  // ── Animated focus fade ───────────────────────────────────────────────
  // Each node has an animated "focusedness" in [NODE_OPACITY_FADE..1] that eases
  // toward its target (1 if in the focused set, faded otherwise) instead of
  // snapping. A short rAF loop lerps the values and bumps `animTick`, whose new
  // identity makes the ForceGraph re-read the colour accessors each frame — so
  // both 2D and 3D fade smoothly rather than flickering.
  const focusAlphaRef = useRef<Map<string, number>>(new Map())
  const [animTick, setAnimTick] = useState(0)
  const animRafRef = useRef<number | null>(null)
  // Latest focus + node set for the rAF closure (avoids stale captures).
  const focusRef = useRef(focus)
  focusRef.current = focus
  const focusNodesRef = useRef(displayedNodes)
  focusNodesRef.current = displayedNodes

  useEffect(() => {
    const step = () => {
      const m = focusAlphaRef.current
      const f = focusRef.current
      let moving = false
      for (const n of focusNodesRef.current) {
        const target = f.isFaded(n) ? NODE_OPACITY_FADE : 1
        const cur = m.get(n.id)
        if (cur === undefined) {
          m.set(n.id, target)
          continue
        }
        const next = cur + (target - cur) * 0.18
        if (Math.abs(target - next) > 0.012) {
          m.set(n.id, next)
          moving = true
        } else {
          m.set(n.id, target)
        }
      }
      setAnimTick((t) => (t + 1) & 0xffff)
      animRafRef.current = moving ? requestAnimationFrame(step) : null
    }
    if (animRafRef.current) cancelAnimationFrame(animRafRef.current)
    animRafRef.current = requestAnimationFrame(step)
    return () => {
      if (animRafRef.current) cancelAnimationFrame(animRafRef.current)
    }
  }, [focusId])

  const nodeFocusAlpha = useCallback(
    (id: string) => focusAlphaRef.current.get(id) ?? 1,
    [],
  )

  const computeNodeColor = useCallback(
    (n: GraphNode) => withAlpha(getNodeColor(n, colorBy), nodeFocusAlpha(n.id)),
    // animTick intentionally in deps: a fresh identity each frame makes the
    // ForceGraph re-evaluate node colours so the fade animates.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [colorBy, nodeFocusAlpha, animTick],
  )
  const computeLinkColor = useCallback(
    (e: GraphEdge) => {
      const sId = typeof e.source === 'string' ? e.source : (e.source as { id: string }).id
      const tId = typeof e.target === 'string' ? e.target : (e.target as { id: string }).id
      // A link is as visible as its least-focused endpoint.
      const f = Math.min(nodeFocusAlpha(sId), nodeFocusAlpha(tId))
      const t = (f - NODE_OPACITY_FADE) / (1 - NODE_OPACITY_FADE) // 0..1
      const op = LINK_OPACITY_FADE + (LINK_OPACITY_FOCUS - LINK_OPACITY_FADE) * t
      return withAlpha(LINK_COLOR_BASE, op)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [nodeFocusAlpha, animTick],
  )

  const computeNodeVal = useCallback(
    (n: GraphNode) =>
      sizeBy === 'degree' ? Math.pow(metrics.getRadius(n), 2) : 36,
    [sizeBy, metrics],
  )

  // ── handlers
  const handleNodeHover = useCallback((node: { id: string } | null) => {
    setHoveredId(node ? node.id : null)
  }, [])
  const handleNodeClick = useCallback((node: GraphNode) => {
    const name =
      node.label || (node.properties?.name as string | undefined) || ''
    if (!name) return
    setSelectedEntityName(name)
    setClickFocusId(node.id)
  }, [])
  const handleBackgroundClick = useCallback(() => {
    setClickFocusId(null)
  }, [])

  const handleSearchSelect = useCallback((n: GraphNode) => {
    const name =
      n.label || (n.properties?.name as string | undefined) || ''
    if (!name) return
    setSelectedEntityName(name)
    setClickFocusId(n.id)
  }, [])

  const handleFit = useCallback(() => {
    if (viewMode === '2d') {
      fg2dRef.current?.zoomToFit?.(400, 40)
    } else {
      fg3dRef.current?.zoomToFit?.(600, 60)
    }
  }, [viewMode])

  const handleReset = useCallback(() => {
    setTypeFilter(new Set())
    setSelectedEntityName(null)
    setClickFocusId(null)
    setHoveredId(null)
    handleFit()
  }, [handleFit])

  const handleTypeFilterToggle = useCallback((t: string) => {
    setTypeFilter((prev) => {
      const next = new Set(prev)
      if (next.has(t)) next.delete(t)
      else next.add(t)
      return next
    })
  }, [])

  const handleNavigateToEntity = useCallback(
    async (entityName: string) => {
      setSelectedEntityName(entityName)
      await mergeNeighbors(entityName)
    },
    [mergeNeighbors],
  )

  const handleLoadMoreNeighbors = useCallback(async () => {
    if (selectedEntityName) await mergeNeighbors(selectedEntityName)
  }, [mergeNeighbors, selectedEntityName])

  // close drawer on Esc
  useEffect(() => {
    if (!selectedEntityName) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSelectedEntityName(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selectedEntityName])

  // ── prepare data for the canvas (links require source/target ids)
  const graphData = useMemo(
    () => ({
      nodes: displayedNodes,
      links: displayedEdges.map((e) => ({
        source: e.source,
        target: e.target,
        type: e.type,
      })),
    }),
    [displayedNodes, displayedEdges],
  )

  // ── render
  return (
    <div
      ref={containerRef}
      className={cn(
        'relative rounded-xl border border-slate-700/60 bg-slate-950',
        'h-[calc(100vh-220px)] min-h-[520px]',
        className,
      )}
    >
      {isLoading && (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-slate-950/40 backdrop-blur-sm">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-slate-700 border-t-blue-500" />
        </div>
      )}
      {error && (
        <div className="absolute inset-0 z-30 flex items-center justify-center text-sm text-red-400">
          Failed to load graph: {error.message}
        </div>
      )}

      <SearchBar
        colorBy={colorBy}
        onSelect={handleSearchSelect}
        className="absolute left-3 top-3 z-20 w-72"
      />

      <ControlsPanel
        viewMode={viewMode}
        onViewModeChange={setViewMode}
        colorBy={colorBy}
        onColorByChange={setColorBy}
        sizeBy={sizeBy}
        onSizeByChange={setSizeBy}
        showLabels={showLabels}
        onShowLabelsChange={setShowLabels}
        presentTypes={metrics.presentTypes}
        typeFilter={typeFilter}
        onTypeFilterToggle={handleTypeFilterToggle}
        onTypeFilterReset={() => setTypeFilter(new Set())}
        onFit={handleFit}
        onReset={handleReset}
        nodeCount={displayedNodes.length}
        edgeCount={displayedEdges.length}
      />

      {truncated && (
        <div className="absolute right-3 top-32 z-10 max-w-[20rem] rounded-md border border-amber-700/40 bg-amber-900/30 px-3 py-2 text-[11px] leading-snug text-amber-200">
          Showing first {MAX_DISPLAY_NODES} of {filteredNodes.length} nodes (by
          degree). Use search or filter to find specific entities.
        </div>
      )}

      <Suspense
        fallback={
          <div className="absolute inset-0 flex items-center justify-center text-xs text-slate-500">
            Loading {viewMode.toUpperCase()} renderer…
          </div>
        }
      >
        {viewMode === '2d' ? (
          <ForceGraph2D
            ref={fg2dRef as never}
            graphData={graphData}
            width={dimensions.width}
            height={dimensions.height}
            backgroundColor="#020617"
            nodeRelSize={4}
            nodeVal={computeNodeVal as never}
            nodeColor={computeNodeColor as never}
            nodeLabel={(n: object) => resolveTypeLabel(n as GraphNode)}
            linkColor={computeLinkColor as never}
            linkWidth={0.8}
            minZoom={MIN_ZOOM}
            maxZoom={MAX_ZOOM}
            linkDirectionalArrowLength={3}
            linkDirectionalArrowRelPos={0.95}
            onNodeHover={handleNodeHover as never}
            onNodeClick={handleNodeClick as never}
            onBackgroundClick={handleBackgroundClick}
            cooldownTicks={120}
            nodeCanvasObjectMode={() => (showLabels ? 'after' : undefined)}
            nodeCanvasObject={
              showLabels
                ? ((node: object, ctx: CanvasRenderingContext2D) => {
                    const n = node as GraphNode & { x?: number; y?: number }
                    if (n.x == null || n.y == null) return
                    const label = n.label || resolveTypeLabel(n)
                    if (!label) return
                    const fontSize = 4
                    ctx.font = `${fontSize}px sans-serif`
                    // Animated label opacity tracks the node's focus fade.
                    const a = nodeFocusAlpha(n.id)
                    const t = (a - NODE_OPACITY_FADE) / (1 - NODE_OPACITY_FADE)
                    ctx.fillStyle = `rgba(214, 222, 236, ${(0.25 + 0.7 * t).toFixed(3)})`
                    ctx.textAlign = 'center'
                    ctx.textBaseline = 'top'
                    ctx.fillText(label, n.x, n.y + 6)
                  }) as never
                : undefined
            }
          />
        ) : (
          <ForceGraph3D
            ref={fg3dRef as never}
            graphData={graphData}
            width={dimensions.width}
            height={dimensions.height}
            backgroundColor="#020617"
            nodeRelSize={4}
            nodeVal={computeNodeVal as never}
            nodeColor={computeNodeColor as never}
            nodeLabel={(n: object) => resolveTypeLabel(n as GraphNode)}
            linkColor={computeLinkColor as never}
            linkOpacity={0.5}
            linkDirectionalArrowLength={3}
            linkDirectionalArrowRelPos={0.95}
            onNodeHover={handleNodeHover as never}
            onNodeClick={handleNodeClick as never}
            onBackgroundClick={handleBackgroundClick}
            cooldownTicks={120}
          />
        )}
      </Suspense>

      <Legend presentTypes={metrics.presentTypes} colorBy={colorBy} />

      <NodeDetailDrawer
        compilationId={compilationId}
        entityName={selectedEntityName ?? ''}
        open={!!selectedEntityName}
        onClose={() => {
          setSelectedEntityName(null)
          setClickFocusId(null)
        }}
        onNavigateToEntity={handleNavigateToEntity}
        onLoadMoreNeighbors={handleLoadMoreNeighbors}
        nodes={nodes}
        edges={edges}
        colorBy={colorBy}
      />
    </div>
  )
}
