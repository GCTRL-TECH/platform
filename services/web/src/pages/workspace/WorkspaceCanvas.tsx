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
import { AlertCircle, Box, Square, Tag, Gauge, Orbit, Eye, Palette } from 'lucide-react'
import SpriteText from 'three-spritetext'
import * as THREE from 'three'
import { cn } from '@/lib/utils'
import { getNodeColor, resolveTypeLabel, withAlpha } from '@/components/graph-explorer/colors'
import type { GraphEdge, GraphNode, ViewMode } from '@/components/graph-explorer/types'
import {
  THEME_LIST, resolveTheme, rotateHue, renderStarfield2D, renderGlowSprite,
} from '@/components/graph-explorer/themes'
import { useAdaptiveQuality, type QualityLevel } from './useAdaptiveQuality'

// ── Label rendering tuning (2D) ───────────────────────────────────────────────
// Node labels fade in between these zoom levels; below MIN nothing is drawn (the
// main perf win — no per-node text when zoomed out). Edge labels only when really
// close. Per-frame cap + FPS guard keep large graphs fluid.
const LABEL_ZOOM_MIN = 0.9
const LABEL_ZOOM_FULL = 1.8
const EDGE_LABEL_ZOOM = 4
const MAX_LABELS_PER_FRAME = 200

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

// Hard ceiling on SIMULATED nodes — a tab-crash safety valve, not the normal
// quality control. The force layout (not drawing) is the cost here; below this
// ceiling every node is simulated and the adaptive quality governor
// (useAdaptiveQuality) decides what's actually DRAWN via nodeVisibility /
// linkVisibility (degree/confidence-ranked, FPS-driven — see Wave 2). Only a
// truly pathological graph (>50k nodes) gets pre-sliced to its degree-ordered
// core before it ever reaches the simulation. The viewport bounds what's
// *visible* via the zoom clamp below (MIN_ZOOM/MAX_ZOOM) — the user pans to
// reach the rest.
const NODE_HARD_CEILING = 50_000
// Zoom-out floor: can't shrink the whole graph to dust — a big graph shows a
// readable region and you pan for more. Zoom-in ceiling keeps nodes from
// ballooning. These give the "≤~viewport-worth visible, pan to see more" feel.
const MIN_ZOOM = 0.35
const MAX_ZOOM = 8

/** One-time probe: can this browser/device create a WebGL context at all?
 *  three.js (the 3D renderer) throws "Error creating WebGL context" when it
 *  can't — headless/remote sessions, GPU-less VMs, blocklisted drivers, or too
 *  many live contexts. We probe once and cache, so the UI can pre-empt the crash
 *  by hiding/disabling 3D and staying in 2D instead of showing a dead error card. */
let _webglOk: boolean | null = null
function webglAvailable(): boolean {
  if (_webglOk !== null) return _webglOk
  try {
    const c = document.createElement('canvas')
    const gl =
      c.getContext('webgl2') ||
      c.getContext('webgl') ||
      c.getContext('experimental-webgl')
    _webglOk = !!gl
  } catch {
    _webglOk = false
  }
  return _webglOk
}

class CanvasBoundary extends Component<
  { children: ReactNode; onError?: (error: Error) => void },
  { error: Error | null }
> {
  constructor(props: { children: ReactNode; onError?: (error: Error) => void }) {
    super(props)
    this.state = { error: null }
  }
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  componentDidCatch(error: Error) {
    // Let the parent recover (e.g. drop 3D → 2D). The parent re-keys this
    // boundary on view change, which remounts it clean, so we don't need to
    // clear our own error state here.
    this.props.onError?.(error)
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
  /** Explicit theme override (e.g. from an embed's ?theme= query param).
   *  Falls back to localStorage['gw.theme'], then 'midnight'. */
  theme?: string
  /** Explicit initial labels override (e.g. an embed's ?labels=0 query param).
   *  Bypasses localStorage['gw.showLabels'] when set. */
  initialLabels?: boolean
}

export function WorkspaceCanvas({
  nodes, edges, selectedId, onSelect, peekNodeId = null, className,
  theme: themeProp, initialLabels,
}: WorkspaceCanvasProps) {
  const [viewMode, setViewMode] = useState<ViewMode>('2d')
  // Whether 3D can run here at all (WebGL probe). When false we keep the user in
  // 2D and disable the 3D toggle instead of letting three.js throw.
  const canUse3D = webglAvailable()
  // Set when 3D had to be abandoned (a render error forced a fallback) so we can
  // tell the user why they're seeing 2D. Default 2D needs no warning.
  const [render3dWarning, setRender3dWarning] = useState<string | null>(null)
  const switchTo2D = useCallback((reason: string) => {
    setViewMode('2d')
    setRender3dWarning(reason)
  }, [])
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const fg2dRef = useRef<any>(null) // eslint-disable-line @typescript-eslint/no-explicit-any
  const [dim, setDim] = useState<{ w: number; h: number }>({ w: 0, h: 0 })

  // On-canvas node labels (2D): default ON, persisted. An explicit prop (e.g.
  // an embed's ?labels=0) bypasses the persisted preference entirely.
  const [showLabels, setShowLabels] = useState<boolean>(() => {
    if (initialLabels !== undefined) return initialLabels
    try { return localStorage.getItem('gw.showLabels') !== '0' } catch { return true }
  })
  const toggleLabels = useCallback(() => {
    setShowLabels((v) => {
      const nv = !v
      try { localStorage.setItem('gw.showLabels', nv ? '1' : '0') } catch { /* ignore */ }
      return nv
    })
  }, [])
  // Auto-orbit (3D only): a showcase mode that slowly rotates the camera.
  const [autoRotate, setAutoRotate] = useState(false)
  const fg3dRef = useRef<any>(null)

  // ── Theme (Wave 2) ──────────────────────────────────────────────────────
  // Precedence: explicit prop (embed ?theme=) > persisted pick > default.
  const [themeId, setThemeId] = useState<string>(() => {
    if (themeProp) return themeProp
    try { return localStorage.getItem('gw.theme') ?? 'midnight' } catch { return 'midnight' }
  })
  const [themeHue, setThemeHue] = useState<number>(() => {
    if (themeProp) return 0 // embeds don't read the hue slider's own storage
    try { return parseInt(localStorage.getItem('gw.themeHue') ?? '0', 10) || 0 } catch { return 0 }
  })
  const [themePickerOpen, setThemePickerOpen] = useState(false)
  const theme = resolveTheme(themeId)
  const selectTheme = useCallback((id: string) => {
    setThemeId(id)
    try { localStorage.setItem('gw.theme', id) } catch { /* ignore */ }
  }, [])
  const setHue = useCallback((deg: number) => {
    setThemeHue(deg)
    try { localStorage.setItem('gw.themeHue', String(deg)) } catch { /* ignore */ }
  }, [])
  // Resolve a node's final drawn colour: curated/hashed base → theme hue
  // transform (if any) → user hue-slider rotation. Shared by the 2D/3D node
  // colour callbacks AND the glow sprite so they never drift apart.
  const resolveThemedNodeColor = useCallback(
    (node: GraphNode) => {
      const base = getNodeColor(node, 'type')
      const themed = theme.nodeColor?.(base) ?? base
      return rotateHue(themed, themeHue)
    },
    [theme, themeHue],
  )

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

  // Cap node count by degree (tab-crash safety valve only, see
  // NODE_HARD_CEILING) and keep only edges whose BOTH endpoints survive —
  // react-force-graph throws on a link referencing a missing node. Also
  // precompute a degree RANK per node and a confidence/degree RANK per edge —
  // the adaptive quality governor uses these ranks (not raw degree/confidence)
  // to decide what's visible each frame, so the "top N" is always the most
  // meaningfully-connected/most-confident subset, never an arbitrary slice.
  const { displayNodes, displayLinks, degree, degreeRank, edgeCount } = useMemo(() => {
    const degree = new Map<string, number>()
    for (const e of edges) {
      degree.set(e.source, (degree.get(e.source) ?? 0) + 1)
      degree.set(e.target, (degree.get(e.target) ?? 0) + 1)
    }
    let ns = nodes
    if (nodes.length > NODE_HARD_CEILING) {
      ns = [...nodes].sort((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0)).slice(0, NODE_HARD_CEILING)
    }
    const ids = new Set(ns.map((n) => n.id))

    // Degree rank: 0 = most-connected. Used by nodeVisibility (L3 culling).
    const degreeRank = new Map<string, number>()
    ;[...ns]
      .sort((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0))
      .forEach((n, i) => degreeRank.set(n.id, i))

    // Edge rank: confidence desc, then min-endpoint-degree desc. Embedded
    // directly on each (freshly-created) edge object as `_edgeRank` — edges
    // are already remapped into new objects every recompute, so this is a
    // free O(1) lookup at draw time with no extra Map/identity bookkeeping.
    const lsBase = edges
      .filter((e) => ids.has(e.source) && ids.has(e.target))
      .map((e) => ({ source: e.source, target: e.target, type: e.type, confidence: e.confidence, _edgeRank: 0 }))
    const minEndpointDegree = (e: { source: string; target: string }) =>
      Math.min(degree.get(e.source) ?? 0, degree.get(e.target) ?? 0)
    const order = lsBase
      .map((_, i) => i)
      .sort((a, b) => {
        const ca = lsBase[a].confidence ?? -1
        const cb = lsBase[b].confidence ?? -1
        if (cb !== ca) return cb - ca
        return minEndpointDegree(lsBase[b]) - minEndpointDegree(lsBase[a])
      })
    order.forEach((origIdx, rank) => { lsBase[origIdx]._edgeRank = rank })

    return { displayNodes: ns, displayLinks: lsBase, degree, degreeRank, edgeCount: lsBase.length }
  }, [nodes, edges])

  // Live degree map for the size + label callbacks (read via ref so accessor
  // identities stay stable; force-graph re-reads on graphData change).
  const degreeRef = useRef(degree)
  degreeRef.current = degree
  const nodeVal = useCallback((n: object) => valFromDegree(degreeRef.current.get((n as GraphNode).id) ?? 0), [])

  // ── Adaptive render quality (Wave 2) ───────────────────────────────────
  // Replaces the old binary "labels throttled at low FPS" guard with a
  // graduated ladder (labels → edges → nodes) — see useAdaptiveQuality.ts.
  const quality = useAdaptiveQuality()
  const qualityRef = useRef(quality)
  qualityRef.current = quality
  const degreeRankRef = useRef(degreeRank)
  degreeRankRef.current = degreeRank
  const edgeCountRef = useRef(edgeCount)
  edgeCountRef.current = edgeCount

  // "Show all" override: suppresses the governor (frozen at full quality)
  // until the user turns it off again or the underlying graph data changes.
  const [userForcedFull, setUserForcedFull] = useState(false)
  const userForcedFullRef = useRef(userForcedFull)
  userForcedFullRef.current = userForcedFull

  // Warmup seeding: a very large graph starts pre-degraded instead of visibly
  // "falling" into it after a few slow seconds. Also clears the "show all"
  // override whenever the underlying data actually changes (new compilation).
  useEffect(() => {
    const total = nodes.length
    const seedLevel: QualityLevel = total > 35_000 ? 3 : total > 20_000 ? 2 : 0
    quality.reset(seedLevel)
    setUserForcedFull(false)
    // quality.reset has a stable identity (useCallback, no deps) — only `nodes`
    // (fresh data) should re-trigger this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes])

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
    (n: object) => withAlpha(resolveThemedNodeColor(n as GraphNode), alphaOf((n as GraphNode).id)),
    // animTick: fresh identity each frame so the ForceGraph re-reads colours.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [alphaOf, animTick, resolveThemedNodeColor],
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
      // lower = dimmer + amber/red. Edges with no confidence render the theme's
      // neutral link colour. `opacityScale` lets a theme (e.g. galaxy) run
      // slightly brighter edges without touching the confidence math itself.
      const c = typeof e.confidence === 'number' ? Math.max(0, Math.min(1, e.confidence)) : null
      const scaledOp = Math.min(1, focusOp * theme.link.opacityScale)
      if (c === null) return withAlpha(theme.link.neutral, scaledOp)
      // Confidence scales opacity (0.5 floor → 1.0) on top of the focus dimming,
      // and shifts hue from amber (#f59e0b, low) → emerald (#10b981, high).
      const op = Math.min(1, scaledOp * (0.5 + 0.5 * c))
      const lo = [245, 158, 11] // amber-500
      const hi = [16, 185, 129] // emerald-500
      const rgb = lo.map((v, i) => Math.round(v + (hi[i] - v) * c))
      return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${op.toFixed(3)})`
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [alphaOf, animTick, theme],
  )
  // A4 — edge WIDTH by confidence: 0.4 (low) → 2.0 (high). Unknown → 0.8 baseline.
  const linkWidth = useCallback((l: object) => {
    const c = (l as { confidence?: number | null }).confidence
    if (typeof c !== 'number') return 0.8
    return 0.4 + 1.6 * Math.max(0, Math.min(1, c))
  }, [])

  // ── Label perf guard ──────────────────────────────────────────────────
  // Refs (not state) so the per-frame canvas callbacks read live values without
  // re-rendering. Labels are gated by the adaptive quality governor
  // (qualityRef.labelsEnabled, off from L1 up) OR the "show all" override.
  const zoomRef = useRef(1)
  const frameLabelCountRef = useRef(0)
  const showLabelsRef = useRef(showLabels)
  showLabelsRef.current = showLabels
  const labelsGatedOff = useCallback(
    () => !qualityRef.current.labelsEnabled && !userForcedFullRef.current,
    [],
  )

  // ── Theme refs (per-frame-safe reads) ──────────────────────────────────
  const themeRef = useRef(theme)
  themeRef.current = theme
  // 2D glow: cached one radial-gradient sprite per resolved node colour.
  // Cleared whenever the theme changes so stale-colour sprites never linger.
  const glowCacheRef = useRef<Map<string, HTMLCanvasElement>>(new Map())
  useEffect(() => { glowCacheRef.current.clear() }, [theme])
  const getGlowSprite = useCallback((color: string) => {
    let spr = glowCacheRef.current.get(color)
    if (!spr) {
      spr = renderGlowSprite(color)
      glowCacheRef.current.set(color, spr)
    }
    return spr
  }, [])
  // Glow only at full quality and under the theme's node-count ceiling — it
  // never fights the adaptive quality governor for frame budget.
  const glowActive = Boolean(theme.glow) && quality.level === 0 && displayNodes.length <= (theme.glow?.maxNodes ?? 0)
  const glowActiveRef = useRef(glowActive)
  glowActiveRef.current = glowActive

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

  // ── 2D starfield (theme-driven) ────────────────────────────────────────
  // Rendered ONCE into a detached canvas sized to the container, then blitted
  // per frame with an identity transform (never regenerated per-frame — see
  // themes.ts renderStarfield2D). Regenerates on resize or theme change.
  const starfieldCanvasRef = useRef<HTMLCanvasElement | null>(null)
  useEffect(() => {
    const cfg = theme.threeD.starfield
    if (!cfg || dim.w <= 0 || dim.h <= 0) {
      starfieldCanvasRef.current = null
      return
    }
    starfieldCanvasRef.current = renderStarfield2D(dim.w, dim.h, cfg.count)
  }, [theme, dim.w, dim.h])

  // Runs once per rendered frame (2D): blit the starfield (if any), track
  // zoom, reset the per-frame label budget, and feed the adaptive quality
  // governor's smoothed FPS estimate.
  const onRenderFramePre = useCallback((ctx: CanvasRenderingContext2D, globalScale: number) => {
    const starfield = starfieldCanvasRef.current
    if (starfield) {
      // Identity transform so the starfield sits in screen space (not
      // affected by zoom/pan) — a small parallax offset keeps it from
      // feeling perfectly static as the user pans.
      const tf = ctx.getTransform()
      ctx.save()
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.drawImage(starfield, tf.e * 0.05, tf.f * 0.05)
      ctx.restore()
    }
    zoomRef.current = globalScale
    frameLabelCountRef.current = 0
    if (!userForcedFullRef.current) qualityRef.current.registerFrame(performance.now())
  }, [])

  // Draw a node's glow (theme-driven, independent of the labels toggle) + its
  // label — zoom-faded, focus-aware, viewport-culled, per-frame-capped. The
  // glow half always runs when active (drawn first so it lands behind the
  // node circle — see nodeCanvasObjectMode below); the label half is skipped
  // entirely when off / degraded / zoomed out (the main perf win).
  const nodeCanvasObject = useCallback(
    (node: object, ctx: CanvasRenderingContext2D, globalScale: number) => {
      const n = node as GraphNode & { x?: number; y?: number }
      if (n.x == null || n.y == null) return

      if (glowActiveRef.current) {
        const color = resolveThemedNodeColor(n)
        const spr = getGlowSprite(color)
        const r = radiusFromDegree(degreeRef.current.get(n.id) ?? 0)
        const size = r * (themeRef.current.glow?.spriteScale ?? 2.2) * 2
        ctx.drawImage(spr, n.x - size / 2, n.y - size / 2, size, size)
      }

      if (!showLabelsRef.current || labelsGatedOff()) return
      const zoomT = smoothstep(globalScale, LABEL_ZOOM_MIN, LABEL_ZOOM_FULL)
      if (zoomT <= 0) return
      if (frameLabelCountRef.current >= MAX_LABELS_PER_FRAME) return
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
      ctx.strokeStyle = withAlpha(themeRef.current.labelStyle.outline, 0.7 * alpha)
      ctx.strokeText(label, n.x, n.y + r + 2)
      ctx.fillStyle = withAlpha(themeRef.current.labelStyle.color, alpha)
      ctx.fillText(label, n.x, n.y + r + 2)
      ctx.restore()
    },
    [alphaOf, labelsGatedOff, resolveThemedNodeColor, getGlowSprite],
  )
  // Glow needs to draw BEHIND the default node circle; force-graph only
  // supports one timing per render, so when glow is active we switch to
  // 'before' mode globally (the label still reads fine drawn first — it sits
  // below the node, offset by its radius, so there's no visual conflict).
  const nodeCanvasObjectMode = useCallback(() => (glowActiveRef.current ? 'before' : 'after'), [])

  // Edge/relationship label — only when zoomed in very close.
  const linkCanvasObject = useCallback(
    (link: object, ctx: CanvasRenderingContext2D, globalScale: number) => {
      if (!showLabelsRef.current || labelsGatedOff()) return
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
      ctx.strokeStyle = withAlpha(themeRef.current.labelStyle.outline, 0.7 * alpha)
      ctx.strokeText(l.type, mx, my)
      ctx.fillStyle = withAlpha(theme.link.neutral, alpha)
      ctx.fillText(l.type, mx, my)
      ctx.restore()
    },
    [labelsGatedOff, theme.link.neutral],
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
    sprite.color = themeRef.current.threeD.spriteColor
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
      sprite.color = themeRef.current.threeD.spriteColor
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

  // ── 3D theme application ────────────────────────────────────────────────
  // Scene background + starfield are imperative (three.js) state that react-
  // force-graph doesn't expose as props, so we reach into scene() directly.
  // Runs whenever the theme changes or 3D mounts. No bloom pass — deliberately
  // kept out per the design (post-processing is a real frame-time cost on
  // large graphs and glow is already handled cheaply in 2D via sprites).
  const starPointsRef = useRef<THREE.Points | null>(null)
  useEffect(() => {
    if (viewMode !== '3d') return
    const fg = fg3dRef.current
    if (!fg || typeof fg.scene !== 'function') return
    const scene = fg.scene()
    scene.background = new THREE.Color(theme.threeD.bg)

    if (starPointsRef.current) {
      scene.remove(starPointsRef.current)
      starPointsRef.current.geometry.dispose()
      ;(starPointsRef.current.material as THREE.Material).dispose()
      starPointsRef.current = null
    }
    const cfg = theme.threeD.starfield
    if (cfg) {
      const positions = new Float32Array(cfg.count * 3)
      for (let i = 0; i < cfg.count; i++) {
        const r = cfg.radius * (0.8 + Math.random() * 0.2)
        const t = Math.random() * Math.PI * 2
        const p = Math.acos(2 * Math.random() - 1)
        positions[i * 3] = r * Math.sin(p) * Math.cos(t)
        positions[i * 3 + 1] = r * Math.sin(p) * Math.sin(t)
        positions[i * 3 + 2] = r * Math.cos(p)
      }
      const geo = new THREE.BufferGeometry()
      geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
      const mat = new THREE.PointsMaterial({ color: 0xffffff, size: 1.5, sizeAttenuation: false })
      const points = new THREE.Points(geo, mat)
      scene.add(points)
      starPointsRef.current = points
    }

    // Sprites created before this theme change won't pick up the new colour
    // on their own (react-force-graph only recreates them on graphData
    // change) — refresh them in place; three-spritetext regenerates its
    // canvas texture on the `color` setter.
    for (const spr of spriteMapRef.current.values()) spr.color = theme.threeD.spriteColor
    for (const spr of edgeSpriteMapRef.current.values()) spr.color = theme.threeD.spriteColor
  }, [viewMode, theme])

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
  // Runs only in 3D. Each frame: feed the adaptive quality governor's smoothed
  // FPS estimate (the 2D onRenderFramePre doesn't fire here, so drive it from
  // this loop instead), then fade every node/edge sprite by its distance from
  // the camera. Reuses showLabels + the same quality gate as 2D. A per-frame
  // visible cap bounds draw cost.
  useEffect(() => {
    if (viewMode !== '3d') return
    let raf = 0
    const camPos = { x: 0, y: 0, z: 0 }
    const tick = () => {
      const fg = fg3dRef.current
      if (fg && typeof fg.camera === 'function') {
        const now = performance.now()
        if (!userForcedFullRef.current) qualityRef.current.registerFrame(now)

        const cam = fg.camera().position
        camPos.x = cam.x
        camPos.y = cam.y
        camPos.z = cam.z
        const gateOff = !showLabelsRef.current || labelsGatedOff()
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

  // ── Visibility-only culling (Wave 2 adaptive quality) ──────────────────
  // These never touch graphData/simulation — react-force-graph still lays out
  // every node, so nothing jumps or restarts when the governor steps; it just
  // stops DRAWING the lowest-ranked nodes/edges. Reads go through refs so the
  // callbacks' identities stay stable across frames (recreated only on an
  // actual quality-level or "show all" change, both rare).
  const nodeVisibility = useCallback((n: object) => {
    if (userForcedFullRef.current) return true
    const budget = qualityRef.current.nodeVisibleBudget
    if (!Number.isFinite(budget)) return true
    const rank = degreeRankRef.current.get((n as GraphNode).id) ?? Infinity
    return rank < budget
  }, [])
  const linkVisibility = useCallback((l: object) => {
    if (userForcedFullRef.current) return true
    const edge = l as { source: unknown; target: unknown; _edgeRank?: number }
    const frac = qualityRef.current.edgeVisibleFraction
    const total = edgeCountRef.current
    const rank = edge._edgeRank ?? Infinity
    if (frac < 1 && rank >= total * frac) return false
    const budget = qualityRef.current.nodeVisibleBudget
    if (Number.isFinite(budget)) {
      const sRank = degreeRankRef.current.get(idOfEndpoint(edge.source)) ?? Infinity
      const tRank = degreeRankRef.current.get(idOfEndpoint(edge.target)) ?? Infinity
      if (sRank >= budget || tRank >= budget) return false
    }
    return true
  }, [idOfEndpoint])

  const commonProps = {
    graphData,
    width: dim.w,
    height: dim.h,
    backgroundColor: theme.background,
    nodeRelSize: NODE_REL_SIZE,
    nodeVal: nodeVal as never,
    nodeColor: nodeColor as never,
    nodeLabel: ((n: object) => (n as GraphNode).label || resolveTypeLabel(n as GraphNode)) as never,
    nodeVisibility: nodeVisibility as never,
    linkVisibility: linkVisibility as never,
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

  // Human-readable summary of the current degradation, for the quality pill.
  const qualityMessage = (() => {
    if (quality.level === 0) return null
    if (quality.level === 1) return 'labels off'
    if (quality.level === 2) return 'labels off · edges reduced'
    return `showing top ${quality.nodeVisibleBudget.toLocaleString()} nodes`
  })()

  return (
    <div ref={containerRef} className={cn('relative h-full w-full overflow-hidden bg-slate-950', className)}>
      {/* Controls: theme picker + labels toggle + 2D/3D */}
      <div className="absolute right-3 top-3 z-20 flex items-center gap-2">
        <div className="relative">
          <button
            onClick={() => setThemePickerOpen((v) => !v)}
            title="Canvas theme"
            className={cn('flex items-center gap-1 rounded-lg border px-2 py-1 text-[11px] transition-colors',
              themePickerOpen ? 'border-indigo-600 bg-indigo-950/50 text-indigo-300' : 'border-slate-700 bg-slate-900/90 text-slate-500 hover:text-slate-300')}
          >
            <Palette size={11} /> Theme
          </button>
          {themePickerOpen && (
            <>
              <div className="fixed inset-0 z-30" onClick={() => setThemePickerOpen(false)} />
              <div className="absolute right-0 top-full z-40 mt-1.5 w-52 rounded-lg border border-slate-700 bg-slate-900 p-2.5 shadow-2xl">
                <div className="grid grid-cols-1 gap-1">
                  {THEME_LIST.map((t) => (
                    <button
                      key={t.id}
                      onClick={() => selectTheme(t.id)}
                      className={cn('flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-[11px] transition-colors',
                        themeId === t.id ? 'bg-indigo-500/15 text-indigo-200 ring-1 ring-indigo-500/30' : 'text-slate-300 hover:bg-slate-800/70')}
                    >
                      <span
                        className="h-3.5 w-3.5 shrink-0 rounded-full border border-white/10"
                        style={{ background: t.background }}
                      />
                      {t.label}
                    </button>
                  ))}
                </div>
                <div className="mt-2.5 border-t border-slate-800 pt-2.5">
                  <label className="flex items-center justify-between text-[10px] text-slate-500">
                    Hue shift
                    <span className="tabular-nums text-slate-400">{themeHue}°</span>
                  </label>
                  <input
                    type="range" min={-180} max={180} step={1} value={themeHue}
                    onChange={(e) => setHue(parseInt(e.target.value, 10))}
                    className="mt-1 w-full accent-indigo-500"
                  />
                </div>
              </div>
            </>
          )}
        </div>
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
          <button onClick={() => { setViewMode('2d'); setRender3dWarning(null) }} className={cn('flex items-center gap-1 px-2 py-1 text-[11px]', viewMode === '2d' ? 'bg-slate-700 text-slate-100' : 'text-slate-500 hover:text-slate-300')}>
            <Square size={11} /> 2D
          </button>
          <button
            onClick={() => { if (canUse3D) { setViewMode('3d'); setRender3dWarning(null) } }}
            disabled={!canUse3D}
            title={canUse3D ? '3D view' : '3D needs WebGL, which is unavailable on this device/browser'}
            className={cn('flex items-center gap-1 px-2 py-1 text-[11px]',
              viewMode === '3d' ? 'bg-slate-700 text-slate-100' : 'text-slate-500 hover:text-slate-300',
              !canUse3D && 'cursor-not-allowed opacity-40 hover:text-slate-500')}
          >
            <Box size={11} /> 3D
          </button>
        </div>
      </div>

      {/* 3D unavailable / fell back to 2D — explain instead of a dead error card. */}
      {render3dWarning && (
        <div className="absolute right-3 top-12 z-20 flex items-center gap-1.5 rounded-md border border-amber-700/50 bg-amber-950/40 px-2 py-1 text-[10px] text-amber-300">
          <AlertCircle size={11} /> {render3dWarning}
        </div>
      )}

      {/* Adaptive quality governor surfaced: what got degraded, plus an escape
          hatch back to full quality (2D + 3D — see useAdaptiveQuality). */}
      {!userForcedFull && qualityMessage && (
        <div className="absolute left-3 top-3 z-20 flex items-center gap-1.5 rounded-md border border-amber-700/50 bg-amber-950/40 px-2 py-1 text-[10px] text-amber-300">
          <Gauge size={11} /> Performance mode: {qualityMessage}
          <button
            onClick={() => setUserForcedFull(true)}
            title="Force full quality until the graph changes"
            className="ml-1 flex items-center gap-1 rounded border border-amber-600/40 px-1.5 py-0.5 text-amber-200 hover:bg-amber-900/40"
          >
            <Eye size={10} /> Show all
          </button>
        </div>
      )}
      {userForcedFull && (
        <div className="absolute left-3 top-3 z-20 flex items-center gap-1.5 rounded-md border border-indigo-700/50 bg-indigo-950/40 px-2 py-1 text-[10px] text-indigo-300">
          <Eye size={11} /> Full quality (forced)
          <button
            onClick={() => setUserForcedFull(false)}
            title="Resume automatic performance scaling"
            className="ml-1 rounded border border-indigo-600/40 px-1.5 py-0.5 text-indigo-200 hover:bg-indigo-900/40"
          >
            Auto
          </button>
        </div>
      )}

      {displayNodes.length === 0 && (
        <div className="absolute inset-0 z-10 flex items-center justify-center text-sm text-slate-600">
          No graph data for this compilation.
        </div>
      )}

      <CanvasBoundary
        key={viewMode}
        onError={() => {
          // A render crash in 3D (e.g. WebGL context lost) drops us to 2D with a
          // note, instead of stranding the user on the error card. Remember the
          // probe failed so the 3D toggle stays disabled this session.
          if (viewMode === '3d') {
            _webglOk = false
            switchTo2D('3D rendering failed on this device — showing 2D.')
          }
        }}
      >
        {ready && displayNodes.length > 0 && (
          <Suspense fallback={<div className="flex h-full items-center justify-center text-xs text-slate-500">Loading renderer…</div>}>
            {viewMode === '2d' ? (
              <ForceGraph2D
                {...commonProps}
                ref={fg2dRef as never}
                onRenderFramePre={onRenderFramePre as never}
                nodeCanvasObjectMode={nodeCanvasObjectMode as never}
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
