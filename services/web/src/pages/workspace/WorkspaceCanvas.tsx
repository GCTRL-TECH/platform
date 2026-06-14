/**
 * WorkspaceCanvas — a robust, self-contained force-graph canvas for the Graph
 * Workspace (Phase 3). Deliberately independent of the older embedded
 * GraphExplorer so a render fault in the canvas can never blank the workspace:
 *
 *   - the ForceGraph is mounted ONLY once the container has measured non-zero
 *     dimensions (react-force-graph blanks/throws on a 0×0 canvas),
 *   - it is wrapped in a class ErrorBoundary that surfaces the real error
 *     instead of leaving a frozen blue canvas, and
 *   - node/edge data is guarded so links never reference missing nodes.
 */

import {
  Component,
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { AlertCircle, Box, Square, Tag, Gauge, Orbit } from 'lucide-react'
import SpriteText from 'three-spritetext'
import { cn } from '@/lib/utils'
import { getNodeColor, resolveTypeLabel, withAlpha } from '@/components/graph-explorer/colors'
import type { GraphEdge, GraphNode, ViewMode } from '@/components/graph-explorer/types'

// ── Label rendering tuning (2D) ───────────────────────────────────────────────
// Node labels fade in between these zoom levels; below MIN nothing is drawn (the
// main perf win — no per-node text when zoomed out). Edge labels only when really
// close. Per-frame cap + FPS guard keep large graphs fluid.
const LABEL_ZOOM_MIN = 0.9
const LABEL_ZOOM_FULL = 1.8
const EDGE_LABEL_ZOOM = 4
const MAX_LABELS_PER_FRAME = 200
const FPS_FLOOR = 12 // below this (smoothed) → drop labels
const FPS_RECOVER = 22 // above this → restore labels

// ── Label tuning (3D) ─────────────────────────────────────────────────────────
// 3D labels are SpriteText objects whose opacity fades by distance from the
// camera. Node labels are visible while moderately close; edge labels use a
// tighter gate so relationship names appear only when the camera is right on top
// of them. A per-frame visible cap bounds draw cost on dense graphs.
const LABEL_DIST_NEAR_3D = 120
const LABEL_DIST_FAR_3D = 420
const EDGE_LABEL_DIST_NEAR_3D = 60
const EDGE_LABEL_DIST_FAR_3D = 200
const MAX_SPRITES_VISIBLE_3D = 200
const ORBIT_SPEED = 0.0015 // radians per frame

function smoothstep(x: number, a: number, b: number): number {
  if (x <= a) return 0
  if (x >= b) return 1
  const t = (x - a) / (b - a)
  return t * t * (3 - 2 * t)
}

// ── Degree-weighted node sizing ───────────────────────────────────────────────
// Highly-connected nodes (information hubs) are drawn larger so clusters of
// knowledge stand out. radius ∝ √degree, clamped. force-graph derives the on-
// screen radius as √(nodeVal)·nodeRelSize, so we convert a target radius back to
// a `val`. NODE_REL_SIZE matches the renderer prop below.
const NODE_REL_SIZE = 4
function radiusFromDegree(deg: number): number {
  return Math.max(3, Math.min(22, 3 + Math.sqrt(deg) * 2.2))
}
function valFromDegree(deg: number): number {
  const r = radiusFromDegree(deg)
  return (r / NODE_REL_SIZE) ** 2
}

const ForceGraph2D = lazy(() =>
  import('react-force-graph-2d').then((m) => ({ default: m.default })),
)
const ForceGraph3D = lazy(() =>
  import('react-force-graph-3d').then((m) => ({ default: m.default })),
)

// Hard ceiling on SIMULATED nodes — the force layout (not drawing) is the cost,
// and react-force-graph stays smooth up to a few thousand. Realistic graphs sit
// well under this, so every node renders; only a pathological graph degrades to
// its degree-ordered core. The viewport bounds what's *visible* via the zoom
// clamp below (MIN_ZOOM/MAX_ZOOM) — the user pans to reach the rest.
const MAX_NODES = 4000
// Zoom-out floor: can't shrink the whole graph to dust — a big graph shows a
// readable region and you pan for more. Zoom-in ceiling keeps nodes from
// ballooning. These give the "≤~viewport-worth visible, pan to see more" feel.
const MIN_ZOOM = 0.35
const MAX_ZOOM = 8

class CanvasBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
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
        <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
          <AlertCircle size={22} className="text-red-400" />
          <p className="text-sm font-medium text-red-300">Graph render error</p>
          <p className="max-w-md break-words text-xs text-red-400/80">{this.state.error.message}</p>
          <button
            onClick={() => this.setState({ error: null })}
            className="mt-2 rounded-md border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-700"
          >
            Retry
          </button>
        </div>
      )
    }
    return this.props.children
  }
}

interface WorkspaceCanvasProps {
  nodes: GraphNode[]
  edges: GraphEdge[]
  selectedId: string | null
  onSelect: (node: GraphNode | null) => void
  /** When set (e.g. hovering a node in the search list), the camera pans/jumps to
   *  this node and it is highlighted, without committing a selection. */
  peekNodeId?: string | null
  className?: string
}

export function WorkspaceCanvas({ nodes, edges, selectedId, onSelect, peekNodeId = null, className }: WorkspaceCanvasProps) {
  const [viewMode, setViewMode] = useState<ViewMode>('2d')
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const fg2dRef = useRef<any>(null) // eslint-disable-line @typescript-eslint/no-explicit-any
  const [dim, setDim] = useState<{ w: number; h: number }>({ w: 0, h: 0 })

  // On-canvas node labels (2D): default ON, persisted.
  const [showLabels, setShowLabels] = useState<boolean>(() => {
    try { return localStorage.getItem('gw.showLabels') !== '0' } catch { return true }
  })
  const toggleLabels = useCallback(() => {
    setShowLabels((v) => {
      const nv = !v
      try { localStorage.setItem('gw.showLabels', nv ? '1' : '0') } catch { /* ignore */ }
      return nv
    })
  }, [])
  // Surfaced indicator when the FPS guard has dropped labels.
  const [labelsThrottled, setLabelsThrottled] = useState(false)

  // Auto-orbit (3D only): a showcase mode that slowly rotates the camera.
  const [autoRotate, setAutoRotate] = useState(false)
  const fg3dRef = useRef<any>(null)

  // Measure the container; the canvas mounts only once we have real dimensions.
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const apply = () => {
      const r = el.getBoundingClientRect()
      setDim({ w: Math.max(0, Math.floor(r.width)), h: Math.max(0, Math.floor(r.height)) })
    }
    apply()
    const ro = new ResizeObserver(apply)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Cap node count by degree and keep only edges whose BOTH endpoints survive —
  // react-force-graph throws on a link referencing a missing node.
  const { displayNodes, displayLinks, degree } = useMemo(() => {
    const degree = new Map<string, number>()
    for (const e of edges) {
      degree.set(e.source, (degree.get(e.source) ?? 0) + 1)
      degree.set(e.target, (degree.get(e.target) ?? 0) + 1)
    }
    let ns = nodes
    if (nodes.length > MAX_NODES) {
      ns = [...nodes].sort((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0)).slice(0, MAX_NODES)
    }
    const ids = new Set(ns.map((n) => n.id))
    const ls = edges
      .filter((e) => ids.has(e.source) && ids.has(e.target))
      .map((e) => ({ source: e.source, target: e.target, type: e.type, confidence: e.confidence }))
    return { displayNodes: ns, displayLinks: ls, degree }
  }, [nodes, edges])

  // Live degree map for the size + label callbacks (read via ref so accessor
  // identities stay stable; force-graph re-reads on graphData change).
  const degreeRef = useRef(degree)
  degreeRef.current = degree
  const nodeVal = useCallback((n: object) => valFromDegree(degreeRef.current.get((n as GraphNode).id) ?? 0), [])

  const graphData = useMemo(() => ({ nodes: displayNodes, links: displayLinks }), [displayNodes, displayLinks])

  // Neighbours of the focus node stay bright; everything else fades.
  // A "peek" (search-list hover) focuses too, ranking above the sticky selection.
  const focusId = hoveredId ?? peekNodeId ?? selectedId
  const focusSet = useMemo(() => {
    if (!focusId) return null
    const s = new Set<string>([focusId])
    // After the simulation starts, force-graph replaces link source/target with
    // node OBJECTS — so extract the id whether it's a string or an object.
    const idOf = (v: unknown): string =>
      typeof v === 'string' ? v : ((v as { id?: string })?.id ?? '')
    for (const e of displayLinks) {
      const sid = idOf(e.source)
      const tid = idOf(e.target)
      if (sid === focusId) s.add(tid)
      else if (tid === focusId) s.add(sid)
    }
    return s
  }, [focusId, displayLinks])

  // ── Animated focus fade ───────────────────────────────────────────────
  // Ease each node's opacity toward its target (1 if in the focus set, FADE
  // otherwise) instead of snapping — the instant flip read as a flicker. A short
  // rAF loop lerps the per-node values and bumps `animTick`, whose fresh accessor
  // identity makes the ForceGraph re-read node/link colours each frame, so 2D and
  // 3D both fade smoothly.
  const FADE = 0.15
  const focusAlphaRef = useRef<Map<string, number>>(new Map())
  const [animTick, setAnimTick] = useState(0)
  const rafRef = useRef<number | null>(null)
  const focusSetRef = useRef(focusSet)
  focusSetRef.current = focusSet
  const nodesRef = useRef(displayNodes)
  nodesRef.current = displayNodes

  useEffect(() => {
    const step = () => {
      const m = focusAlphaRef.current
      const fs = focusSetRef.current
      let moving = false
      for (const n of nodesRef.current) {
        const target = !fs || fs.has(n.id) ? 1 : FADE
        const cur = m.get(n.id)
        if (cur === undefined) {
          m.set(n.id, target)
          continue
        }
        // Slow, soft ease so non-focused nodes drift gently into the background
        // on hover (lower factor = slower fade). ~0.6–0.8s instead of a snap.
        const next = cur + (target - cur) * 0.055
        if (Math.abs(target - next) > 0.006) {
          m.set(n.id, next)
          moving = true
        } else {
          m.set(n.id, target)
        }
      }
      setAnimTick((t) => (t + 1) & 0xffff)
      rafRef.current = moving ? requestAnimationFrame(step) : null
    }
    if (rafRef.current) cancelAnimationFrame(rafRef.current)
    rafRef.current = requestAnimationFrame(step)
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
    }
  }, [focusId])

  const alphaOf = useCallback((id: string) => focusAlphaRef.current.get(id) ?? 1, [])

  // Pan/jump the camera to the peeked node (search-list hover). 2D pans; 3D moves
  // the camera to look at it. Reads live node positions (mutated post-layout).
  useEffect(() => {
    if (!peekNodeId) return
    const n = nodesRef.current.find((d) => d.id === peekNodeId) as
      | (GraphNode & { x?: number; y?: number; z?: number })
      | undefined
    if (!n || n.x == null || n.y == null) return
    if (viewMode === '2d') {
      fg2dRef.current?.centerAt?.(n.x, n.y, 600)
    } else {
      const dist = 150
      fg3dRef.current?.cameraPosition?.(
        { x: n.x, y: n.y, z: (n.z ?? 0) + dist },
        { x: n.x, y: n.y, z: n.z ?? 0 },
        600,
      )
    }
  }, [peekNodeId, viewMode])

  const nodeColor = useCallback(
    (n: object) => withAlpha(getNodeColor(n as GraphNode, 'type'), alphaOf((n as GraphNode).id)),
    // animTick: fresh identity each frame so the ForceGraph re-reads colours.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [alphaOf, animTick],
  )
  const linkColor = useCallback(
    (l: object) => {
      const e = l as {
        source: string | { id: string }
        target: string | { id: string }
        confidence?: number | null
      }
      const s = typeof e.source === 'string' ? e.source : e.source.id
      const t = typeof e.target === 'string' ? e.target : e.target.id
      const f = Math.min(alphaOf(s), alphaOf(t)) // least-focused endpoint
      const focusOp = 0.08 + (0.5 - 0.08) * ((f - FADE) / (1 - FADE))
      // A4 — encode per-edge confidence. Higher confidence = brighter + greener;
      // lower = dimmer + amber/red. Edges with no confidence render neutral slate.
      const c = typeof e.confidence === 'number' ? Math.max(0, Math.min(1, e.confidence)) : null
      if (c === null) return withAlpha('#475569', focusOp)
      // Confidence scales opacity (0.5 floor → 1.0) on top of the focus dimming,
      // and shifts hue from amber (#f59e0b, low) → emerald (#10b981, high).
      const op = focusOp * (0.5 + 0.5 * c)
      const lo = [245, 158, 11] // amber-500
      const hi = [16, 185, 129] // emerald-500
      const rgb = lo.map((v, i) => Math.round(v + (hi[i] - v) * c))
      return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${op.toFixed(3)})`
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [alphaOf, animTick],
  )
  // A4 — edge WIDTH by confidence: 0.4 (low) → 2.0 (high). Unknown → 0.8 baseline.
  const linkWidth = useCallback((l: object) => {
    const c = (l as { confidence?: number | null }).confidence
    if (typeof c !== 'number') return 0.8
    return 0.4 + 1.6 * Math.max(0, Math.min(1, c))
  }, [])

  // ── Label perf guard ──────────────────────────────────────────────────
  // Refs (not state) so the per-frame canvas callbacks read live values without
  // re-rendering. A smoothed FPS estimate auto-drops labels under load.
  const zoomRef = useRef(1)
  const labelsThrottledRef = useRef(false)
  const fpsRef = useRef(60)
  const lastFrameRef = useRef(0)
  const frameLabelCountRef = useRef(0)
  const showLabelsRef = useRef(showLabels)
  showLabelsRef.current = showLabels

  // ── 3D label sprites ──────────────────────────────────────────────────
  // SpriteText objects created by nodeThreeObject / linkThreeObject, kept in maps
  // so the per-frame distance loop can fade them. Node sprites are keyed by node
  // id; edge sprites by a stable src|tgt|type key. react-force-graph recreates
  // these objects when graphData changes, so we just clear the maps on data change
  // to avoid leaking stale references.
  const spriteMapRef = useRef<Map<string, SpriteText>>(new Map())
  const edgeSpriteMapRef = useRef<Map<string, SpriteText>>(new Map())
  // Live refs to the displayed data so the (stable-identity) 3D loop reads fresh
  // arrays without being re-created each render.
  const displayLinksRef = useRef(displayLinks)
  displayLinksRef.current = displayLinks

  // Extract a node id from a link endpoint that may be a string or a node object
  // (force-graph swaps strings for objects once the simulation starts).
  const idOfEndpoint = useCallback(
    (v: unknown): string => (typeof v === 'string' ? v : ((v as { id?: string })?.id ?? '')),
    [],
  )
  const edgeKey = useCallback(
    (src: unknown, tgt: unknown, type?: string): string =>
      `${idOfEndpoint(src)}|${idOfEndpoint(tgt)}|${type ?? ''}`,
    [idOfEndpoint],
  )

  // Runs once per rendered frame (2D): track zoom, reset the per-frame label
  // budget, and measure smoothed FPS → toggle the throttle with hysteresis.
  const onRenderFramePre = useCallback((_ctx: CanvasRenderingContext2D, globalScale: number) => {
    zoomRef.current = globalScale
    frameLabelCountRef.current = 0
    const now = performance.now()
    const last = lastFrameRef.current
    lastFrameRef.current = now
    if (last) {
      const dt = now - last
      if (dt > 0) fpsRef.current = fpsRef.current * 0.9 + (1000 / dt) * 0.1
    }
    if (!labelsThrottledRef.current && fpsRef.current < FPS_FLOOR) {
      labelsThrottledRef.current = true
      setLabelsThrottled(true)
    } else if (labelsThrottledRef.current && fpsRef.current > FPS_RECOVER) {
      labelsThrottledRef.current = false
      setLabelsThrottled(false)
    }
  }, [])

  // Draw a node label (after the default node circle) — zoom-faded, focus-aware,
  // viewport-culled, per-frame-capped. Skipped entirely when off / throttled /
  // zoomed out (the main perf win).
  const nodeCanvasObject = useCallback(
    (node: object, ctx: CanvasRenderingContext2D, globalScale: number) => {
      if (!showLabelsRef.current || labelsThrottledRef.current) return
      const zoomT = smoothstep(globalScale, LABEL_ZOOM_MIN, LABEL_ZOOM_FULL)
      if (zoomT <= 0) return
      if (frameLabelCountRef.current >= MAX_LABELS_PER_FRAME) return
      const n = node as GraphNode & { x?: number; y?: number }
      if (n.x == null || n.y == null) return
      // Viewport cull (device-pixel screen coords via the current transform).
      const tf = ctx.getTransform()
      const sx = tf.a * n.x + tf.e
      const sy = tf.d * n.y + tf.f
      if (sx < -60 || sy < -30 || sx > ctx.canvas.width + 60 || sy > ctx.canvas.height + 30) return
      const label = n.label || resolveTypeLabel(n)
      if (!label) return
      const alpha = zoomT * alphaOf(n.id)
      if (alpha <= 0.03) return
      frameLabelCountRef.current++
      const fontSize = Math.min(5, 12 / globalScale)
      // Place the label just below the node, accounting for its degree-weighted size.
      const r = radiusFromDegree(degreeRef.current.get(n.id) ?? 0)
      ctx.save()
      ctx.font = `${fontSize}px sans-serif`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'top'
      ctx.lineWidth = 2 / globalScale
      ctx.strokeStyle = `rgba(2,6,23,${(0.7 * alpha).toFixed(3)})`
      ctx.strokeText(label, n.x, n.y + r + 2)
      ctx.fillStyle = `rgba(214,222,236,${alpha.toFixed(3)})`
      ctx.fillText(label, n.x, n.y + r + 2)
      ctx.restore()
    },
    [alphaOf],
  )

  // Edge/relationship label — only when zoomed in very close.
  const linkCanvasObject = useCallback(
    (link: object, ctx: CanvasRenderingContext2D, globalScale: number) => {
      if (!showLabelsRef.current || labelsThrottledRef.current) return
      if (globalScale < EDGE_LABEL_ZOOM) return
      if (frameLabelCountRef.current >= MAX_LABELS_PER_FRAME) return
      const l = link as {
        source: { x?: number; y?: number }
        target: { x?: number; y?: number }
        type?: string
      }
      const s = l.source, t = l.target
      if (!s || !t || s.x == null || s.y == null || t.x == null || t.y == null) return
      if (!l.type) return
      frameLabelCountRef.current++
      const alpha = smoothstep(globalScale, EDGE_LABEL_ZOOM, EDGE_LABEL_ZOOM + 3)
      const mx = (s.x + t.x) / 2
      const my = (s.y + t.y) / 2
      const fontSize = Math.min(4, 10 / globalScale)
      ctx.save()
      ctx.font = `${fontSize}px sans-serif`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.lineWidth = 2 / globalScale
      ctx.strokeStyle = `rgba(2,6,23,${(0.7 * alpha).toFixed(3)})`
      ctx.strokeText(l.type, mx, my)
      ctx.fillStyle = `rgba(148,163,184,${alpha.toFixed(3)})`
      ctx.fillText(l.type, mx, my)
      ctx.restore()
    },
    [],
  )

  // ── 3D sprite factories ───────────────────────────────────────────────
  // Build (and register) a SpriteText for each node. depthWrite=false + transparent
  // let the per-frame loop fade opacity without z-fighting. Starts invisible; the
  // distance loop reveals it.
  const nodeThreeObject = useCallback((node: object) => {
    const n = node as GraphNode
    const text = n.label || resolveTypeLabel(n)
    const sprite = new SpriteText(text || '')
    sprite.textHeight = 3.5
    sprite.color = '#d6deec'
    sprite.material.depthWrite = false
    sprite.material.transparent = true
    sprite.material.opacity = 0
    sprite.visible = false
    spriteMapRef.current.set(n.id, sprite)
    return sprite
  }, [])

  const linkThreeObject = useCallback(
    (link: object) => {
      const l = link as { source: unknown; target: unknown; type?: string }
      if (!l.type) {
        // Still return an (empty, hidden) sprite so positionUpdate has an object.
        const empty = new SpriteText('')
        empty.visible = false
        return empty
      }
      const sprite = new SpriteText(l.type)
      sprite.textHeight = 2.5
      sprite.color = '#94a3b8'
      sprite.material.depthWrite = false
      sprite.material.transparent = true
      sprite.material.opacity = 0
      sprite.visible = false
      edgeSpriteMapRef.current.set(edgeKey(l.source, l.target, l.type), sprite)
      return sprite
    },
    [edgeKey],
  )

  // Position each edge sprite at the link midpoint. Returning true tells
  // react-force-graph to skip its own default positioning.
  const linkPositionUpdate = useCallback(
    (
      obj: { position: { set: (x: number, y: number, z: number) => void } },
      coords: { start: { x: number; y: number; z: number }; end: { x: number; y: number; z: number } },
    ) => {
      const { start, end } = coords
      obj.position.set((start.x + end.x) / 2, (start.y + end.y) / 2, (start.z + end.z) / 2)
      return true
    },
    [],
  )

  // ── 3D auto-orbit loop ─────────────────────────────────────────────────
  // When 3D + autoRotate, slowly orbit the camera in the xz-plane (keeping y).
  // We seed the angle/radius from the live camera position so toggling on doesn't
  // jump the view. cameraPosition(..., undefined, 0) moves instantly per frame so
  // the motion is smooth rather than tweened.
  useEffect(() => {
    if (viewMode !== '3d' || !autoRotate) return
    let raf = 0
    let angle: number | null = null
    let radius = 0
    let camY = 0
    const tick = () => {
      const fg = fg3dRef.current
      if (fg && typeof fg.cameraPosition === 'function' && typeof fg.camera === 'function') {
        if (angle === null) {
          const pos = fg.camera().position
          radius = Math.hypot(pos.x, pos.z) || 300
          camY = pos.y
          angle = Math.atan2(pos.x, pos.z)
        }
        angle += ORBIT_SPEED
        fg.cameraPosition(
          { x: radius * Math.sin(angle), y: camY, z: radius * Math.cos(angle) },
          undefined,
          0,
        )
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [viewMode, autoRotate])

  // ── 3D distance-gated label loop ───────────────────────────────────────
  // Runs only in 3D. Each frame: measure smoothed FPS (the 2D onRenderFramePre
  // doesn't fire here, so drive the guard from this loop), then fade every node /
  // edge sprite by its distance from the camera. Reuses showLabels + the same
  // throttle pill machinery as 2D. A per-frame visible cap bounds draw cost.
  useEffect(() => {
    if (viewMode !== '3d') return
    let raf = 0
    let last = 0
    const camPos = { x: 0, y: 0, z: 0 }
    const tick = () => {
      const fg = fg3dRef.current
      if (fg && typeof fg.camera === 'function') {
        // Smoothed FPS measured from this loop's own cadence.
        const now = performance.now()
        if (last) {
          const dt = now - last
          if (dt > 0) fpsRef.current = fpsRef.current * 0.9 + (1000 / dt) * 0.1
        }
        last = now
        if (!labelsThrottledRef.current && fpsRef.current < FPS_FLOOR) {
          labelsThrottledRef.current = true
          setLabelsThrottled(true)
        } else if (labelsThrottledRef.current && fpsRef.current > FPS_RECOVER) {
          labelsThrottledRef.current = false
          setLabelsThrottled(false)
        }

        const cam = fg.camera().position
        camPos.x = cam.x
        camPos.y = cam.y
        camPos.z = cam.z
        const gateOff = !showLabelsRef.current || labelsThrottledRef.current
        let shown = 0

        // Node sprites.
        for (const node of nodesRef.current) {
          const sprite = spriteMapRef.current.get(node.id)
          if (!sprite) continue
          const nn = node as GraphNode & { x?: number; y?: number; z?: number }
          if (gateOff || nn.x == null || nn.y == null || nn.z == null || shown >= MAX_SPRITES_VISIBLE_3D) {
            sprite.visible = false
            continue
          }
          const dist = Math.hypot(camPos.x - nn.x, camPos.y - nn.y, camPos.z - nn.z)
          const t = 1 - smoothstep(dist, LABEL_DIST_NEAR_3D, LABEL_DIST_FAR_3D)
          const vis = t > 0.03
          sprite.visible = vis
          if (vis) {
            sprite.material.opacity = t
            shown++
          }
        }

        // Edge sprites — tighter gate so relationship names appear only up close.
        for (const link of displayLinksRef.current) {
          const l = link as { source: unknown; target: unknown; type?: string }
          const sprite = edgeSpriteMapRef.current.get(edgeKey(l.source, l.target, l.type))
          if (!sprite) continue
          const s = l.source as { x?: number; y?: number; z?: number }
          const tgt = l.target as { x?: number; y?: number; z?: number }
          if (
            gateOff ||
            shown >= MAX_SPRITES_VISIBLE_3D ||
            typeof s !== 'object' ||
            typeof tgt !== 'object' ||
            s.x == null || s.y == null || s.z == null ||
            tgt.x == null || tgt.y == null || tgt.z == null
          ) {
            sprite.visible = false
            continue
          }
          const mx = (s.x + tgt.x) / 2
          const my = (s.y + tgt.y) / 2
          const mz = (s.z + tgt.z) / 2
          const dist = Math.hypot(camPos.x - mx, camPos.y - my, camPos.z - mz)
          const t = 1 - smoothstep(dist, EDGE_LABEL_DIST_NEAR_3D, EDGE_LABEL_DIST_FAR_3D)
          const vis = t > 0.03
          sprite.visible = vis
          if (vis) {
            sprite.material.opacity = t
            shown++
          }
        }
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
    // showLabels/throttle are read via refs; edgeKey is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewMode, edgeKey])

  // Clear the sprite maps when the graph data changes — react-force-graph creates
  // fresh objects, so dropping old keys prevents leaks / stale fades.
  useEffect(() => {
    spriteMapRef.current.clear()
    edgeSpriteMapRef.current.clear()
  }, [graphData])

  const handleClick = useCallback((n: object) => onSelect(n as GraphNode), [onSelect])
  // Click empty canvas → clear selection/focus.
  const handleBackgroundClick = useCallback(() => onSelect(null), [onSelect])
  const handleHover = useCallback((n: object | null) => setHoveredId(n ? (n as GraphNode).id : null), [])
  const ready = dim.w > 0 && dim.h > 0

  const commonProps = {
    graphData,
    width: dim.w,
    height: dim.h,
    backgroundColor: '#020617',
    nodeRelSize: NODE_REL_SIZE,
    nodeVal: nodeVal as never,
    nodeColor: nodeColor as never,
    nodeLabel: ((n: object) => (n as GraphNode).label || resolveTypeLabel(n as GraphNode)) as never,
    linkColor: linkColor as never,
    linkWidth: linkWidth as never,
    linkDirectionalArrowLength: 3,
    linkDirectionalArrowRelPos: 0.95,
    onNodeClick: handleClick as never,
    onBackgroundClick: handleBackgroundClick as never,
    onNodeHover: handleHover as never,
    cooldownTicks: 120,
    minZoom: MIN_ZOOM,
    maxZoom: MAX_ZOOM,
  }

  return (
    <div ref={containerRef} className={cn('relative h-full w-full overflow-hidden bg-slate-950', className)}>
      {/* Controls: labels toggle + 2D/3D */}
      <div className="absolute right-3 top-3 z-20 flex items-center gap-2">
        <button
          onClick={toggleLabels}
          title={showLabels ? 'Hide node labels' : 'Show node labels'}
          className={cn('flex items-center gap-1 rounded-lg border px-2 py-1 text-[11px] transition-colors',
            showLabels ? 'border-indigo-600 bg-indigo-950/50 text-indigo-300' : 'border-slate-700 bg-slate-900/90 text-slate-500 hover:text-slate-300')}
        >
          <Tag size={11} /> Labels
        </button>
        {viewMode === '3d' && (
          <button
            onClick={() => setAutoRotate((v) => !v)}
            title={autoRotate ? 'Stop auto-rotate' : 'Auto-rotate camera'}
            className={cn('flex items-center gap-1 rounded-lg border px-2 py-1 text-[11px] transition-colors',
              autoRotate ? 'border-indigo-600 bg-indigo-950/50 text-indigo-300' : 'border-slate-700 bg-slate-900/90 text-slate-500 hover:text-slate-300')}
          >
            <Orbit size={11} /> Orbit
          </button>
        )}
        <div className="flex overflow-hidden rounded-lg border border-slate-700 bg-slate-900/90">
          <button onClick={() => setViewMode('2d')} className={cn('flex items-center gap-1 px-2 py-1 text-[11px]', viewMode === '2d' ? 'bg-slate-700 text-slate-100' : 'text-slate-500 hover:text-slate-300')}>
            <Square size={11} /> 2D
          </button>
          <button onClick={() => setViewMode('3d')} className={cn('flex items-center gap-1 px-2 py-1 text-[11px]', viewMode === '3d' ? 'bg-slate-700 text-slate-100' : 'text-slate-500 hover:text-slate-300')}>
            <Box size={11} /> 3D
          </button>
        </div>
      </div>

      {/* FPS guard surfaced: labels auto-dropped under load (2D + 3D). */}
      {showLabels && labelsThrottled && (
        <div className="absolute left-3 top-3 z-20 flex items-center gap-1.5 rounded-md border border-amber-700/50 bg-amber-950/40 px-2 py-1 text-[10px] text-amber-300">
          <Gauge size={11} /> Labels paused (performance)
        </div>
      )}

      {displayNodes.length === 0 && (
        <div className="absolute inset-0 z-10 flex items-center justify-center text-sm text-slate-600">
          No graph data for this compilation.
        </div>
      )}

      <CanvasBoundary>
        {ready && displayNodes.length > 0 && (
          <Suspense fallback={<div className="flex h-full items-center justify-center text-xs text-slate-500">Loading renderer…</div>}>
            {viewMode === '2d' ? (
              <ForceGraph2D
                {...commonProps}
                ref={fg2dRef as never}
                onRenderFramePre={onRenderFramePre as never}
                nodeCanvasObjectMode={(() => 'after') as never}
                nodeCanvasObject={nodeCanvasObject as never}
                linkCanvasObjectMode={(() => 'after') as never}
                linkCanvasObject={linkCanvasObject as never}
              />
            ) : (
              <ForceGraph3D
                {...commonProps}
                ref={fg3dRef as never}
                linkOpacity={0.5}
                nodeThreeObjectExtend={true as never}
                nodeThreeObject={nodeThreeObject as never}
                linkThreeObjectExtend={true as never}
                linkThreeObject={linkThreeObject as never}
                linkPositionUpdate={linkPositionUpdate as never}
              />
            )}
          </Suspense>
        )}
      </CanvasBoundary>
    </div>
  )
}
