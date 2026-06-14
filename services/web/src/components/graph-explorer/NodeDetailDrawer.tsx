/**
 * NodeDetailDrawer — Obsidian-style slide-over for a selected entity.
 *
 * Portaled to document.body so the outer canvas container can keep its
 * `overflow-hidden` if needed without clipping the drawer.
 */

import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { Copy, X, Check } from 'lucide-react'
import { useApiQuery } from '@/hooks/useApi'
import { cn } from '@/lib/utils'
import { getNodeColor, resolveTypeLabel } from './colors'
import { NodeDetailOverview } from './NodeDetailOverview'
import { NodeDetailChunks } from './NodeDetailChunks'
import { NodeDetailConnections } from './NodeDetailConnections'
import { NodeDetailSource } from './NodeDetailSource'
import type {
  ColorBy,
  EntityDetailResponse,
  GraphEdge,
  GraphNode,
} from './types'

type DrawerTab = 'overview' | 'chunks' | 'connections' | 'source'

const TABS: { id: DrawerTab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'chunks', label: 'Chunks' },
  { id: 'connections', label: 'Connections' },
  { id: 'source', label: 'Source' },
]

interface NodeDetailDrawerProps {
  compilationId: string
  entityName: string
  open: boolean
  onClose: () => void
  onNavigateToEntity: (entityName: string) => void
  onLoadMoreNeighbors: () => Promise<void> | void
  nodes: GraphNode[]
  edges: GraphEdge[]
  colorBy: ColorBy
}

export function NodeDetailDrawer({
  compilationId,
  entityName,
  open,
  onClose,
  onNavigateToEntity,
  onLoadMoreNeighbors,
  nodes,
  edges,
  colorBy,
}: NodeDetailDrawerProps) {
  const [tab, setTab] = useState<DrawerTab>('overview')
  const [copied, setCopied] = useState(false)

  // Reset tab whenever the selected entity changes.
  useEffect(() => {
    setTab('overview')
  }, [entityName])

  // Esc to close.
  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [open, onClose])

  const { data: detailData, isLoading: detailLoading } =
    useApiQuery<EntityDetailResponse>(
      ['kg', 'compilations', compilationId, 'entity', entityName],
      `/kg/compilations/${encodeURIComponent(compilationId)}/entity/${encodeURIComponent(
        entityName,
      )}`,
      { enabled: open && !!entityName },
    )

  const detail = detailData?.entity ?? null

  // Resolve local node (the live one mutated by the simulation).
  const localNode = useMemo<GraphNode | null>(() => {
    if (!entityName) return null
    return (
      nodes.find((n) => n.label === entityName) ??
      nodes.find((n) => n.id === entityName) ??
      null
    )
  }, [nodes, entityName])

  const headerNode: GraphNode = localNode ?? {
    id: detail?.id ?? entityName,
    label: detail?.label ?? entityName,
    type: detail?.type ?? 'Entity',
    properties: detail?.properties ?? {},
  }

  const color = getNodeColor(headerNode, colorBy)
  const typeLabel = resolveTypeLabel(headerNode)

  // Compute local in/out/neighbor counts from the in-memory edges.
  const localCounts = useMemo(() => {
    let inDeg = 0
    let outDeg = 0
    const neighbors = new Set<string>()
    const id = localNode?.id ?? entityName
    for (const e of edges) {
      if (e.source === id) {
        outDeg++
        neighbors.add(e.target)
      } else if (e.target === id) {
        inDeg++
        neighbors.add(e.source)
      }
    }
    return { inDeg, outDeg, neighborCount: neighbors.size }
  }, [edges, localNode, entityName])

  const inDegree = detail?.inDegree ?? localCounts.inDeg
  const outDegree = detail?.outDegree ?? localCounts.outDeg
  const neighborCount = localCounts.neighborCount

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(entityName)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // ignore
    }
  }

  if (typeof document === 'undefined') return null

  return createPortal(
    <>
      {/* Backdrop */}
      <div
        className={cn(
          'fixed inset-0 z-40 bg-slate-950/40 backdrop-blur-[1px] transition-opacity duration-300',
          open ? 'opacity-100' : 'opacity-0 pointer-events-none',
        )}
        onClick={onClose}
      />

      {/* Drawer */}
      <aside
        className={cn(
          'fixed inset-y-0 right-0 z-50 w-full lg:w-1/2 max-w-3xl',
          'border-l border-slate-800 bg-slate-950 shadow-2xl',
          'flex flex-col',
          'transition-transform duration-300 ease-out',
          open ? 'translate-x-0' : 'translate-x-full',
        )}
        role="dialog"
        aria-modal="true"
        aria-label={`Entity details: ${entityName}`}
      >
        {/* Header */}
        <header className="flex items-start gap-3 border-b border-slate-800 px-4 py-3">
          <span
            className="mt-1.5 h-3 w-3 rounded-full shrink-0"
            style={{ backgroundColor: color }}
          />
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-sm font-semibold text-slate-100">
              {entityName}
            </h2>
            <p className="mt-0.5 text-[10px] uppercase tracking-wide text-slate-500 capitalize">
              {typeLabel}
            </p>
          </div>
          <button
            onClick={handleCopy}
            title="Copy entity name"
            className="rounded-md p-1.5 text-slate-500 hover:bg-slate-800 hover:text-slate-200 transition-colors"
          >
            {copied ? <Check size={13} className="text-emerald-400" /> : <Copy size={13} />}
          </button>
          <button
            onClick={onClose}
            title="Close (Esc)"
            className="rounded-md p-1.5 text-slate-500 hover:bg-slate-800 hover:text-slate-200 transition-colors"
          >
            <X size={14} />
          </button>
        </header>

        {/* Stats strip */}
        <div className="grid grid-cols-4 gap-1 border-b border-slate-800 bg-slate-900/40 px-4 py-2.5 text-center">
          <div>
            <p className="text-[9px] uppercase tracking-wide text-slate-500">In</p>
            <p className="text-sm font-semibold text-slate-100 tabular-nums">
              {inDegree}
            </p>
          </div>
          <div>
            <p className="text-[9px] uppercase tracking-wide text-slate-500">Out</p>
            <p className="text-sm font-semibold text-slate-100 tabular-nums">
              {outDegree}
            </p>
          </div>
          <div>
            <p className="text-[9px] uppercase tracking-wide text-slate-500">Chunks</p>
            <p className="text-sm font-semibold text-slate-100 tabular-nums">
              {detail?.chunkCount ?? '—'}
            </p>
          </div>
          <div>
            <p className="text-[9px] uppercase tracking-wide text-slate-500">
              Neighbors
            </p>
            <p className="text-sm font-semibold text-slate-100 tabular-nums">
              {neighborCount}
            </p>
          </div>
        </div>

        {/* Tabs */}
        <nav className="flex border-b border-slate-800 px-2 bg-slate-950">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={cn(
                'px-3 py-2 text-xs font-medium border-b-2 transition-colors',
                tab === t.id
                  ? 'border-indigo-500 text-indigo-300'
                  : 'border-transparent text-slate-500 hover:text-slate-300',
              )}
            >
              {t.label}
            </button>
          ))}
        </nav>

        {/* Tab body */}
        <div className="flex-1 overflow-y-auto px-4 py-4">
          {tab === 'overview' && (
            <NodeDetailOverview
              entityName={entityName}
              detail={detail}
              localNode={localNode}
              colorBy={colorBy}
              inDegree={inDegree}
              outDegree={outDegree}
              neighborCount={neighborCount}
            />
          )}
          {tab === 'chunks' && (
            <NodeDetailChunks
              entityName={entityName}
              compilationId={compilationId}
              enabled={open && tab === 'chunks'}
              onNavigateToEntity={onNavigateToEntity}
            />
          )}
          {tab === 'connections' && (
            <NodeDetailConnections
              entityName={entityName}
              entityId={localNode?.id ?? null}
              compilationId={compilationId}
              nodes={nodes}
              edges={edges}
              colorBy={colorBy}
              onNavigateToEntity={onNavigateToEntity}
              onLoadMoreNeighbors={onLoadMoreNeighbors}
            />
          )}
          {tab === 'source' && (
            <NodeDetailSource
              detail={detail}
              isLoading={detailLoading}
              entityName={entityName}
              compilationId={compilationId}
              enabled={open && tab === 'source'}
              onNavigateToEntity={onNavigateToEntity}
            />
          )}
        </div>
      </aside>
    </>,
    document.body,
  )
}
