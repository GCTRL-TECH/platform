#!/usr/bin/env node
/**
 * GCTRL MCP Server
 *
 * Exposes GCTRL's knowledge management capabilities as MCP tools
 * so that Claude and other AI agents can:
 *   - Extract knowledge from text/files (KEX)
 *   - Query knowledge graphs (RAG)
 *   - Search entities and relationships
 *   - Manage compilations and ontologies
 *   - Store and retrieve structured knowledge
 *
 * Transport: stdio (for Claude Code / Claude Desktop integration)
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const API_BASE = process.env['GCTRL_API_URL'] || 'http://localhost:4000/api';
const GCTRL_EMAIL = process.env['GCTRL_EMAIL'] || 'admin@GCTRL.dev';
const GCTRL_PASSWORD = process.env['GCTRL_PASSWORD'] || 'GCTRL2026';

// ── Auto-authentication ──────────────────────────────────────────────────────

let _token = process.env['GCTRL_API_TOKEN'] || '';
let _tokenExpiry = 0;

async function getToken(): Promise<string> {
  // If we have a valid token with >60s remaining, reuse it
  if (_token && _tokenExpiry > Date.now() + 60000) {
    return _token;
  }

  // Auto-login with credentials
  try {
    const resp = await fetch(`${API_BASE}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: GCTRL_EMAIL, password: GCTRL_PASSWORD }),
    });
    if (resp.ok) {
      const data = (await resp.json()) as { token: string; refreshToken: string };
      _token = data.token;
      _tokenExpiry = Date.now() + 14 * 60 * 1000; // 14 min (token lasts 15)
      console.error('[GCTRL MCP] Authenticated successfully');
    }
  } catch (err) {
    console.error('[GCTRL MCP] Auth failed:', err);
  }
  return _token;
}

// ── API helper ───────────────────────────────────────────────────────────────

async function apiCall(
  method: string,
  path: string,
  body?: unknown,
): Promise<unknown> {
  const url = `${API_BASE}${path}`;
  const token = await getToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const resp = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`GCTRL API ${resp.status}: ${text}`);
  }

  return resp.json();
}

// ── Compilation linker ───────────────────────────────────────────────────────
// Fetches a compilation's current sourceJobIds, appends the new jobId, and PUTs it back.

async function appendJobToCompilation(compilationId: string, jobId: string): Promise<void> {
  const compilation = (await apiCall('GET', `/kg/compilations/${compilationId}`)) as {
    compilation: { sourceJobIds: string[] };
  };

  const existing = compilation.compilation.sourceJobIds ?? [];
  if (existing.includes(jobId)) {
    return; // Already linked
  }

  await apiCall('PUT', `/kg/compilations/${compilationId}`, {
    sourceJobIds: [...existing, jobId],
  });

  console.error(`[GCTRL MCP] Linked job ${jobId} to compilation ${compilationId}`);
}

// ── MCP Server ───────────────────────────────────────────────────────────────

const server = new McpServer({
  name: 'GCTRL',
  version: '0.1.0',
});

// ── Tool: Extract Knowledge (KEX) ────────────────────────────────────────────

server.tool(
  'GCTRL_extract',
  'Extract structured knowledge (entities, relations) from text. Creates a knowledge graph in Neo4j and vector embeddings in Qdrant. Use this to ingest new information into GCTRL. Specify a compilationId to add the results to a specific knowledge graph (e.g. an agent\'s dedicated graph).',
  {
    text: z.string().describe('The text content to extract knowledge from'),
    compilationId: z.string().optional().describe('Optional: target knowledge graph compilation ID. The extracted job will be auto-linked to this compilation. Use GCTRL_list_graphs to find IDs.'),
    ontologyId: z.string().optional().describe('Optional ontology ID to guide entity type extraction'),
    discoveryMode: z.enum(['strict', 'discover']).default('discover').describe('strict = only ontology types, discover = find all types and extend ontology'),
  },
  async ({ text, compilationId, ontologyId, discoveryMode }) => {
    const result = await apiCall('POST', '/kex/extract', {
      text,
      ontologyId,
      discoveryMode,
    }) as { jobId: string; status: string };

    // Wait for completion (poll)
    let job: { job: { status: string; result?: unknown; error?: string } };
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      job = (await apiCall('GET', `/kex/jobs/${result.jobId}`)) as typeof job;
      if (job.job.status === 'completed' || job.job.status === 'failed') {
        break;
      }
    }

    // Auto-link job to compilation if specified
    let linkedToCompilation = false;
    if (compilationId) {
      try {
        await appendJobToCompilation(compilationId, result.jobId);
        linkedToCompilation = true;
      } catch (err) {
        console.error(`[GCTRL MCP] Failed to link job ${result.jobId} to compilation ${compilationId}:`, err);
      }
    }

    const finalJob = (await apiCall('GET', `/kex/jobs/${result.jobId}/result`)) as Record<string, unknown>;

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          jobId: result.jobId,
          status: finalJob['status'] || 'completed',
          compilationId: compilationId || null,
          linkedToCompilation,
          entities: (finalJob['result'] as Record<string, unknown>)?.['entities'] || [],
          relations: (finalJob['result'] as Record<string, unknown>)?.['relations'] || [],
        }, null, 2),
      }],
    };
  },
);

// ── Tool: Query Knowledge Graph (RAG) ────────────────────────────────────────

server.tool(
  'GCTRL_query',
  'Ask a natural language question about the knowledge stored in GCTRL. Searches across Neo4j graph entities, Qdrant vector chunks, and optionally the web. Returns grounded answers with sources and confidence scores.',
  {
    question: z.string().describe('Natural language question about the knowledge graph'),
    compilationId: z.string().optional().describe('Optional: query a specific knowledge graph compilation. Omit to search all graphs.'),
  },
  async ({ question, compilationId }) => {
    const result = await apiCall('POST', '/rag/query', {
      message: question,
      mode: 'incognito',
      compilationId,
    }) as {
      answer: string;
      sources: Array<{ name: string; type: string; relevance: number; text?: string }>;
      confidence: number;
      cypher: string;
    };

    return {
      content: [{
        type: 'text' as const,
        text: `**Answer** (${Math.round(result.confidence * 100)}% confidence):\n\n${result.answer}\n\n**Sources:**\n${result.sources.map((s) => `- [${s.type}] ${s.name} (${Math.round(s.relevance * 100)}%)`).join('\n')}\n\n**Cypher used:** \`${result.cypher}\``,
      }],
    };
  },
);

// ── Tool: Search Entities ────────────────────────────────────────────────────

server.tool(
  'GCTRL_search_entities',
  'Search for specific entities in the knowledge graph by name or type. Returns matching entities with their properties and relationships.',
  {
    query: z.string().describe('Search term (entity name or partial match)'),
    entityType: z.string().optional().describe('Filter by entity type label (e.g. "company", "person", "technology")'),
    limit: z.number().default(20).describe('Maximum results to return'),
  },
  async ({ query, entityType, limit }) => {
    // Use RAG with a specific Cypher-oriented question
    const result = await apiCall('POST', '/rag/query', {
      message: `Find all entities matching "${query}"${entityType ? ` of type ${entityType}` : ''}`,
      mode: 'incognito',
    }) as { answer: string; sources: unknown[]; cypher: string };

    return {
      content: [{
        type: 'text' as const,
        text: `${result.answer}\n\n_Cypher: ${result.cypher}_`,
      }],
    };
  },
);

// ── Tool: List Knowledge Graphs ──────────────────────────────────────────────

server.tool(
  'GCTRL_list_graphs',
  'List all knowledge graph compilations available in GCTRL. Shows name, entity count, relation count, and classification level.',
  {},
  async () => {
    const result = await apiCall('GET', '/kg/compilations') as {
      compilations: Array<{
        id: string;
        name: string;
        entityCount: number;
        edgeCount: number;
        classification: string;
        sourceJobIds: string[];
      }>;
    };

    const lines = result.compilations.map((c) =>
      `- **${c.name}** (${c.entityCount} entities, ${c.edgeCount} relations) [${c.classification}] — ID: ${c.id}`
    );

    return {
      content: [{
        type: 'text' as const,
        text: lines.length > 0
          ? `**Knowledge Graphs:**\n\n${lines.join('\n')}`
          : 'No knowledge graphs found. Use GCTRL_extract to create one.',
      }],
    };
  },
);

// ── Tool: Fuse Knowledge Graphs ──────────────────────────────────────────────

server.tool(
  'GCTRL_fuse',
  'Merge multiple extraction jobs into a unified knowledge graph. Uses entity matching to find duplicates across sources and creates a consolidated graph.',
  {
    name: z.string().describe('Name for the new fused knowledge graph'),
    sourceJobIds: z.array(z.string()).describe('Array of KEX job IDs to merge'),
    description: z.string().optional().describe('Optional description'),
  },
  async ({ name, sourceJobIds, description }) => {
    const result = await apiCall('POST', '/fuse/merge', {
      name,
      sourceJobIds,
      description,
    }) as { compilationId: string; jobId: string; status: string };

    return {
      content: [{
        type: 'text' as const,
        text: `Fusion job started:\n- Job ID: ${result.jobId}\n- Compilation ID: ${result.compilationId}\n- Status: ${result.status}\n\nUse GCTRL_query to ask questions about this graph once processing completes.`,
      }],
    };
  },
);

// ── Tool: List Ontologies ────────────────────────────────────────────────────

server.tool(
  'GCTRL_list_ontologies',
  'List all ontologies available in GCTRL. Ontologies define entity types and matching rules for knowledge extraction.',
  {},
  async () => {
    const result = await apiCall('GET', '/ontologies') as {
      ontologies: Array<{
        id: string;
        name: string;
        scope: string;
        entityTypeCount: number;
      }>;
    };

    const lines = result.ontologies.map((o) =>
      `- **${o.name}** (${o.entityTypeCount} types) [${o.scope}] — ID: ${o.id}`
    );

    return {
      content: [{
        type: 'text' as const,
        text: lines.length > 0
          ? `**Ontologies:**\n\n${lines.join('\n')}`
          : 'No ontologies found.',
      }],
    };
  },
);

// ── Tool: List Extraction Jobs ───────────────────────────────────────────────

server.tool(
  'GCTRL_list_extractions',
  'List recent knowledge extraction jobs with their status, entity counts, and source info.',
  {
    limit: z.number().default(10).describe('Maximum jobs to return'),
  },
  async ({ limit }) => {
    const result = await apiCall('GET', '/kex/jobs') as {
      jobs: Array<{
        id: string;
        type: string;
        status: string;
        input?: Record<string, unknown>;
        result?: Record<string, unknown>;
        createdAt: string;
      }>;
    };

    const jobs = result.jobs.slice(0, limit);
    const lines = jobs.map((j) => {
      const name = (j.input?.['originalFilename'] as string) || (j.input?.['text'] as string)?.slice(0, 40) || j.id.slice(0, 8);
      const entities = (j.result?.['entities'] as unknown[])?.length || '?';
      return `- [${j.status}] **${name}** — ${entities} entities — ID: ${j.id}`;
    });

    return {
      content: [{
        type: 'text' as const,
        text: `**Extraction Jobs (${jobs.length}):**\n\n${lines.join('\n')}`,
      }],
    };
  },
);

// ── Tool: Store Knowledge (extract from agent context) ───────────────────────

server.tool(
  'GCTRL_store',
  'Store information into GCTRL by extracting knowledge from the provided text. This is the primary way for agents to persist knowledge — like saving notes to Obsidian but with automatic entity extraction and graph construction. IMPORTANT: Always specify a compilationId to store into a specific knowledge graph (e.g. your agent\'s dedicated graph). Use GCTRL_list_graphs to find the right compilation ID.',
  {
    text: z.string().describe('Text content to store as knowledge'),
    title: z.string().optional().describe('Optional title/label for this knowledge'),
    compilationId: z.string().optional().describe('Target knowledge graph compilation ID. RECOMMENDED: always specify this to store into the correct agent graph. Use GCTRL_list_graphs to find IDs.'),
    ontologyId: z.string().optional().describe('Optional ontology to guide extraction'),
  },
  async ({ text, title, compilationId, ontologyId }) => {
    const fullText = title ? `${title}\n\n${text}` : text;

    const result = await apiCall('POST', '/kex/extract', {
      text: fullText,
      ontologyId,
      discoveryMode: 'discover',
    }) as { jobId: string };

    // Wait briefly for extraction to complete, then link to compilation
    let linkedToCompilation = false;
    if (compilationId) {
      // Poll until job completes (max ~90s)
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 3000));
        const job = (await apiCall('GET', `/kex/jobs/${result.jobId}`)) as { job: { status: string } };
        if (job.job.status === 'completed' || job.job.status === 'failed') {
          break;
        }
      }

      try {
        await appendJobToCompilation(compilationId, result.jobId);
        linkedToCompilation = true;
      } catch (err) {
        console.error(`[GCTRL MCP] Failed to link job ${result.jobId} to compilation ${compilationId}:`, err);
      }
    }

    const targetInfo = compilationId
      ? `\n- Linked to compilation: ${compilationId} (${linkedToCompilation ? 'success' : 'FAILED - check logs'})`
      : '\n- WARNING: No compilationId specified — entities are floating unlinked. Use GCTRL_list_graphs to find the right compilation ID.';

    return {
      content: [{
        type: 'text' as const,
        text: `Knowledge stored! Extraction job ${result.jobId} is processing.\nThe text will be:\n- Chunked and embedded in Qdrant (for semantic search)\n- Entity-extracted into Neo4j (for graph queries)${targetInfo}\n- Available via GCTRL_query once complete`,
      }],
    };
  },
);

// ── Tool: Get Graph Schema ───────────────────────────────────────────────────

server.tool(
  'GCTRL_schema',
  'Get the schema of the knowledge graph — available entity types, relationship types, and property keys. Useful for understanding what data is stored.',
  {},
  async () => {
    const result = await apiCall('POST', '/rag/query', {
      message: 'Show all entity types and their counts',
      mode: 'incognito',
    }) as { answer: string; cypher: string };

    return {
      content: [{
        type: 'text' as const,
        text: result.answer,
      }],
    };
  },
);

// ── Start server ─────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('GCTRL MCP Server running on stdio');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});

