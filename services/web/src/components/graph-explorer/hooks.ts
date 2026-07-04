/**
 * Hooks shared across the Graph Explorer.
 *
 *   - useGraphData      ─ TanStack-Query cached graph + neighbor-merge mutator
 *   - useGraphMetrics   ─ degree map + node-radius helper + present types
 *   - useFocusMode      ─ hover/click focus highlighting
 */

import { useCallback, useMemo } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { apiGet } from '@/lib/api'
import { resolveTypeLabel } from './colors'
import type { GraphData, GraphEdge, GraphNode } from './types'

// ─── useGraphData ──────────────────────────────────────────────────────────────

const GRAPH_KEY = (compilationId: string) =>
  ['kg', 'compilations', compilationId, 'graph'] as const

interface UseGraphDataResult {
  nodes: GraphNode[]
  edges: GraphEdge[]
  /** TRUE total node count in scope (falls back to rendered count if absent). */
  nodeCount: number
  /** TRUE total edge count in scope. */
  edgeCount: number
  /** True when the canvas is showing a degree-ordered subset of the whole graph. */
  truncated: boolean
  isLoading: boolean
  error: Error | null
  mergeNeighbors: (entityName: string) => Promise<void>
  refetch: () => void
}

export function useGraphData(compilationId: string): UseGraphDataResult {
  const queryClient = useQueryClient()
  const key = GRAPH_KEY(compilationId)

  const query = useQuery<GraphData, Error>({
    queryKey: key,
    // Pull the WHOLE graph (degree-ordered; API ceiling 50000 — Wave 2 raised
    // this from 20000 now that the canvas degrades render quality adaptively
    // instead of leaning on a small server-side cap). The canvas shows every
    // node and bounds the on-screen density via zoom/pan + the adaptive
    // quality governor rather than a server truncation, so nothing is hidden
    // from exploration. A large payload can take a while over a slow
    // connection, so this call gets its own generous timeout.
    queryFn: () =>
      apiGet<GraphData>(`/kg/compilations/${compilationId}/graph?limit=50000`, { timeout: 120_000 }),
    staleTime: 60_000,
  })

  const mergeNeighbors = useCallback(
    async (entityName: string) => {
      try {
        const data = await apiGet<GraphData>(
          `/kg/graph/entity/${encodeURIComponent(entityName)}/neighbors?depth=1&limit=50`,
        )
        const newNodes = data.nodes ?? []
        const newEdges = data.edges ?? []

        queryClient.setQueryData<GraphData>(key, (prev) => {
          const base: GraphData = prev ?? { nodes: [], edges: [] }
          const existingIds = new Set(base.nodes.map((n) => n.id))
          const mergedNodes = [...base.nodes]
          for (const n of newNodes) {
            if (!existingIds.has(n.id)) {
              mergedNodes.push(n)
              existingIds.add(n.id)
            }
          }
          const edgeKey = (e: GraphEdge) => `${e.source}:${e.target}:${e.type}`
          const existingEdges = new Set(base.edges.map(edgeKey))
          const mergedEdges = [...base.edges]
          for (const e of newEdges) {
            const k = edgeKey(e)
            if (!existingEdges.has(k)) {
              mergedEdges.push(e)
              existingEdges.add(k)
            }
          }
          // Preserve the true totals from the original /graph response. Bump them
          // if a merge surfaced a node/edge the first page didn't include, so the
          // "showing N of M" counter never claims fewer than what's on screen.
          const nodeCount = Math.max(base.nodeCount ?? 0, mergedNodes.length)
          const edgeCount = Math.max(base.edgeCount ?? 0, mergedEdges.length)
          return {
            nodes: mergedNodes,
            edges: mergedEdges,
            nodeCount,
            edgeCount,
            truncated: mergedNodes.length < nodeCount || mergedEdges.length < edgeCount,
          }
        })
      } catch {
        // silent — neighbor merges are best-effort
      }
    },
    [key, queryClient],
  )

  const nodes = query.data?.nodes ?? []
  const edges = query.data?.edges ?? []
  return {
    nodes,
    edges,
    // Fall back to the rendered length when the server omitted a total (e.g. a
    // cache seeded purely from a neighbor merge) so callers always get a number.
    nodeCount: query.data?.nodeCount ?? nodes.length,
    edgeCount: query.data?.edgeCount ?? edges.length,
    truncated: query.data?.truncated ?? false,
    isLoading: query.isLoading,
    error: query.error ?? null,
    mergeNeighbors,
    refetch: () => void query.refetch(),
  }
}

// ─── useGraphMetrics ───────────────────────────────────────────────────────────

export interface GraphMetrics {
  degreeMap: Map<string, number>
  inDegreeMap: Map<string, number>
  outDegreeMap: Map<string, number>
  maxDegree: number
  minDegree: number
  presentTypes: Set<string>
  getRadius: (node: GraphNode) => number
  getDegree: (id: string) => number
}

export function useGraphMetrics(
  nodes: GraphNode[],
  edges: GraphEdge[],
): GraphMetrics {
  return useMemo(() => {
    const degreeMap = new Map<string, number>()
    const inDegreeMap = new Map<string, number>()
    const outDegreeMap = new Map<string, number>()

    for (const n of nodes) {
      degreeMap.set(n.id, 0)
      inDegreeMap.set(n.id, 0)
      outDegreeMap.set(n.id, 0)
    }
    for (const e of edges) {
      degreeMap.set(e.source, (degreeMap.get(e.source) ?? 0) + 1)
      degreeMap.set(e.target, (degreeMap.get(e.target) ?? 0) + 1)
      outDegreeMap.set(e.source, (outDegreeMap.get(e.source) ?? 0) + 1)
      inDegreeMap.set(e.target, (inDegreeMap.get(e.target) ?? 0) + 1)
    }

    let maxDegree = 0
    let minDegree = nodes.length > 0 ? Infinity : 0
    for (const d of degreeMap.values()) {
      if (d > maxDegree) maxDegree = d
      if (d < minDegree) minDegree = d
    }
    if (minDegree === Infinity) minDegree = 0

    const presentTypes = new Set<string>()
    for (const n of nodes) presentTypes.add(resolveTypeLabel(n))

    const getDegree = (id: string) => degreeMap.get(id) ?? 0

    const getRadius = (node: GraphNode) => {
      const deg = getDegree(node.id)
      const r = 2 + Math.sqrt(deg) * 2
      return Math.max(2, Math.min(18, r))
    }

    return {
      degreeMap,
      inDegreeMap,
      outDegreeMap,
      maxDegree,
      minDegree,
      presentTypes,
      getRadius,
      getDegree,
    }
  }, [nodes, edges])
}

// ─── useFocusMode ──────────────────────────────────────────────────────────────

export interface FocusInfo {
  focusedSet: Set<string>
  isFaded: (node: GraphNode | { id: string }) => boolean
  edgeIsFaded: (edge: GraphEdge | { source: string | { id: string }; target: string | { id: string } }) => boolean
}

function endpointId(v: string | { id: string }): string {
  return typeof v === 'string' ? v : v.id
}

export function useFocusMode(
  edges: GraphEdge[],
  focusId: string | null,
): FocusInfo {
  return useMemo(() => {
    if (!focusId) {
      const empty = new Set<string>()
      return {
        focusedSet: empty,
        isFaded: () => false,
        edgeIsFaded: () => false,
      }
    }

    const focusedSet = new Set<string>([focusId])
    for (const e of edges) {
      if (e.source === focusId) focusedSet.add(e.target)
      else if (e.target === focusId) focusedSet.add(e.source)
    }

    return {
      focusedSet,
      isFaded: (node: GraphNode | { id: string }) => !focusedSet.has(node.id),
      edgeIsFaded: (edge: GraphEdge | { source: string | { id: string }; target: string | { id: string } }) => {
        const s = endpointId(edge.source)
        const t = endpointId(edge.target)
        return !focusedSet.has(s) || !focusedSet.has(t)
      },
    }
  }, [edges, focusId])
}
