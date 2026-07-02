#!/usr/bin/env node
/**
 * Ground Control (GCTRL) MCP Server
 *
 * Exposes Ground Control's knowledge management capabilities as MCP tools
 * so that Claude and other AI agents can:
 *   - Extract knowledge from text/files (KEX)
 *   - Query knowledge graphs (RAG)
 *   - Search entities and relationships
 *   - Manage compilations and ontologies
 *   - Store and retrieve structured knowledge
 *
 * Transport: stdio (for Claude Code / Claude Desktop integration)
 *
 * Tool naming
 * ───────────
 * Primary tool names use the `gctrl_*` prefix. The legacy `borghive_*`
 * names are also registered as DEPRECATED aliases for backwards compat
 * with existing `.mcp.json` configs. The aliases log a warning on each
 * invocation and will be removed in v2.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const API_BASE = process.env['GCTRL_API_URL'] || 'http://localhost:4000/api';
const GCTRL_EMAIL = process.env['GCTRL_EMAIL'] || 'admin@gctrl.tech';
const GCTRL_PASSWORD = process.env['GCTRL_PASSWORD'] || 'GCTRL2026';

// ── Authentication ─────────────────────────────────────────────────────────--
//
// Preferred: a scoped GCTRL Access Token (gctrl_…), created on the Access
// Control page with a clearance level + optional per-graph grants. Sent as
// `Authorization: ApiKey …`, it limits this MCP server (and any agent behind
// it) to exactly the data the token is allowed to see — least privilege.
//
// Fallback (dev/legacy): email + password → short-lived JWT (`Bearer …`),
// which inherits the full user's clearance. Avoid in production.
const SCOPED_TOKEN = process.env['GCTRL_API_TOKEN'] || '';

// ── Remote mode ──────────────────────────────────────────────────────────────--
//
// When GCTRL_GATEWAY_URL is set (e.g. https://host/api/agent/mcp), this stdio
// server stops registering its own local tools and instead becomes a thin proxy
// to the remote MCP-over-HTTP gateway, forwarding `tools/list` / `tools/call`
// with the scoped Access Token. This lets a local MCP client (Claude Desktop /
// Code) reach a networked GCTRL harness without changing how it's configured.
// When unset, the existing local/direct behavior below is used unchanged.
const GATEWAY_URL = process.env['GCTRL_GATEWAY_URL'] || '';

/** JSON-RPC call to the remote gateway, authed with the scoped Access Token. */
async function gatewayRpc(method: string, params?: unknown): Promise<unknown> {
  const resp = await fetch(GATEWAY_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(SCOPED_TOKEN ? { Authorization: `ApiKey ${SCOPED_TOKEN}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`GCTRL gateway ${resp.status}: ${text}`);
  }
  const data = (await resp.json()) as { result?: unknown; error?: { message: string } };
  if (data.error) {
    throw new Error(`GCTRL gateway RPC error: ${data.error.message}`);
  }
  return data.result;
}

let _token = '';
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
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (SCOPED_TOKEN) {
    // Scoped access token — clearance + grants enforced server-side.
    headers['Authorization'] = `ApiKey ${SCOPED_TOKEN}`;
  } else {
    const token = await getToken();
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }
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

// Surfaced to the connecting model by MCP clients: how to use the memory layers
// and the write-back discipline (the point of GCTRL).
const GCTRL_INSTRUCTIONS =
  "GCTRL is your long-term memory. READ the right layer (gctrl_get_dossier = HOT/authoritative — state it, don't hedge; gctrl_query = blended answer; gctrl_search_entities/get_neighbors/shortest_path = graph; gctrl_wiki_page = curated prose). After ANY substantive task, WRITE your conclusions back with gctrl_store/gctrl_extract into your assigned compilationId (find it via gctrl_list_graphs) so future sessions inherit them — that write-back habit is the point of GCTRL. Your token is scoped: you only see and write the knowledge bases you're granted; call gctrl_list_graphs first.";

const server = new McpServer(
  {
    name: 'gctrl',
    version: '1.0.0',
  },
  { instructions: GCTRL_INSTRUCTIONS },
);

// ── Deprecation helper ───────────────────────────────────────────────────────
// Registers a tool under both its primary `gctrl_*` name and the legacy
// `borghive_*` alias. The alias path logs a warning to stderr and will be
// removed in v2.

// We need a tight type for the handler since @modelcontextprotocol/sdk's
// `tool()` is heavily overloaded. The signature mirrors what server.tool
// accepts for shape-style schemas.
type ToolHandler<TArgs> = (args: TArgs) => Promise<{
  content: Array<{ type: 'text'; text: string }>;
}>;

function registerToolWithAlias<TArgs>(
  newName: string,
  oldName: string,
  description: string,
  schema: z.ZodRawShape,
  handler: ToolHandler<TArgs>,
): void {
  // In remote mode the local tools are replaced by gateway passthroughs
  // (registered in main()), so skip the built-in direct-API tools entirely.
  if (GATEWAY_URL) {
    return;
  }

  // Primary (canonical) name — new gctrl_* form.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (server.tool as any)(newName, description, schema, handler);

  // DEPRECATED — remove in v2. Legacy borghive_* alias kept for backwards
  // compat with existing `.mcp.json` configs.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (server.tool as any)(
    oldName,
    `[DEPRECATED — use '${newName}' instead, alias will be removed in v2] ${description}`,
    schema,
    async (args: TArgs) => {
      console.error(
        `[GCTRL MCP] Tool name '${oldName}' is deprecated and will be removed in v2. Use '${newName}'.`,
      );
      return handler(args);
    },
  );
}

// ── Tool: Extract Knowledge (KEX) ────────────────────────────────────────────

const extractSchema = {
  text: z.string().describe('The text content to extract knowledge from'),
  compilationId: z.string().optional().describe('Optional: target knowledge graph compilation ID. The extracted job will be auto-linked to this compilation. Use gctrl_list_graphs to find IDs.'),
  ontologyId: z.string().optional().describe('Optional ontology ID to guide entity type extraction'),
  discoveryMode: z.enum(['strict', 'discover']).default('discover').describe('strict = only ontology types, discover = find all types and extend ontology'),
};

registerToolWithAlias<{
  text: string;
  compilationId?: string;
  ontologyId?: string;
  discoveryMode: 'strict' | 'discover';
}>(
  'gctrl_extract',
  'borghive_extract',
  'Extract structured knowledge (entities, relations) from text. Creates a knowledge graph in Neo4j and vector embeddings in Qdrant. Use this to ingest new information into Ground Control. Specify a compilationId to add the results to a specific knowledge graph (e.g. an agent\'s dedicated graph).',
  extractSchema,
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

const querySchema = {
  question: z.string().describe('Natural language question about the knowledge graph'),
  compilationId: z.string().optional().describe('Optional: query a specific knowledge graph compilation. Omit to search all graphs.'),
};

registerToolWithAlias<{ question: string; compilationId?: string }>(
  'gctrl_query',
  'borghive_query',
  'Ask a natural-language question — GCTRL blends ALL memory layers automatically (HOT dossiers > graph facts > warm chunks) and returns a grounded answer with sources + confidence. Prefer this for open questions; then persist any new conclusion with gctrl_store.',
  querySchema,
  async ({ question, compilationId }) => {
    const result = await apiCall('POST', '/rag/query', {
      message: question,
      mode: 'incognito',
      compilationId,
    }) as {
      answer: string;
      sources: Array<{ chunkId: string; source?: string; score?: number; text?: string; entityMentions?: string[] }>;
      confidence: number;
      cypher: string;
    };

    const sourceLines = result.sources.map((s) => {
      const label =
        (s.source && s.source.trim()) ||
        (s.entityMentions && s.entityMentions.length ? s.entityMentions.slice(0, 3).join(', ') : '') ||
        (s.text ? `${s.text.slice(0, 60).trim()}…` : '') ||
        s.chunkId;
      const pct = typeof s.score === 'number' ? `${Math.round(s.score * 100)}%` : '—';
      return `- ${label} (${pct})`;
    });

    return {
      content: [{
        type: 'text' as const,
        text: `**Answer** (${Math.round(result.confidence * 100)}% confidence):\n\n${result.answer}\n\n**Sources:**\n${sourceLines.join('\n')}\n\n**Cypher used:** \`${result.cypher}\``,
      }],
    };
  },
);

// ── Tool: Search Entities ────────────────────────────────────────────────────

const searchEntitiesSchema = {
  query: z.string().describe('Search term (entity name or partial match)'),
  entityType: z.string().optional().describe('Filter by entity type label (e.g. "company", "person", "technology")'),
  limit: z.number().default(20).describe('Maximum results to return'),
};

registerToolWithAlias<{ query: string; entityType?: string; limit: number }>(
  'gctrl_search_entities',
  'borghive_search_entities',
  'Search for specific entities in the knowledge graph by name or type. Returns matching entities with their properties and relationships.',
  searchEntitiesSchema,
  async ({ query, entityType }) => {
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

// ── Tool: Get Entity Dossier (HOT memory, A2) ────────────────────────────────

const getDossierSchema = {
  name: z.string().describe('The entity name to fetch the dossier for (e.g. "Fabio", "Ground Control")'),
};

registerToolWithAlias<{ name: string }>(
  'gctrl_get_dossier',
  'borghive_get_dossier',
  'Read the AUTHORITATIVE entity dossier (the HOT memory tier) for a named entity: a compiled summary, key facts (with confidence), origin files and a timeline. This is the highest-trust source — when a dossier exists it directly answers "who/what is X" and "where does X come from", with no hedging. Built on-the-fly if missing.',
  getDossierSchema,
  async ({ name }) => {
    const d = await apiCall('GET', `/kg/dossier?name=${encodeURIComponent(name)}`) as {
      entityName: string;
      summary: string;
      keyFacts: Array<{ rel: string; target: string; direction?: string; confidence?: number }>;
      originFiles: string[];
      timeline: Array<{ date: string; fact: string }>;
      trust: number;
      pinned: boolean;
    };

    const factLines = (d.keyFacts || []).slice(0, 20).map((f) => {
      const arrow = f.direction === 'in' ? '←' : '→';
      const conf = typeof f.confidence === 'number' ? ` (conf ${f.confidence.toFixed(2)})` : '';
      return `- ${d.entityName} ${f.rel.replace(/_/g, ' ').toLowerCase()} ${arrow} ${f.target}${conf}`;
    });
    const tlLines = (d.timeline || []).slice(0, 10).map((t) => `- ${t.fact}`);
    const origin = (d.originFiles || []).join(', ') || '—';

    return {
      content: [{
        type: 'text' as const,
        text:
          `**Dossier: ${d.entityName}**${d.pinned ? ' 📌 pinned' : ''} (trust ${d.trust.toFixed(2)}, AUTHORITATIVE)\n\n` +
          `${d.summary}\n\n` +
          `**Key facts:**\n${factLines.join('\n') || '—'}\n\n` +
          (tlLines.length ? `**Timeline:**\n${tlLines.join('\n')}\n\n` : '') +
          `**Origin files:** ${origin}`,
      }],
    };
  },
);

// ── Tool: List Knowledge Graphs ──────────────────────────────────────────────

registerToolWithAlias<Record<string, never>>(
  'gctrl_list_graphs',
  'borghive_list_graphs',
  'List all knowledge graph compilations available in Ground Control. Shows name, entity count, relation count, and classification level.',
  {},
  async () => {
    const result = await apiCall('GET', '/kg/compilations') as {
      compilations: Array<{
        id: string;
        name: string;
        nodeCount: number;
        edgeCount: number;
        classification: string;
        sourceJobIds: string[];
      }>;
    };

    const lines = result.compilations.map((c) =>
      `- **${c.name}** (${c.nodeCount} entities, ${c.edgeCount} relations) [${c.classification}] — ID: ${c.id}`
    );

    return {
      content: [{
        type: 'text' as const,
        text: lines.length > 0
          ? `**Knowledge Graphs:**\n\n${lines.join('\n')}`
          : 'No knowledge graphs found. Use gctrl_extract to create one.',
      }],
    };
  },
);

// ── Tool: Fuse Knowledge Graphs ──────────────────────────────────────────────

const fuseSchema = {
  name: z.string().describe('Name for the new fused knowledge graph'),
  sourceJobIds: z.array(z.string()).describe('Array of KEX job IDs to merge'),
  description: z.string().optional().describe('Optional description'),
};

registerToolWithAlias<{ name: string; sourceJobIds: string[]; description?: string }>(
  'gctrl_fuse',
  'borghive_fuse',
  'Merge multiple extraction jobs into a unified knowledge graph. Uses entity matching to find duplicates across sources and creates a consolidated graph.',
  fuseSchema,
  async ({ name, sourceJobIds, description }) => {
    const result = await apiCall('POST', '/fuse/merge', {
      name,
      sourceJobIds,
      description,
    }) as { compilationId: string; jobId: string; status: string };

    return {
      content: [{
        type: 'text' as const,
        text: `Fusion job started:\n- Job ID: ${result.jobId}\n- Compilation ID: ${result.compilationId}\n- Status: ${result.status}\n\nUse gctrl_query to ask questions about this graph once processing completes.`,
      }],
    };
  },
);

// ── Tool: Distill WIKI Compilation ───────────────────────────────────────────

const distillSchema = {
  compilationId: z.string().describe('The WIKI compilation ID to distill into wiki pages. Must be a compilation of type WIKI (created with a wikiSourceCompilationId).'),
  limit: z.number().optional().describe('Max number of entity pages to generate (default 15). Higher = slower (one LLM call per entity).'),
};

registerToolWithAlias<{ compilationId: string; limit?: number }>(
  'gctrl_distill',
  'borghive_distill',
  'Distill a WIKI compilation into human-readable wiki pages — one markdown page per important entity, grounded on the source RAW graph and its text chunks, with [[wikilinks]] between related entities and a Sources section. Returns how many pages were written.',
  distillSchema,
  async ({ compilationId, limit }) => {
    const result = await apiCall('POST', `/kg/compilations/${compilationId}/distill`,
      limit !== undefined ? { limit } : {}) as {
        pages_written?: number;
        pages_created?: number;
        pages_updated?: number;
        pages_unchanged?: number;
        entities_considered?: number;
        compilation_id?: string;
      };

    return {
      content: [{
        type: 'text' as const,
        text: `Distillation complete for compilation ${result.compilation_id ?? compilationId}:\n` +
          `- Pages written: ${result.pages_written ?? 0}\n` +
          `- Created: ${result.pages_created ?? 0}, Updated: ${result.pages_updated ?? 0}, Unchanged: ${result.pages_unchanged ?? 0}\n` +
          `- Entities considered: ${result.entities_considered ?? 0}\n\n` +
          `Use gctrl_wiki_page to read the generated pages.`,
      }],
    };
  },
);

// ── Tool: Read WIKI Page(s) ──────────────────────────────────────────────────

const wikiPageSchema = {
  compilationId: z.string().describe('The WIKI compilation ID.'),
  slug: z.string().optional().describe('Slug of a specific page to fetch (e.g. "fabio-chiaramonte"). Omit to list all pages.'),
  query: z.string().optional().describe('Optional: when no slug is given, filter the listed pages whose title contains this text.'),
};

registerToolWithAlias<{ compilationId: string; slug?: string; query?: string }>(
  'gctrl_wiki_page',
  'borghive_wiki_page',
  'Read distilled wiki pages from a WIKI compilation. Pass a slug to fetch one full page (markdown body + citations); omit the slug to list all pages (optionally filtered by query).',
  wikiPageSchema,
  async ({ compilationId, slug, query }) => {
    if (slug) {
      const page = await apiCall('GET', `/kg/compilations/${compilationId}/wiki/${slug}`) as {
        slug: string; title: string; kind: string; bodyMd: string;
        citations: Array<{ chunkId?: string; source?: string; text_snippet?: string }>;
        version: number; lastDistilledAt: string;
      };
      const cites = (page.citations ?? []).map((c, i) =>
        `[${i + 1}] ${c.text_snippet ?? ''} (${c.source ?? c.chunkId ?? '—'})`).join('\n');
      return {
        content: [{
          type: 'text' as const,
          text: `# ${page.title} (v${page.version})\n\n${page.bodyMd}\n\n---\n**Citations:**\n${cites || '(none)'}`,
        }],
      };
    }

    const list = await apiCall('GET', `/kg/compilations/${compilationId}/wiki`) as {
      pages: Array<{ slug: string; title: string; kind: string; entityUri?: string; lastDistilledAt: string }>;
    };
    let pages = list.pages ?? [];
    if (query) {
      const q = query.toLowerCase();
      pages = pages.filter((p) => p.title.toLowerCase().includes(q));
    }
    const lines = pages.map((p) => `- **${p.title}** (${p.kind}) — slug: \`${p.slug}\``);
    return {
      content: [{
        type: 'text' as const,
        text: pages.length > 0
          ? `**Wiki Pages (${pages.length}):**\n\n${lines.join('\n')}\n\nUse gctrl_wiki_page with a slug to read one.`
          : 'No wiki pages found. Run gctrl_distill first.',
      }],
    };
  },
);

// ── Tool: Search Chunks (RAG retrieval — mirrors HTTP gateway search_chunks) ──

const searchChunksSchema = {
  query: z.string().describe('The question or topic to retrieve source text passages for'),
  compilationId: z.string().optional().describe('Optional: scope to a specific knowledge graph compilation'),
};

registerToolWithAlias<{ query: string; compilationId?: string }>(
  'gctrl_search_chunks',
  'borghive_search_chunks',
  'Retrieve source text passages (warm vector + keyword) for a question — the raw evidence layer. Limit is fixed at 5 passages. Use this to back up an answer with citations; prefer gctrl_query for a composed blended answer.',
  searchChunksSchema,
  async ({ query, compilationId }) => {
    const r = await apiCall('POST', '/agent/tools/search_chunks', { query, compilationId }) as {
      chunks?: Array<{ chunkId?: string; text?: string; score?: number; source?: string }>;
      error?: string;
    };
    if (r.error) return { content: [{ type: 'text' as const, text: `Error: ${r.error}` }] };
    const chunks = r.chunks ?? [];
    const lines = chunks.map((c, i) => {
      const score = typeof c.score === 'number' ? ` (${Math.round(c.score * 100)}%)` : '';
      const src = c.source ? ` [${c.source}]` : '';
      return `[${i + 1}]${src}${score}\n${c.text ?? ''}`;
    });
    return {
      content: [{
        type: 'text' as const,
        text: lines.length > 0
          ? `**Source passages (${lines.length}):**\n\n${lines.join('\n\n---\n\n')}`
          : 'No passages found for this query.',
      }],
    };
  },
);

// ── Tool: Get Entity (provenance — mirrors HTTP gateway get_entity) ────────────

const getEntitySchema = {
  name: z.string().describe('Entity name to look up (exact or close match)'),
};

registerToolWithAlias<{ name: string }>(
  'gctrl_get_entity',
  'borghive_get_entity',
  'Read one entity: its type, connections (up to 20 relation strings), and full provenance — origin file, sourceRef, extraction job + timestamp. Use this to answer "where does X come from / which file / what is the source of X". Prefer gctrl_get_dossier for a compiled authoritative summary.',
  getEntitySchema,
  async ({ name }) => {
    const r = await apiCall('POST', '/agent/tools/get_entity', { name }) as {
      name?: string;
      type?: string;
      classification?: string;
      connections?: string[];
      provenance?: {
        jobId?: string;
        jobType?: string;
        originFile?: string;
        sourceRef?: string;
        extractedAt?: string;
      };
      error?: string;
    };
    if (r.error) return { content: [{ type: 'text' as const, text: `Error: ${r.error}` }] };
    const provLines: string[] = [];
    if (r.provenance?.originFile) provLines.push(`Origin file: ${r.provenance.originFile}`);
    if (r.provenance?.sourceRef) provLines.push(`Source ref: ${r.provenance.sourceRef}`);
    if (r.provenance?.extractedAt) provLines.push(`Extracted at: ${r.provenance.extractedAt}`);
    if (r.provenance?.jobId) provLines.push(`Job ID: ${r.provenance.jobId}`);
    const connLines = (r.connections ?? []).map((c) => `- ${c}`);
    return {
      content: [{
        type: 'text' as const,
        text:
          `**Entity: ${r.name ?? name}** (${r.type ?? 'unknown type'})` +
          (r.classification ? ` [${r.classification}]` : '') +
          '\n\n' +
          (connLines.length ? `**Connections:**\n${connLines.join('\n')}\n\n` : '') +
          (provLines.length ? `**Provenance:**\n${provLines.join('\n')}` : '(no provenance on record)'),
      }],
    };
  },
);

// ── Tool: Graph neighbours (dependency tracing) ──────────────────────────────

registerToolWithAlias<{ name: string; depth?: number }>(
  'gctrl_get_neighbors',
  'borghive_get_neighbors',
  'List entities within N hops of a node — dependency tracing across the knowledge graph (great for code graphs: "what does X touch?"). Clearance-filtered: only nodes you are cleared for are returned.',
  { name: z.string().describe('Entity name to expand from'), depth: z.number().optional().describe('Hops to expand (1-3, default 1)') },
  async ({ name, depth }) => {
    const r = await apiCall('POST', '/agent/tools/get_neighbors', { name, depth }) as { neighbors?: Array<{ name: string; type?: string; hops?: number }>; error?: string };
    if (r.error) return { content: [{ type: 'text' as const, text: `Error: ${r.error}` }] };
    const lines = (r.neighbors ?? []).map((n) => `- ${n.name}${n.type ? ` (${n.type})` : ''}${n.hops != null ? ` · ${n.hops} hop(s)` : ''}`);
    return { content: [{ type: 'text' as const, text: lines.length ? `Neighbours of ${name}:\n${lines.join('\n')}` : `No neighbours found for ${name}.` }] };
  },
);

// ── Tool: Shortest path between two entities ──────────────────────────────────

registerToolWithAlias<{ from: string; to: string }>(
  'gctrl_shortest_path',
  'borghive_shortest_path',
  'Find the shortest path between two entities (how is A connected to B / does X depend on Y). Clearance-aware: a path is only returned if every node on it is one you are cleared to see.',
  { from: z.string().describe('Start entity name'), to: z.string().describe('End entity name') },
  async ({ from, to }) => {
    const r = await apiCall('POST', '/agent/tools/shortest_path', { from, to }) as { found?: boolean; path?: string[]; relations?: string[]; hops?: number; error?: string };
    if (r.error) return { content: [{ type: 'text' as const, text: `Error: ${r.error}` }] };
    if (!r.found) return { content: [{ type: 'text' as const, text: `No path found between ${from} and ${to} (within your clearance).` }] };
    return { content: [{ type: 'text' as const, text: `Path (${r.hops} hops): ${(r.path ?? []).join(' → ')}` }] };
  },
);

// ── Tool: List classification conflicts ───────────────────────────────────────

registerToolWithAlias<Record<string, never>>(
  'gctrl_list_conflicts',
  'borghive_list_conflicts',
  'List open classification conflicts — entities whose sources disagree on sensitivity (≥2 distinct clearance ranks). Useful for governance / compliance review.',
  {},
  async () => {
    const r = await apiCall('POST', '/agent/tools/list_conflicts', {}) as { conflicts?: unknown[]; error?: string };
    if (r.error) return { content: [{ type: 'text' as const, text: `Error: ${r.error}` }] };
    return { content: [{ type: 'text' as const, text: JSON.stringify(r.conflicts ?? [], null, 2) }] };
  },
);

// ── Tool: Detect communities + god-nodes (B2) ─────────────────────────────────

registerToolWithAlias<{ compilationId: string }>(
  'gctrl_detect_communities',
  'borghive_detect_communities',
  'Run community detection + centrality on a graph: clusters related entities (Louvain), flags the most-central "god nodes", and tags every node with its community/centrality. Returns the cluster summary. Owner action; respects KB-scoped tokens.',
  { compilationId: z.string().describe('The compilation (graph) ID to analyse') },
  async ({ compilationId }) => {
    const r = await apiCall('POST', `/kg/compilations/${compilationId}/communities`, {}) as {
      communityCount?: number; nodeCount?: number; communities?: Array<{ id: number; name: string; size: number }>; godNodes?: Array<{ name: string; degree: number }>; error?: string;
    };
    if (r.error) return { content: [{ type: 'text' as const, text: `Error: ${r.error}` }] };
    const comms = (r.communities ?? []).slice(0, 15).map((c) => `- #${c.id} ${c.name} (${c.size} nodes)`).join('\n');
    const gods = (r.godNodes ?? []).map((g) => `${g.name} (deg ${g.degree})`).join(', ');
    return { content: [{ type: 'text' as const, text: `${r.communityCount ?? 0} communities over ${r.nodeCount ?? 0} nodes.\n\n**Communities:**\n${comms || '—'}\n\n**God nodes:** ${gods || '—'}` }] };
  },
);

// ── Tool: Wiki graph (pages-as-nodes) ─────────────────────────────────────────

registerToolWithAlias<{ compilationId: string }>(
  'gctrl_wiki_graph',
  'borghive_wiki_graph',
  'Get a WIKI compilation as a navigable graph: pages are nodes, [[wikilinks]] are edges. Clearance-filtered (pages above your clearance, and their links, are hidden). Useful for canvas/visual clients.',
  { compilationId: z.string().describe('The WIKI compilation ID') },
  async ({ compilationId }) => {
    const r = await apiCall('GET', `/kg/compilations/${compilationId}/wiki-graph`) as {
      nodes?: Array<{ id: string; label: string; minRank?: number }>; edges?: Array<{ source: string; target: string }>; nodeCount?: number; edgeCount?: number;
    };
    return { content: [{ type: 'text' as const, text: JSON.stringify({ nodeCount: r.nodeCount, edgeCount: r.edgeCount, nodes: r.nodes, edges: r.edges }, null, 2) }] };
  },
);

// ── Tool: Ingest a code repository (B1) ───────────────────────────────────────

registerToolWithAlias<{ files: Array<{ path: string; content: string }>; classificationLevelId?: string; repoName?: string }>(
  'gctrl_ingest_repo',
  'borghive_ingest_repo',
  'Ingest a (Python) code repository into the knowledge graph: parses files into File/Class/Function/Module entities + CONTAINS/IMPORTS/CALLS/INHERITS edges (fully local, no LLM). Classification flows in like any other knowledge. Pass files as [{path, content}].',
  {
    files: z.array(z.object({ path: z.string(), content: z.string() })).describe('Repo files as {path, content} (Python .py files are parsed; others skipped)'),
    classificationLevelId: z.string().optional().describe('Optional classification level UUID for the ingested code'),
    repoName: z.string().optional().describe('Optional repo name (provenance origin)'),
  },
  async ({ files, classificationLevelId, repoName }) => {
    const jobId = crypto.randomUUID();
    const r = await apiCall('POST', '/kex/repo', {
      job_id: jobId, files, classification_level_id: classificationLevelId, repo_name: repoName ?? 'repo',
    }) as { entities_created?: number; relations_created?: number; files_parsed?: number; files_skipped?: number; error?: string };
    if (r.error) return { content: [{ type: 'text' as const, text: `Error: ${r.error}` }] };
    return { content: [{ type: 'text' as const, text: `Ingested repo: ${r.entities_created ?? 0} code entities, ${r.relations_created ?? 0} relations (${r.files_parsed ?? 0} files parsed, ${r.files_skipped ?? 0} skipped).` }] };
  },
);

// ── Tool: Pin/unpin a dossier (HOT memory curation) ──────────────────────────

registerToolWithAlias<{ name: string; pinned?: boolean }>(
  'gctrl_pin_dossier',
  'borghive_pin_dossier',
  'Pin (or unpin) an entity dossier so it stays in HOT memory and is always injected into answers. Owner-level memory curation — denied for KB-scoped tokens.',
  { name: z.string().describe('Entity name to pin/unpin'), pinned: z.boolean().optional().describe('true=pin, false=unpin, omit=toggle') },
  async ({ name, pinned }) => {
    const r = await apiCall('POST', '/agent/tools/pin_dossier', { name, pinned }) as { ok?: boolean; entityName?: string; pinned?: boolean; error?: string };
    if (r.error) return { content: [{ type: 'text' as const, text: `Error: ${r.error}` }] };
    return { content: [{ type: 'text' as const, text: `${r.pinned ? '📌 Pinned' : 'Unpinned'} dossier: ${r.entityName}` }] };
  },
);

// ── Tool: Reinforce / distrust a fact (trust loop) ────────────────────────────

registerToolWithAlias<{ entity: string; vote: 'up' | 'down'; compilationId?: string; head?: string; relType?: string; tail?: string }>(
  'gctrl_memory_feedback',
  'borghive_memory_feedback',
  "Reinforce or distrust a memory: vote 'up' raises an entity dossier's trust; 'down' sets it to 0 and, if you pass a fact triple (compilationId+head+relType+tail), deletes that wrong edge and remembers the correction so it never returns. Owner-level.",
  {
    entity: z.string().describe('Entity whose dossier the feedback targets'),
    vote: z.enum(['up', 'down']).describe("'up' to confirm/reinforce, 'down' to distrust"),
    compilationId: z.string().optional().describe('For a targeted 👎 fact correction'),
    head: z.string().optional(), relType: z.string().optional(), tail: z.string().optional(),
  },
  async ({ entity, vote, compilationId, head, relType, tail }) => {
    const r = await apiCall('POST', '/agent/tools/memory_feedback', { entity, vote, compilationId, head, relType, tail }) as { ok?: boolean; trust?: number | null; corrected?: boolean; error?: string };
    if (r.error) return { content: [{ type: 'text' as const, text: `Error: ${r.error}` }] };
    return { content: [{ type: 'text' as const, text: `Feedback '${vote}' recorded for ${entity}${r.trust != null ? ` (trust now ${r.trust})` : ''}${r.corrected ? ' · wrong fact removed' : ''}.` }] };
  },
);

// ── Tool: Memory health snapshot ──────────────────────────────────────────────

registerToolWithAlias<Record<string, never>>(
  'gctrl_memory_health',
  'borghive_memory_health',
  'Read the memory snapshot: coverage, store sizes (entities/edges/chunks/dossiers/wiki), heat + trust distribution, and the last maintenance cycle. Owner-level.',
  {},
  async () => {
    const r = await apiCall('POST', '/agent/tools/memory_health', {}) as { error?: string };
    if (r.error) return { content: [{ type: 'text' as const, text: `Error: ${r.error}` }] };
    return { content: [{ type: 'text' as const, text: JSON.stringify(r, null, 2) }] };
  },
);

// ── Tool: Run a memory maintenance cycle ──────────────────────────────────────

registerToolWithAlias<Record<string, never>>(
  'gctrl_run_maintenance',
  'borghive_run_maintenance',
  'Run one memory governance cycle now (decay → dedup → promote hot → evict stale). Owner-level.',
  {},
  async () => {
    const r = await apiCall('POST', '/agent/tools/run_maintenance', {}) as { ok?: boolean; summary?: unknown; error?: string };
    if (r.error) return { content: [{ type: 'text' as const, text: `Error: ${r.error}` }] };
    return { content: [{ type: 'text' as const, text: `Maintenance cycle complete:\n${JSON.stringify(r.summary, null, 2)}` }] };
  },
);

// ── Tool: Read the user personalization profile ───────────────────────────────

registerToolWithAlias<Record<string, never>>(
  'gctrl_get_user_profile',
  'borghive_get_user_profile',
  'Read the owner personalization profile (opt-in facts + summary) so you can tailor answers to who is asking. Owner-level.',
  {},
  async () => {
    const r = await apiCall('POST', '/agent/tools/get_user_profile', {}) as { enabled?: boolean; facts?: unknown; summary?: string; error?: string };
    if (r.error) return { content: [{ type: 'text' as const, text: `Error: ${r.error}` }] };
    if (!r.enabled) return { content: [{ type: 'text' as const, text: 'User profile is not enabled (opt-in, off by default).' }] };
    return { content: [{ type: 'text' as const, text: `**Profile:** ${r.summary || '(no summary)'}\n\nFacts: ${JSON.stringify(r.facts ?? [])}` }] };
  },
);

// ── Tool: List Ontologies ────────────────────────────────────────────────────

registerToolWithAlias<Record<string, never>>(
  'gctrl_list_ontologies',
  'borghive_list_ontologies',
  'List all ontologies available in Ground Control. Ontologies define entity types and matching rules for knowledge extraction.',
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

const listExtractionsSchema = {
  limit: z.number().default(10).describe('Maximum jobs to return'),
};

registerToolWithAlias<{ limit: number }>(
  'gctrl_list_extractions',
  'borghive_list_extractions',
  'List recent knowledge extraction jobs with their status, entity counts, and source info.',
  listExtractionsSchema,
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

const storeSchema = {
  text: z.string().describe('Text content to store as knowledge'),
  title: z.string().optional().describe('Optional title/label for this knowledge'),
  compilationId: z.string().optional().describe('Target knowledge graph compilation ID. RECOMMENDED: always specify this to store into the correct agent graph. Use gctrl_list_graphs to find IDs.'),
  ontologyId: z.string().optional().describe('Optional ontology to guide extraction'),
};

registerToolWithAlias<{
  text: string;
  title?: string;
  compilationId?: string;
  ontologyId?: string;
}>(
  'gctrl_store',
  'borghive_store',
  'WRITE your conclusions back into GCTRL — call this after ANY substantive task so your memory compounds across sessions (this is the point of GCTRL). Extracts entities + builds graph from the text, like saving notes but structured. IMPORTANT: always pass a compilationId for your assigned knowledge base (find it via gctrl_list_graphs) so nothing is orphaned.',
  storeSchema,
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
      : '\n- WARNING: No compilationId specified — entities are floating unlinked. Use gctrl_list_graphs to find the right compilation ID.';

    return {
      content: [{
        type: 'text' as const,
        text: `Knowledge stored! Extraction job ${result.jobId} is processing.\nThe text will be:\n- Chunked and embedded in Qdrant (for semantic search)\n- Entity-extracted into Neo4j (for graph queries)${targetInfo}\n- Available via gctrl_query once complete`,
      }],
    };
  },
);

// ── Tool: Get Graph Schema ───────────────────────────────────────────────────

registerToolWithAlias<Record<string, never>>(
  'gctrl_schema',
  'borghive_schema',
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

/**
 * Remote mode: discover the gateway's tools and register each as a passthrough
 * that forwards `tools/call` to the remote harness. Tool names + schemas come
 * straight from the gateway, so a networked GCTRL exposes exactly its own tools.
 */
async function registerRemoteTools(): Promise<void> {
  const listed = (await gatewayRpc('tools/list')) as {
    tools: Array<{ name: string; description?: string; inputSchema?: { properties?: Record<string, unknown> } }>;
  };

  for (const tool of listed.tools ?? []) {
    // Translate the gateway's JSON-Schema properties into a loose Zod shape so
    // the SDK accepts arbitrary args (the real validation happens server-side).
    const shape: z.ZodRawShape = {};
    for (const key of Object.keys(tool.inputSchema?.properties ?? {})) {
      shape[key] = z.any().optional();
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (server.tool as any)(
      tool.name,
      tool.description ?? '',
      shape,
      async (args: Record<string, unknown>) => {
        const result = (await gatewayRpc('tools/call', { name: tool.name, arguments: args })) as {
          content?: Array<{ type: string; text: string }>;
        };
        return {
          content: result.content ?? [{ type: 'text' as const, text: JSON.stringify(result) }],
        };
      },
    );
  }
  console.error(`[GCTRL MCP] Remote mode: proxying ${(listed.tools ?? []).length} tools to ${GATEWAY_URL}`);
}

async function main() {
  if (GATEWAY_URL) {
    await registerRemoteTools();
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[GCTRL MCP] Server running on stdio');
  if (GATEWAY_URL) {
    console.error(`[GCTRL MCP] Remote mode active — bridging to gateway ${GATEWAY_URL}`);
  } else {
    console.error(
      '[GCTRL MCP] Tools exposed under primary name `gctrl_*`. ' +
        'Legacy `borghive_*` aliases are still registered for backwards ' +
        'compat and will be removed in v2 — please migrate your `.mcp.json`.',
    );
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
