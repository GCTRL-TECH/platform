import { useParams, useNavigate } from 'react-router-dom'
import { ArrowLeft, AlertCircle, GitBranch } from 'lucide-react'
import { useApiQuery } from '@/hooks/useApi'

// ── Types ─────────────────────────────────────────────────────────────────────

interface LineageNode {
  id: string
  type: 'compilation' | 'job' | 'entity' | string
  label: string
  data?: Record<string, unknown>
}

interface LineageEdge {
  id: string
  source: string
  target: string
  label?: string
}

interface LineageData {
  nodes: LineageNode[]
  edges: LineageEdge[]
  compilationName?: string
}

// ── Color palette by node type ────────────────────────────────────────────────

const NODE_COLORS: Record<string, { fill: string; stroke: string; text: string }> = {
  compilation: { fill: '#4f46e5', stroke: '#6366f1', text: '#e0e7ff' },
  job:         { fill: '#1d4ed8', stroke: '#3b82f6', text: '#dbeafe' },
  entity:      { fill: '#b45309', stroke: '#f59e0b', text: '#fef3c7' },
}

function nodeColor(type: string) {
  return NODE_COLORS[type] ?? { fill: '#334155', stroke: '#64748b', text: '#e2e8f0' }
}

// ── Layout ────────────────────────────────────────────────────────────────────

interface LayoutNode {
  node: LineageNode
  x: number
  y: number
  width: number
  height: number
}

const NODE_W  = 180
const NODE_H  = 44
const COL_GAP = 120
const ROW_GAP = 60

/**
 * Very simple two-column layout:
 *   - Column 0 (left):  all nodes that appear as edge sources but NOT targets
 *                       (i.e. the "input" side — jobs / entities)
 *   - Column 1 (right): all nodes that appear as edge targets but NOT sources
 *                       (i.e. the "output" side — compilations)
 *   - Nodes that appear as both, or neither, fall in column 0.
 *
 * Within each column, nodes are stacked vertically, centred on the column.
 */
function computeLayout(nodes: LineageNode[], edges: LineageEdge[]): LayoutNode[] {
  const sourceIds = new Set(edges.map((e) => e.source))
  const targetIds = new Set(edges.map((e) => e.target))

  const col0: LineageNode[] = []
  const col1: LineageNode[] = []

  for (const n of nodes) {
    const isSrc = sourceIds.has(n.id)
    const isTgt = targetIds.has(n.id)
    if (isTgt && !isSrc) {
      col1.push(n)
    } else {
      col0.push(n)
    }
  }

  const maxRows = Math.max(col0.length, col1.length, 1)
  const svgH    = maxRows * (NODE_H + ROW_GAP)

  function colY(idx: number, total: number): number {
    const colH = total * NODE_H + (total - 1) * ROW_GAP
    const startY = (svgH - colH) / 2
    return startY + idx * (NODE_H + ROW_GAP)
  }

  const layout: LayoutNode[] = []

  col0.forEach((n, i) => {
    layout.push({ node: n, x: 0, y: colY(i, col0.length), width: NODE_W, height: NODE_H })
  })
  col1.forEach((n, i) => {
    layout.push({
      node: n,
      x: NODE_W + COL_GAP,
      y: colY(i, col1.length),
      width: NODE_W,
      height: NODE_H,
    })
  })

  return layout
}

// ── SVG DAG renderer ──────────────────────────────────────────────────────────

function LineageDAG({ nodes, edges }: { nodes: LineageNode[]; edges: LineageEdge[] }) {
  const navigate = useNavigate()
  const layout   = computeLayout(nodes, edges)
  const byId     = new Map(layout.map((l) => [l.node.id, l]))

  const svgW = NODE_W * 2 + COL_GAP + 40  // 40px padding
  const svgH = Math.max(
    layout.reduce((acc, l) => Math.max(acc, l.y + l.height), 0) + ROW_GAP,
    120
  )

  // Cubic bezier from right-centre of source to left-centre of target.
  function bezierPath(src: LayoutNode, tgt: LayoutNode): string {
    const x1 = src.x + src.width
    const y1 = src.y + src.height / 2
    const x2 = tgt.x
    const y2 = tgt.y + tgt.height / 2
    const cx  = (x1 + x2) / 2
    return `M ${x1} ${y1} C ${cx} ${y1}, ${cx} ${y2}, ${x2} ${y2}`
  }

  function handleNodeClick(n: LineageNode) {
    if (n.type === 'compilation' && n.data?.compilationId) {
      navigate(`/graphs/${n.data.compilationId as string}`)
    } else if (n.type === 'job' && n.data?.jobId) {
      navigate(`/kex/${n.data.jobId as string}`)
    }
  }

  return (
    <div className="overflow-x-auto">
      <svg
        viewBox={`-20 -20 ${svgW + 40} ${svgH + 40}`}
        width={svgW + 40}
        height={svgH + 40}
        className="block mx-auto"
        aria-label="Data lineage graph"
      >
        {/* Arrowhead marker */}
        <defs>
          <marker
            id="arrow"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill="#475569" />
          </marker>
        </defs>

        {/* Edges */}
        {edges.map((e) => {
          const src = byId.get(e.source)
          const tgt = byId.get(e.target)
          if (!src || !tgt) return null
          return (
            <g key={e.id}>
              <path
                d={bezierPath(src, tgt)}
                stroke="#475569"
                strokeWidth={1.5}
                fill="none"
                markerEnd="url(#arrow)"
                opacity={0.7}
              />
              {e.label && (
                <text
                  x={(src.x + src.width + tgt.x) / 2}
                  y={(src.y + src.height / 2 + tgt.y + tgt.height / 2) / 2 - 6}
                  textAnchor="middle"
                  fontSize={9}
                  fill="#64748b"
                >
                  {e.label}
                </text>
              )}
            </g>
          )
        })}

        {/* Nodes */}
        {layout.map(({ node, x, y, width, height }) => {
          const c           = nodeColor(node.type)
          const clickable   = node.type === 'compilation' || node.type === 'job'
          const truncated   = node.label.length > 22 ? node.label.slice(0, 20) + '…' : node.label

          return (
            <g
              key={node.id}
              transform={`translate(${x}, ${y})`}
              onClick={() => handleNodeClick(node)}
              style={{ cursor: clickable ? 'pointer' : 'default' }}
            >
              <rect
                width={width}
                height={height}
                rx={6}
                ry={6}
                fill={c.fill}
                stroke={c.stroke}
                strokeWidth={1.5}
                opacity={0.92}
              />
              {/* Type badge */}
              <rect x={0} y={0} width={width} height={14} rx={6} ry={6} fill={c.stroke} opacity={0.5} />
              <rect x={0} y={8} width={width} height={6} fill={c.stroke} opacity={0.5} />
              <text x={width / 2} y={10} textAnchor="middle" fontSize={8} fill={c.text} opacity={0.8}>
                {node.type.toUpperCase()}
              </text>
              {/* Label */}
              <text x={width / 2} y={30} textAnchor="middle" fontSize={11} fill={c.text} fontWeight={500}>
                {truncated}
              </text>
            </g>
          )
        })}
      </svg>
    </div>
  )
}

// ── Text-based fallback list ───────────────────────────────────────────────────

function LineageFallback({ nodes, edges }: { nodes: LineageNode[]; edges: LineageEdge[] }) {
  const byId = new Map(nodes.map((n) => [n.id, n]))

  // Find root nodes (not a target of any edge)
  const targetIds = new Set(edges.map((e) => e.target))
  const roots     = nodes.filter((n) => !targetIds.has(n.id))

  function renderChildren(nodeId: string, depth: number): React.ReactNode {
    const children = edges
      .filter((e) => e.source === nodeId)
      .map((e) => byId.get(e.target))
      .filter(Boolean) as LineageNode[]

    return children.map((child) => (
      <div key={child.id} style={{ paddingLeft: depth * 20 }} className="flex items-center gap-2 py-1">
        <GitBranch size={12} className="shrink-0 text-slate-500" />
        <span className="text-xs text-slate-400">
          <span className="font-mono text-slate-600">[{child.type}]</span>{' '}
          <span className="text-slate-200">{child.label}</span>
        </span>
        {renderChildren(child.id, depth + 1)}
      </div>
    ))
  }

  return (
    <div className="space-y-1 rounded-lg border border-slate-800 bg-slate-900/50 p-4 font-mono text-sm">
      {roots.map((root) => (
        <div key={root.id}>
          <div className="flex items-center gap-2 py-1">
            <GitBranch size={13} className="shrink-0 text-blue-400" />
            <span className="font-semibold text-slate-200">
              <span className="text-slate-500">[{root.type}]</span> {root.label}
            </span>
          </div>
          {renderChildren(root.id, 1)}
        </div>
      ))}
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function LineagePage() {
  const { id }    = useParams<{ id: string }>()
  const navigate  = useNavigate()

  const { data, isLoading, error } = useApiQuery<LineageData>(
    ['kg', 'compilations', id, 'lineage'],
    `/kg/compilations/${id}/lineage`,
    { enabled: !!id }
  )

  // ── Loading ──────────────────────────────────────────────────────────────────
  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-24">
        <span className="h-8 w-8 animate-spin rounded-full border-2 border-slate-700 border-t-blue-500" />
      </div>
    )
  }

  // ── Error ────────────────────────────────────────────────────────────────────
  if (error || !data) {
    return (
      <div className="flex flex-col items-center gap-4 py-24 text-center">
        <AlertCircle size={32} className="text-red-400" />
        <div>
          <p className="text-lg font-semibold text-slate-200">Could not load lineage</p>
          <p className="mt-1 text-sm text-slate-500">
            The compilation may not exist or you may not have access.
          </p>
        </div>
        <button onClick={() => navigate(`/graphs/${id}`)} className="btn-secondary">
          Back to Graph
        </button>
      </div>
    )
  }

  const { nodes, edges, compilationName } = data

  return (
    <div className="space-y-6 animate-slide-up">
      {/* Header */}
      <div className="flex items-center gap-3">
        <button
          onClick={() => navigate(`/graphs/${id}`)}
          className="btn-ghost text-slate-500 hover:text-slate-300"
        >
          <ArrowLeft size={16} />
        </button>
        <div>
          <h2 className="text-xl font-bold text-slate-100">Data Lineage</h2>
          {compilationName && (
            <p className="mt-0.5 text-sm text-slate-500">{compilationName}</p>
          )}
        </div>
      </div>

      {/* DAG or empty state */}
      {nodes.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-slate-800 py-16 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-slate-800">
            <GitBranch size={20} className="text-slate-600" />
          </div>
          <p className="text-sm text-slate-500">No lineage data available</p>
          <p className="text-xs text-slate-600">
            Run a KEX job and include it in this compilation to see its provenance here.
          </p>
        </div>
      ) : (
        <div className="card space-y-4">
          <div className="flex items-center justify-between border-b border-slate-800 pb-4">
            <div>
              <h3 className="text-sm font-semibold text-slate-200">Provenance Chain</h3>
              <p className="mt-0.5 text-xs text-slate-500">
                {nodes.length} node{nodes.length !== 1 ? 's' : ''} —{' '}
                {edges.length} edge{edges.length !== 1 ? 's' : ''}
              </p>
            </div>
            {/* Legend */}
            <div className="flex items-center gap-3">
              {Object.entries(NODE_COLORS).map(([type, c]) => (
                <div key={type} className="flex items-center gap-1.5">
                  <span
                    className="inline-block h-2.5 w-2.5 rounded-sm"
                    style={{ background: c.fill, border: `1px solid ${c.stroke}` }}
                  />
                  <span className="text-xs text-slate-500 capitalize">{type}</span>
                </div>
              ))}
            </div>
          </div>

          {/* SVG DAG — primary renderer */}
          <LineageDAG nodes={nodes} edges={edges} />

          {/* Text fallback always shown below for accessibility / copy-paste */}
          <details className="border-t border-slate-800 pt-4">
            <summary className="cursor-pointer text-xs text-slate-500 hover:text-slate-300 select-none">
              Text view
            </summary>
            <div className="mt-3">
              <LineageFallback nodes={nodes} edges={edges} />
            </div>
          </details>
        </div>
      )}
    </div>
  )
}
