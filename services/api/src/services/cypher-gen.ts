/**
 * Natural language to Cypher query generator.
 * Uses the configured LLM to translate user questions into Neo4j Cypher queries,
 * scoped to an optional compilation.
 */

import { runQuery } from './neo4j.js';
import { generateResponse, LLMConfig } from './llm.js';

export interface CypherResult {
  cypher: string;
  explanation: string;
}

// ─── Schema introspection ─────────────────────────────────────────────────────

interface GraphSchema {
  nodeLabels: string[];
  relationshipTypes: string[];
  propertyKeys: string[];
}

async function getGraphSchema(): Promise<GraphSchema> {
  try {
    const [labelsResult, relsResult, propsResult] = await Promise.all([
      runQuery('CALL db.labels() YIELD label RETURN collect(label) AS labels'),
      runQuery(
        'CALL db.relationshipTypes() YIELD relationshipType RETURN collect(relationshipType) AS types'
      ),
      runQuery(
        'CALL db.propertyKeys() YIELD propertyKey RETURN collect(propertyKey) AS keys'
      ),
    ]);

    const nodeLabels =
      (labelsResult.records[0]?.get('labels') as string[]) ?? [];
    const relationshipTypes =
      (relsResult.records[0]?.get('types') as string[]) ?? [];
    const propertyKeys =
      (propsResult.records[0]?.get('keys') as string[]) ?? [];

    return { nodeLabels, relationshipTypes, propertyKeys };
  } catch {
    // Fall back to documented schema if Neo4j is unavailable
    return {
      nodeLabels: ['Entity', 'Merged', 'Compilation'],
      relationshipTypes: [],
      propertyKeys: [
        'name',
        'type',
        'label',
        '_classification',
        '_owner',
        '_source_job',
        '_compilation',
        'uri',
      ],
    };
  }
}

// ─── Cypher validation ────────────────────────────────────────────────────────

/**
 * Basic syntax check: must start with MATCH/WITH/CALL/RETURN and contain RETURN.
 * Rejects queries that look like mutations.
 */
function validateCypher(cypher: string): { valid: boolean; reason?: string } {
  const trimmed = cypher.trim().toUpperCase();

  const mutationKeywords = ['CREATE ', 'MERGE ', 'DELETE ', 'REMOVE ', 'SET ', 'DROP '];
  for (const kw of mutationKeywords) {
    if (trimmed.includes(kw)) {
      return { valid: false, reason: `Mutation keyword '${kw.trim()}' is not allowed in RAG queries` };
    }
  }

  if (!trimmed.includes('RETURN')) {
    return { valid: false, reason: 'Query must contain a RETURN clause' };
  }

  const allowedStarters = ['MATCH', 'WITH', 'CALL', 'RETURN', 'OPTIONAL'];
  const startsOk = allowedStarters.some((kw) => trimmed.startsWith(kw));
  if (!startsOk) {
    return { valid: false, reason: 'Query must start with MATCH, WITH, CALL, or RETURN' };
  }

  return { valid: true };
}

/**
 * Strip markdown fences and extra whitespace that the LLM might add.
 */
function extractCypher(raw: string): string {
  // Remove ```cypher ... ``` or ``` ... ``` blocks
  const fenceMatch = raw.match(/```(?:cypher)?\s*([\s\S]+?)```/i);
  if (fenceMatch?.[1]) {
    return fenceMatch[1].trim();
  }
  // Return first non-empty line block that looks like Cypher
  return raw.trim();
}

// ─── Prompts ──────────────────────────────────────────────────────────────────

const CYPHER_SYSTEM_PROMPT = `You are a Neo4j Cypher query expert. Given the graph schema and user question, generate a Cypher query.

IMPORTANT - Entity data model:
- Entities have property "type" which stores Wikidata QIDs (e.g. "Q4830453" for business/company, "Q5" for human/person, "Q515" for city, "Q6256" for country)
- Entities have property "label" which stores the human-readable type name (e.g. "business", "human", "city", "entrepreneur")
- Entities have property "name" which is the entity's actual name (e.g. "Apple Inc.", "Steve Jobs")
- When the user asks about "companies", match on label = "business" or "company" (use toLower and CONTAINS)
- When the user asks about "people", match on label = "human" or "person" or "entrepreneur" etc.
- ALWAYS use the "label" property for type filtering, NOT "type" (which has QIDs)

Rules:
1. Always use MATCH patterns with RETURN
2. Use LIMIT to prevent huge result sets (max 50)
3. Use toLower() for name comparisons
4. Return n.name, n.label, n.type, and any relevant properties
5. For "all graphs" queries, don't filter by _compilation
6. For specific compilation queries, add WHERE n._compilation = $compilationId
7. Return ONLY the Cypher query, no explanation, no markdown fences.

Examples:
Q: What companies are there?
A: MATCH (n:Entity) WHERE toLower(n.label) CONTAINS 'business' OR toLower(n.label) CONTAINS 'company' RETURN n.name, n.label LIMIT 50

Q: Who is Steve Jobs?
A: MATCH (n:Entity) WHERE toLower(n.name) CONTAINS 'steve jobs' RETURN n.name, n.label, n.type LIMIT 10

Q: What is related to Apple?
A: MATCH (a:Entity)-[r]->(b:Entity) WHERE toLower(a.name) CONTAINS 'apple' RETURN a.name, type(r) AS relation, b.name, b.label LIMIT 50

Q: Show all entity types
A: MATCH (n:Entity) RETURN DISTINCT n.label AS type, count(*) AS count ORDER BY count DESC LIMIT 30`;

// ─── Public API ───────────────────────────────────────────────────────────────

export async function generateCypher(
  question: string,
  llmConfig: LLMConfig,
  compilationId?: string,
  allowedClassifications?: string[],
  entityHints?: string[],
): Promise<CypherResult> {
  const schema = await getGraphSchema();

  // Get sample entity labels so the LLM knows what types exist
  let entityLabels: string[] = [];
  try {
    const labelResult = await runQuery(
      'MATCH (n:Entity) RETURN DISTINCT n.label AS label LIMIT 30'
    );
    entityLabels = labelResult.records.map((r) => r.get('label') as string).filter(Boolean);
  } catch { /* non-fatal */ }

  const schemaDescription = [
    `Node labels: ${schema.nodeLabels.length > 0 ? schema.nodeLabels.join(', ') : 'Entity, Merged, Compilation'}`,
    `Entity type labels available: ${entityLabels.length > 0 ? entityLabels.join(', ') : 'business, human, city, country, technology, disease, etc.'}`,
    `Relationship types: ${schema.relationshipTypes.length > 0 ? schema.relationshipTypes.join(', ') : '[dynamic - extracted by RelEx]'}`,
    `Property keys: ${schema.propertyKeys.join(', ')}`,
  ].join('\n');

  const compilationFilter = compilationId
    ? `Filter by compilation: _compilation = "${compilationId}" (use parameter $compilationId)`
    : 'No compilation filter — query all graphs';

  const classificationNote = allowedClassifications?.length
    ? `Allowed classifications: ${allowedClassifications.join(', ')} (use parameter $allowedClassifications)`
    : 'No classification filter';

  const entityHintsNote =
    entityHints && entityHints.length > 0
      ? [
          ``,
          `The following entities were found in document context and likely exist in the graph:`,
          entityHints.join(', '),
          `Use these as anchors for your Cypher query. Try matching on these names.`,
        ].join('\n')
      : '';

  const userPrompt = [
    `Schema:`,
    schemaDescription,
    ``,
    `Compilation filter: ${compilationFilter}`,
    `Classification filter: ${classificationNote}`,
    entityHintsNote,
    ``,
    `Question: ${question}`,
  ].join('\n');

  const llmResponse = await generateResponse(
    llmConfig,
    CYPHER_SYSTEM_PROMPT,
    userPrompt
  );

  const rawCypher = extractCypher(llmResponse.content);
  const validation = validateCypher(rawCypher);

  if (!validation.valid) {
    // Fall back to a safe name-search query
    const fallback = compilationId
      ? `MATCH (n) WHERE n._compilation = $compilationId AND toLower(n.name) CONTAINS toLower($searchTerm) AND n._classification IN $allowedClassifications RETURN n.name AS name, n.type AS type, labels(n) AS labels LIMIT 20`
      : `MATCH (n) WHERE toLower(n.name) CONTAINS toLower($searchTerm) AND n._classification IN $allowedClassifications RETURN n.name AS name, n.type AS type, labels(n) AS labels LIMIT 20`;

    console.warn(
      `[CypherGen] Generated Cypher failed validation (${validation.reason}), using fallback`
    );

    return {
      cypher: fallback,
      explanation: `Fallback query (generated query was invalid: ${validation.reason})`,
    };
  }

  return {
    cypher: rawCypher,
    explanation: `Generated Cypher for: "${question}"`,
  };
}
