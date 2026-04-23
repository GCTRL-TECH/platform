/**
 * Graph trace service — extracts the graph structure used to answer a question.
 * Converts raw Neo4j QueryResult records into a frontend-renderable trace.
 */

import neo4j, { Node, Relationship, Path, Integer } from 'neo4j-driver';

export interface TraceNode {
  id: string;
  name: string;
  type: string;
  properties: Record<string, unknown>;
}

export interface TraceEdge {
  source: string;
  target: string;
  type: string;
}

export interface TracePath {
  description: string;
  confidence: number;
}

export interface GraphTrace {
  nodes: TraceNode[];
  edges: TraceEdge[];
  paths: TracePath[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isNeo4jNode(val: unknown): val is Node {
  return (
    typeof val === 'object' &&
    val !== null &&
    'identity' in val &&
    'labels' in val &&
    'properties' in val
  );
}

function isNeo4jRelationship(val: unknown): val is Relationship {
  return (
    typeof val === 'object' &&
    val !== null &&
    'identity' in val &&
    'type' in val &&
    'start' in val &&
    'end' in val
  );
}

function isNeo4jPath(val: unknown): val is Path {
  return (
    typeof val === 'object' &&
    val !== null &&
    'start' in val &&
    'end' in val &&
    'segments' in val
  );
}

function neo4jIdToString(id: Integer | number | string): string {
  if (typeof id === 'string') return id;
  if (typeof id === 'number') return String(id);
  // neo4j Integer
  return neo4j.integer.toString(id as Integer);
}

function sanitizeProperties(
  props: Record<string, unknown>
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(props)) {
    // Skip internal metadata fields except name/type/label
    if (key.startsWith('_') && !['_classification'].includes(key)) continue;
    // Convert Neo4j integers
    if (neo4j.isInt(val)) {
      result[key] = neo4j.integer.toNumber(val as Integer);
    } else {
      result[key] = val;
    }
  }
  return result;
}

function extractNode(node: Node): TraceNode {
  const props = node.properties as Record<string, unknown>;
  const name =
    (props['name'] as string) ||
    (props['label'] as string) ||
    (props['uri'] as string) ||
    neo4jIdToString(node.identity);

  const type =
    (props['type'] as string) || node.labels[0] || 'Unknown';

  return {
    id: neo4jIdToString(node.identity),
    name: String(name),
    type: String(type),
    properties: sanitizeProperties(props),
  };
}

function extractRelationship(rel: Relationship): TraceEdge {
  return {
    source: neo4jIdToString(rel.start),
    target: neo4jIdToString(rel.end),
    type: rel.type,
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function traceAnswer(
  _cypher: string,
  neo4jRecords: unknown[]
): Promise<GraphTrace> {
  const nodesMap = new Map<string, TraceNode>();
  const edgesMap = new Map<string, TraceEdge>();
  const paths: TracePath[] = [];

  for (const record of neo4jRecords) {
    if (
      typeof record !== 'object' ||
      record === null ||
      !('_fields' in record)
    ) {
      continue;
    }

    const fields = (record as { _fields: unknown[] })._fields;

    for (const field of fields) {
      // Direct node
      if (isNeo4jNode(field)) {
        const node = extractNode(field);
        nodesMap.set(node.id, node);
        continue;
      }

      // Direct relationship
      if (isNeo4jRelationship(field)) {
        const edge = extractRelationship(field);
        const edgeKey = `${edge.source}-${edge.type}-${edge.target}`;
        edgesMap.set(edgeKey, edge);
        continue;
      }

      // Path — walk segments
      if (isNeo4jPath(field)) {
        const path = field as Path;
        const pathNodes: string[] = [];

        // Start node
        const startNode = extractNode(path.start);
        nodesMap.set(startNode.id, startNode);
        pathNodes.push(startNode.name);

        for (const segment of path.segments) {
          const segEnd = extractNode(segment.end);
          nodesMap.set(segEnd.id, segEnd);

          const edge = extractRelationship(segment.relationship);
          const edgeKey = `${edge.source}-${edge.type}-${edge.target}`;
          edgesMap.set(edgeKey, edge);

          pathNodes.push(`-[${segment.relationship.type}]->`);
          pathNodes.push(segEnd.name);
        }

        if (pathNodes.length > 1) {
          paths.push({
            description: pathNodes.join(' '),
            confidence: 0.8,
          });
        }
        continue;
      }

      // Array of nodes/rels
      if (Array.isArray(field)) {
        for (const item of field) {
          if (isNeo4jNode(item)) {
            const node = extractNode(item);
            nodesMap.set(node.id, node);
          } else if (isNeo4jRelationship(item)) {
            const edge = extractRelationship(item);
            const edgeKey = `${edge.source}-${edge.type}-${edge.target}`;
            edgesMap.set(edgeKey, edge);
          }
        }
      }
    }
  }

  // If no explicit paths were extracted but we have nodes, create implicit path descriptions
  if (paths.length === 0 && nodesMap.size > 0) {
    const nodeList = Array.from(nodesMap.values());
    const confidence = Math.min(0.9, 0.5 + nodeList.length * 0.1);
    paths.push({
      description: `Found ${nodeList.length} relevant ${nodeList.length === 1 ? 'entity' : 'entities'}: ${nodeList
        .slice(0, 5)
        .map((n) => n.name)
        .join(', ')}${nodeList.length > 5 ? '...' : ''}`,
      confidence,
    });
  }

  return {
    nodes: Array.from(nodesMap.values()),
    edges: Array.from(edgesMap.values()),
    paths,
  };
}

/**
 * Calculate a confidence score based on Neo4j result richness.
 * Returns a value between 0 and 1.
 */
export function calculateConfidence(
  records: unknown[],
  queryHasCompilationFilter: boolean
): number {
  if (records.length === 0) return 0.1;

  const resultScore = Math.min(records.length / 10, 1.0); // 10+ results = full score
  const filterBonus = queryHasCompilationFilter ? 0.1 : 0; // scoped = slightly more confident
  const base = 0.5;

  return Math.min(1.0, base + resultScore * 0.4 + filterBonus);
}
