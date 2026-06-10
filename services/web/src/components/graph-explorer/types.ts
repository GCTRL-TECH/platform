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
}

export interface GraphData {
  nodes: GraphNode[]
  edges: GraphEdge[]
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
}

export interface FGData {
  nodes: FGNode[]
  links: FGLink[]
}

export type ViewMode = '2d' | '3d'
export type ColorBy = 'type' | 'wikidata' | 'source'
export type SizeBy = 'degree' | 'uniform'

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
    source?: string
    createdAt?: string
  } | null
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
  entityMentions?: string[]
}

export interface ChunksResponse {
  chunks: ChunkRecord[]
  total: number
}
