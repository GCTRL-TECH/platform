/**
 * Shared types for the Visual Graph Explorer module.
 *
 * GraphNode / GraphEdge match the backend `node_to_json` shape:
 *   - id:        Neo4j internal node id (string)
 *   - label:     human-friendly name (KEX writes "Acme Corp", etc.)
 *   - type:      Neo4j label (currently always "Entity")
 *   - properties: free-form bag — `label` ("person"), `type` ("Q5"), etc.
 */

export interface GraphNode {
  id: string
  label: string
  type: string
  properties: Record<string, unknown>
}

export interface GraphEdge {
  source: string
  target: string
  type: string
  /** Per-edge extraction confidence (0..1), written by KEX relex. May be null
   *  for edges from sources that predate confidence scoring or for manual edges. */
  confidence?: number | null
}

export interface GraphData {
  nodes: GraphNode[]
  edges: GraphEdge[]
  /** TRUE total node count in scope (not just the returned subset). Present on
   *  the /graph endpoint; optional because neighbor-merge responses omit it. */
  nodeCount?: number
  /** TRUE total edge count in scope. */
  edgeCount?: number
  /** True when the returned nodes/edges are a degree-ordered subset of the whole. */
  truncated?: boolean
}

// react-force-graph mutates simulation fields onto node objects in place.
export interface FGNode extends GraphNode {
  x?: number
  y?: number
  z?: number
  vx?: number
  vy?: number
  vz?: number
}

export interface FGLink {
  source: string | FGNode
  target: string | FGNode
  type: string
  /** Per-edge confidence (0..1) carried through so the canvas can encode it as
   *  edge width/opacity. Undefined/null → rendered at a neutral baseline. */
  confidence?: number | null
}

export interface FGData {
  nodes: FGNode[]
  links: FGLink[]
}

export type ViewMode = '2d' | '3d'
export type ColorBy = 'type' | 'wikidata' | 'source'
export type SizeBy = 'degree' | 'uniform'

// A precise, entity-uri-grounded source chunk (P2a — grounded nodes). Unlike
// the broad name/ILIKE-matched `ChunkRecord` list below, each of these is
// guaranteed to actually mention this specific graph node (not just its name).
export interface GroundingChunk {
  id: string
  snippet: string
  sourceDocumentId?: string | null
  jobId?: string | null
  createdAt?: string | null
}

// Endpoint B response: GET /kg/compilations/:id/entity/:name
export interface EntityDetail {
  id: string
  name: string
  label?: string
  type?: string
  properties: Record<string, unknown>
  inDegree: number
  outDegree: number
  chunkCount: number
  lastSourceJob?: {
    id: string
    type?: string
    source?: string
    createdAt?: string
  } | null
  groundingChunks?: GroundingChunk[]
}

export interface EntityDetailResponse {
  entity: EntityDetail
}

// Endpoint A response: GET /kex/chunks?entity=&compilationId=&limit=20
export interface ChunkRecord {
  id: string
  content: string
  sourceJobId?: string
  source?: string
  createdAt?: string
  // The backend returns objects ({text,label,type,…}), not strings — callers must
  // normalize to a display name before rendering. Typed loosely on purpose.
  entityMentions?: Array<string | { text?: string; name?: string; label?: string }>
}

export interface ChunksResponse {
  chunks: ChunkRecord[]
  total: number
}
