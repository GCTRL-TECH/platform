/**
 * NodeDetailConnections tab — neighbors grouped by relation type.
 *
 * Pulls everything from the in-memory graph snapshot so this tab is instant.
 * Optional "Load more neighbors" button calls the parent's `mergeNeighbors`.
 */

import { useMemo, useState } from 'react'
import { ArrowRight, ArrowLeft, Network } from 'lucide-react'
import { getNodeColor } from './colors'
import type { ColorBy, GraphEdge, GraphNode } from './types'

interface NodeDetailConnectionsProps {
  entityName: string
  entityId: string | null
  nodes: GraphNode[]
  edges: GraphEdge[]
  colorBy: ColorBy
  onNavigateToEntity: (entityName: string) => void
  onLoadMoreNeighbors: () => Promise<void> | void
}

interface Connection {
  direction: 'in' | 'out'
  relation: string
  neighbor: GraphNode
}

export function NodeDetailConnections({
  entityName,
  entityId,
  nodes,
  edges,
  colorBy,
  onNavigateToEntity,
  onLoadMoreNeighbors,
}: NodeDetailConnectionsProps) {
  const [loadingMore, setLoadingMore] = useState(false)

  const grouped = useMemo(() => {
    if (!entityId) return new Map<string, Connection[]>()
    const nodeById = new Map(nodes.map((n) => [n.id, n]))
    const conns: Connection[] = []

    for (const e of edges) {
      if (e.source === entityId) {
        const neighbor = nodeById.get(e.target)
        if (neighbor) conns.push({ direction: 'out', relation: e.type, neighbor })
      } else if (e.target === entityId) {
        const neighbor = nodeById.get(e.source)
        if (neighbor) conns.push({ direction: 'in', relation: e.type, neighbor })
      }
    }

    const map = new Map<string, Connection[]>()
    for (const c of conns) {
      const arr = map.get(c.relation) ?? []
      arr.push(c)
      map.set(c.relation, arr)
    }
    return map
  }, [entityId, nodes, edges])

  async function handleLoadMore() {
    setLoadingMore(true)
    try {
      await onLoadMoreNeighbors()
    } finally {
      setLoadingMore(false)
    }
  }

  const relationKeys = Array.from(grouped.keys()).sort()
  const total = relationKeys.reduce((acc, k) => acc + (grouped.get(k)?.length ?? 0), 0)

  return (
    <div className="space-y-4">
      {total === 0 ? (
        <div className="flex flex-col items-center justify-center gap-2 py-8 text-center">
          <Network size={22} className="text-slate-700" />
          <p className="text-sm text-slate-500">
            No connections yet in the local graph view.
          </p>
        </div>
      ) : (
        <>
          <p className="text-[10px] uppercase tracking-wide text-slate-500">
            {total} connection{total === 1 ? '' : 's'} across {relationKeys.length}{' '}
            relation{relationKeys.length === 1 ? '' : 's'}
          </p>
          {relationKeys.map((rel) => {
            const items = grouped.get(rel) ?? []
            return (
              <section key={rel}>
                <header className="mb-1.5 flex items-center gap-2">
                  <span className="inline-flex items-center rounded-md border border-slate-700 bg-slate-800/60 px-2 py-0.5 text-[10px] font-mono uppercase tracking-wide text-slate-300">
                    {rel}
                  </span>
                  <span className="text-[10px] text-slate-600 tabular-nums">
                    {items.length}
                  </span>
                </header>
                <ul className="divide-y divide-slate-800 rounded-lg border border-slate-800 overflow-hidden">
                  {items.map((c, i) => {
                    const color = getNodeColor(c.neighbor, colorBy)
                    return (
                      <li key={`${rel}-${c.neighbor.id}-${i}`}>
                        <button
                          onClick={() => onNavigateToEntity(c.neighbor.label)}
                          className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-slate-800/50 transition-colors"
                        >
                          {c.direction === 'out' ? (
                            <ArrowRight size={11} className="text-slate-500 shrink-0" />
                          ) : (
                            <ArrowLeft size={11} className="text-slate-500 shrink-0" />
                          )}
                          <span
                            className="h-2 w-2 rounded-full shrink-0"
                            style={{ backgroundColor: color }}
                          />
                          <span className="truncate text-xs text-slate-200">
                            {c.neighbor.label}
                          </span>
                        </button>
                      </li>
                    )
                  })}
                </ul>
              </section>
            )
          })}
        </>
      )}

      <button
        onClick={handleLoadMore}
        disabled={loadingMore}
        className="w-full flex items-center justify-center gap-2 rounded-lg border border-indigo-500/40 bg-indigo-500/10 px-3 py-2 text-xs font-medium text-indigo-300 hover:bg-indigo-500/20 transition-colors disabled:opacity-50"
      >
        {loadingMore ? (
          <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-indigo-400/30 border-t-indigo-400" />
        ) : (
          <Network size={13} />
        )}
        Load more neighbors of {entityName.length > 24 ? entityName.slice(0, 24) + '…' : entityName}
      </button>
    </div>
  )
}
