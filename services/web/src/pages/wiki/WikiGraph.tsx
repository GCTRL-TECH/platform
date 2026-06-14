/**
 * WikiGraph — the middle pane of the wiki visual explorer.
 *
 * Renders a WIKI compilation as a navigable force-graph: each wiki PAGE is a
 * node, each validated [[wikilink]] an edge. Data comes from the clearance-
 * filtered `/wiki-graph` endpoint, so pages above the caller's clearance (and
 * their edges) are already absent — the graph cannot leak a classified page.
 *
 * Nodes are coloured by classification rank (PUBLIC→green … STRICTLY→red).
 * Clicking a node selects that page in the right pane via `onSelectSlug`.
 */

import { useEffect, useMemo, useRef, useState, Suspense, lazy } from 'react'
import { Network } from 'lucide-react'
import { useApiQuery } from '@/hooks/useApi'

const ForceGraph2D = lazy(() =>
  import('react-force-graph-2d').then((m) => ({ default: m.default })),
)

// Classification rank → node colour (mirrors the seeded system levels).
export function rankColor(rank: number): string {
  if (rank <= 0) return '#22c55e' // PUBLIC
  if (rank <= 100) return '#3b82f6' // INTERNAL
  if (rank <= 200) return '#f59e0b' // CONFIDENTIAL
  return '#ef4444' // STRICTLY_CONFIDENTIAL
}

interface WikiGraphNode {
  id: string // slug
  label: string // title
  kind: string
  minRank: number
}
interface WikiGraphEdge {
  source: string
  target: string
  rel: string
}
interface WikiGraphResponse {
  nodes: WikiGraphNode[]
  edges: WikiGraphEdge[]
  nodeCount: number
  edgeCount: number
  truncated: boolean
}

export function WikiGraph({
  compilationId,
  activeSlug,
  onSelectSlug,
}: {
  compilationId: string
  activeSlug: string | null
  onSelectSlug: (slug: string) => void
}) {
  const { data, isLoading, error } = useApiQuery<WikiGraphResponse>(
    ['wiki', 'graph', compilationId],
    `/kg/compilations/${compilationId}/wiki-graph`,
    { enabled: !!compilationId },
  )

  const containerRef = useRef<HTMLDivElement | null>(null)
  const fgRef = useRef<{ zoomToFit?: (ms?: number, pad?: number) => void } | null>(null)
  const [dims, setDims] = useState({ width: 600, height: 520 })

  useEffect(() => {
    if (!containerRef.current) return
    const el = containerRef.current
    const apply = () => {
      const r = el.getBoundingClientRect()
      setDims({
        width: Math.max(200, Math.floor(r.width)),
        height: Math.max(300, Math.floor(r.height)),
      })
    }
    apply()
    const ro = new ResizeObserver(apply)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const graphData = useMemo(
    () => ({
      nodes: (data?.nodes ?? []).map((n) => ({ ...n })),
      links: (data?.edges ?? []).map((e) => ({ source: e.source, target: e.target })),
    }),
    [data],
  )

  // Fit to view once data is in.
  useEffect(() => {
    if (!graphData.nodes.length) return
    const t = setTimeout(() => fgRef.current?.zoomToFit?.(400, 40), 300)
    return () => clearTimeout(t)
  }, [graphData.nodes.length])

  return (
    <div
      ref={containerRef}
      className="relative h-full min-h-[300px] w-full overflow-hidden rounded-xl border border-slate-800 bg-slate-950"
    >
      {isLoading && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-slate-950/40">
          <div className="h-7 w-7 animate-spin rounded-full border-2 border-slate-700 border-t-blue-500" />
        </div>
      )}
      {error && (
        <div className="absolute inset-0 z-20 flex items-center justify-center text-xs text-red-400">
          Failed to load wiki graph.
        </div>
      )}
      {!isLoading && !error && graphData.nodes.length === 0 && (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 text-center">
          <Network size={26} className="text-slate-700" />
          <p className="text-xs text-slate-500">No pages to graph yet.</p>
        </div>
      )}

      <Suspense
        fallback={
          <div className="absolute inset-0 flex items-center justify-center text-xs text-slate-500">
            Loading graph…
          </div>
        }
      >
        <ForceGraph2D
          ref={fgRef as never}
          graphData={graphData}
          width={dims.width}
          height={dims.height}
          backgroundColor="#020617"
          minZoom={0.35}
          maxZoom={8}
          nodeRelSize={5}
          nodeLabel={(n: object) => (n as WikiGraphNode).label}
          nodeColor={
            ((n: WikiGraphNode) =>
              n.id === activeSlug ? '#ffffff' : rankColor(n.minRank)) as never
          }
          linkColor={() => 'rgba(71,85,105,0.4)'}
          linkDirectionalArrowLength={2.5}
          linkDirectionalArrowRelPos={0.95}
          onNodeClick={((n: WikiGraphNode) => onSelectSlug(n.id)) as never}
          cooldownTicks={120}
          nodeCanvasObjectMode={() => 'after'}
          nodeCanvasObject={
            ((node: object, ctx: CanvasRenderingContext2D, scale: number) => {
              const n = node as WikiGraphNode & { x?: number; y?: number }
              if (n.x == null || n.y == null) return
              const active = n.id === activeSlug
              // Only label the active node and (when zoomed in) all nodes.
              if (!active && scale < 1.6) return
              const fontSize = Math.max(3, 5 / Math.sqrt(scale))
              ctx.font = `${active ? 'bold ' : ''}${fontSize}px sans-serif`
              ctx.fillStyle = active ? '#ffffff' : 'rgba(203,213,225,0.75)'
              ctx.textAlign = 'center'
              ctx.textBaseline = 'top'
              const label = n.label.length > 28 ? n.label.slice(0, 27) + '…' : n.label
              ctx.fillText(label, n.x, n.y + 7)
            }) as never
          }
        />
      </Suspense>

      {data && (
        <div className="absolute bottom-2 left-2 z-10 rounded-md bg-slate-900/80 px-2 py-1 text-[10px] text-slate-400">
          {data.nodeCount} pages · {data.edgeCount} links
        </div>
      )}
    </div>
  )
}

export default WikiGraph
