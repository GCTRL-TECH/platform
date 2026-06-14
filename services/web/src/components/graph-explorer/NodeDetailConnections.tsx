/**
 * NodeDetailConnections tab — neighbors grouped by relation type.
 *
 * Pulls everything from the in-memory graph snapshot so this tab is instant.
 * Optional "Load more neighbors" button calls the parent's `mergeNeighbors`.
 *
 * Each connection can be CORRECTED: if a relationship is wrong (e.g. a
 * hallucinated `Fabio -[CO_FOUNDER_OF]-> Codex`), the trash control deletes it
 * from Neo4j and records the correction so re-extraction never re-introduces it
 * (DELETE /api/kg/relationship → "remember").
 */

import { useMemo, useState } from 'react'
import { ArrowRight, ArrowLeft, Network, Trash2, X, Check } from 'lucide-react'
import { api } from '@/lib/api'
import { getNodeColor } from './colors'
import type { ColorBy, GraphEdge, GraphNode } from './types'

interface NodeDetailConnectionsProps {
  entityName: string
  entityId: string | null
  compilationId: string
  nodes: GraphNode[]
  edges: GraphEdge[]
  colorBy: ColorBy
  onNavigateToEntity: (entityName: string) => void
  onLoadMoreNeighbors: () => Promise<void> | void
  /** Optional: notify the parent so it can splice the edge from the live canvas. */
  onEdgeRemoved?: (head: string, relType: string, tail: string) => void
}

interface Connection {
  direction: 'in' | 'out'
  relation: string
  neighbor: GraphNode
  /** Per-edge extraction confidence (0..1), surfaced from the graph endpoint. */
  confidence?: number | null
}

export function NodeDetailConnections({
  entityName,
  entityId,
  compilationId,
  nodes,
  edges,
  colorBy,
  onNavigateToEntity,
  onLoadMoreNeighbors,
  onEdgeRemoved,
}: NodeDetailConnectionsProps) {
  const [loadingMore, setLoadingMore] = useState(false)
  // Connections the user has corrected this session (key = `${head}|${rel}|${tail}`).
  const [removed, setRemoved] = useState<Set<string>>(new Set())
  // Which connection is in "confirm delete" mode + its optional reason.
  const [confirming, setConfirming] = useState<string | null>(null)
  const [reason, setReason] = useState('')
  const [deleting, setDeleting] = useState<string | null>(null)

  const grouped = useMemo(() => {
    if (!entityId) return new Map<string, Connection[]>()
    const nodeById = new Map(nodes.map((n) => [n.id, n]))
    const conns: Connection[] = []

    for (const e of edges) {
      if (e.source === entityId) {
        const neighbor = nodeById.get(e.target)
        if (neighbor) conns.push({ direction: 'out', relation: e.type, neighbor, confidence: e.confidence })
      } else if (e.target === entityId) {
        const neighbor = nodeById.get(e.source)
        if (neighbor) conns.push({ direction: 'in', relation: e.type, neighbor, confidence: e.confidence })
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

  // Resolve the directed (head, relType, tail) for a connection. For an outgoing
  // edge the current entity is the head; for an incoming edge it is the tail.
  function triple(c: Connection): { head: string; tail: string } {
    return c.direction === 'out'
      ? { head: entityName, tail: c.neighbor.label }
      : { head: c.neighbor.label, tail: entityName }
  }

  function connKey(c: Connection): string {
    const { head, tail } = triple(c)
    return `${head}|${c.relation}|${tail}`
  }

  async function confirmDelete(c: Connection) {
    const key = connKey(c)
    const { head, tail } = triple(c)
    setDeleting(key)
    try {
      await api.delete('/kg/relationship', {
        data: { compilationId, head, relType: c.relation, tail, reason: reason.trim() || undefined },
      })
      setRemoved((prev) => new Set(prev).add(key))
      onEdgeRemoved?.(head, c.relation, tail)
      setConfirming(null)
      setReason('')
    } catch {
      // leave the row; surface nothing destructive
    } finally {
      setDeleting(null)
    }
  }

  const relationKeys = Array.from(grouped.keys()).sort()
  const total = relationKeys.reduce((acc, k) => {
    const items = grouped.get(k) ?? []
    return acc + items.filter((c) => !removed.has(connKey(c))).length
  }, 0)

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
            const items = (grouped.get(rel) ?? []).filter((c) => !removed.has(connKey(c)))
            if (items.length === 0) return null
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
                    const key = connKey(c)
                    const isConfirming = confirming === key
                    return (
                      <li key={`${rel}-${c.neighbor.id}-${i}`} className="group">
                        <div className="flex items-center gap-1 pr-1.5 hover:bg-slate-800/50 transition-colors">
                          <button
                            onClick={() => onNavigateToEntity(c.neighbor.label)}
                            className="min-w-0 flex flex-1 items-center gap-2 px-3 py-2 text-left"
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
                            {typeof c.confidence === 'number' && (
                              <span
                                title={`Extraction confidence: ${(c.confidence * 100).toFixed(0)}%`}
                                className="ml-auto shrink-0 rounded px-1.5 py-0.5 text-[9px] font-mono tabular-nums"
                                style={{
                                  // amber (low) → emerald (high), matching the canvas edge encoding.
                                  color: `rgb(${Math.round(245 + (16 - 245) * c.confidence)}, ${Math.round(
                                    158 + (185 - 158) * c.confidence,
                                  )}, ${Math.round(11 + (129 - 11) * c.confidence)})`,
                                  backgroundColor: 'rgba(255,255,255,0.04)',
                                }}
                              >
                                {c.confidence.toFixed(2)}
                              </span>
                            )}
                          </button>
                          <button
                            onClick={() => {
                              setConfirming(isConfirming ? null : key)
                              setReason('')
                            }}
                            title="This connection is wrong — remove it & remember"
                            className="shrink-0 rounded-md p-1.5 text-slate-600 opacity-0 group-hover:opacity-100 hover:bg-rose-500/15 hover:text-rose-400 transition-all"
                          >
                            <Trash2 size={12} />
                          </button>
                        </div>
                        {isConfirming && (
                          <div className="border-t border-slate-800 bg-slate-900/60 px-3 py-2.5 space-y-2">
                            <p className="text-[11px] text-slate-400">
                              Permanently remove{' '}
                              <span className="font-mono text-slate-300">
                                {triple(c).head} —[{rel}]→ {triple(c).tail}
                              </span>{' '}
                              and remember the correction so it won&apos;t come back?
                            </p>
                            <input
                              value={reason}
                              onChange={(e) => setReason(e.target.value)}
                              placeholder="Reason (optional)"
                              className="w-full rounded-md border border-slate-700 bg-slate-800 px-2.5 py-1.5 text-[11px] text-slate-200 placeholder-slate-600 focus:border-rose-500/60 focus:outline-none"
                            />
                            <div className="flex items-center gap-2">
                              <button
                                onClick={() => void confirmDelete(c)}
                                disabled={deleting === key}
                                className="inline-flex items-center gap-1.5 rounded-md bg-rose-500/20 px-2.5 py-1.5 text-[11px] font-medium text-rose-300 hover:bg-rose-500/30 transition-colors disabled:opacity-50"
                              >
                                {deleting === key ? (
                                  <span className="h-3 w-3 animate-spin rounded-full border-2 border-rose-400/30 border-t-rose-400" />
                                ) : (
                                  <Check size={12} />
                                )}
                                Remove &amp; remember
                              </button>
                              <button
                                onClick={() => setConfirming(null)}
                                className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[11px] text-slate-400 hover:bg-slate-800 transition-colors"
                              >
                                <X size={12} /> Cancel
                              </button>
                            </div>
                          </div>
                        )}
                      </li>
                    )
                  })}
                </ul>
              </section>
            )
          })}
        </>
      )}

      {removed.size > 0 && (
        <p className="text-[10px] text-slate-600">
          {removed.size} connection{removed.size === 1 ? '' : 's'} corrected. Refresh the graph to
          update the canvas.
        </p>
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
