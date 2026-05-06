/**
 * RAG API routes — Talk to Graph module
 *
 * Dual-mode:
 *   incognito — stateless, no DB persistence, works without auth
 *   standard  — persists conversation + messages, requireAuth
 *
 * GDPR: incognito queries are never written to any DB.
 *       API keys for cloud providers come from the request body only.
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { eq, and, desc, count, sql, inArray } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';

import { db } from '../models/db.js';
import {
  conversations,
  messages,
  users,
  compilations,
  jobs,
  tokenUsage,
} from '../models/schema.js';
import { requireAuth, optionalAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { canAccess, CLEARANCE_LEVELS } from '../middleware/acl.js';
import { UserClearance } from '../models/schema.js';
import { runQuery } from '../services/neo4j.js';
import { generateResponse, listOllamaModels, DEFAULT_LLM_CONFIG, LLMConfig } from '../services/llm.js';
import { generateCypher } from '../services/cypher-gen.js';
import { traceAnswer, GraphTrace } from '../services/graph-trace.js';
import { generateEmbedding } from '../services/embedding.js';
import { searchChunks, isQdrantAvailable, VectorSearchResult } from '../services/qdrant.js';
import { webSearch, looksLikePersonQuery, type WebSearchResult } from '../services/web-search.js';

const router = Router();

// ─── Constants ────────────────────────────────────────────────────────────────

const RAG_SYSTEM_PROMPT = `You are GCTRL's knowledge assistant. Answer questions using the provided context.

Context has two types:
1. "Document Context" — actual text from ingested documents. Use this for detailed answers.
2. "Knowledge Graph Facts" — structured entity data. Use this for precise facts about entities.

Rules:
1. Answer ONLY based on the provided context. If the context doesn't contain the answer, say "I don't have enough information about that."
2. Cite sources: mention which documents or entities your answer comes from.
3. When the document context and graph facts agree, confidence is HIGH.
4. When only one source has information, confidence is MEDIUM.
5. Never make up information not in the context.
6. Format responses with markdown for readability.
7. ALWAYS match the user's language. If they ask in German, respond fully in German. If English, respond in English.
8. IMPORTANT: The context/documents may be in a different language than the question. That's fine — read and understand the context regardless of its language, then formulate your answer in the USER's language.
9. Always give thorough, detailed answers. Do not be brief. Explain the context, cite sources, and provide background information. Aim for at least 3-4 sentences per answer.
10. When "Web Search Results" are provided, use them to enrich your answer but clearly distinguish between knowledge graph facts and web information.
11. Prioritize knowledge graph data over web results — graph data is verified, web data is supplementary.
12. CRITICAL: Each question is independent. Only use information from the CURRENT context provided. Do NOT mix or carry over facts from previous messages into the current answer. If the conversation history mentions other people/topics, ignore those details for the current question.`;

const TOKEN_COST_RAG = 1;

// ─── Validation schemas ───────────────────────────────────────────────────────

const llmConfigSchema = z.object({
  provider: z.enum(['ollama', 'openai', 'anthropic', 'openrouter', 'nim']).default('ollama'),
  model: z.string().min(1).default('llama3.2'),
  apiKey: z.string().optional(),
  baseUrl: z.string().url().optional(),
  temperature: z.number().min(0).max(2).optional(),
});

const querySchema = z.object({
  message: z.string().min(1).max(4000),
  compilationId: z.string().uuid().optional(),
  mode: z.enum(['incognito', 'standard']).default('standard'),
  conversationId: z.string().uuid().optional(),
  context: z
    .array(z.object({ role: z.string(), content: z.string() }))
    .optional(),
  llmConfig: llmConfigSchema.optional(),
});

const kexFromChatSchema = z.object({
  text: z.string().min(1).max(100000),
  compilationId: z.string().uuid().optional(),
  ontologyId: z.string().uuid().optional(),
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function resolveLlmConfig(requested?: z.infer<typeof llmConfigSchema>): LLMConfig {
  if (!requested) return DEFAULT_LLM_CONFIG;
  return {
    provider: requested.provider,
    model: requested.model,
    apiKey: requested.apiKey,
    baseUrl: requested.baseUrl,
    temperature: requested.temperature,
  };
}

function getAllowedClassifications(clearance: UserClearance): UserClearance[] {
  const level = CLEARANCE_LEVELS.indexOf(clearance);
  return CLEARANCE_LEVELS.slice(0, level + 1) as UserClearance[];
}

function buildContextString(records: unknown[]): string {
  if (records.length === 0) return '';

  const lines: string[] = [];
  for (const record of records.slice(0, 50)) {
    try {
      // Neo4j driver records have .keys and .get() methods
      const rec = record as { keys: string[]; get: (key: string) => unknown };
      if (!rec.keys || !rec.get) continue;

      const parts = rec.keys.map((k: string) => {
        const val = rec.get(k);
        if (val === null || val === undefined) return null;
        if (typeof val === 'object' && val !== null && 'properties' in (val as Record<string, unknown>)) {
          const props = (val as { properties: Record<string, unknown> }).properties;
          return `${k}: ${props['name'] ?? props['label'] ?? JSON.stringify(props).slice(0, 100)}`;
        }
        return `${k}: ${String(val).slice(0, 200)}`;
      });
      const line = parts.filter(Boolean).join(', ');
      if (line) lines.push(line);
    } catch {
      continue;
    }
  }

  return lines.join('\n');
}

// ─── Hybrid RAG helpers ───────────────────────────────────────────────────────

/**
 * Combine vector text chunks and graph records into a single context string
 * for the LLM. Vector chunks come first — they carry actual document prose.
 */
function buildHybridContext(
  graphRecords: unknown[],
  vectorChunks: VectorSearchResult[],
): string {
  let context = '';

  if (vectorChunks.length > 0) {
    context += 'Document Context:\n';
    for (const chunk of vectorChunks) {
      context += `[Source: document chunk, relevance: ${chunk.score.toFixed(2)}]\n${chunk.text}\n\n`;
    }
  }

  if (graphRecords.length > 0) {
    context += '\nKnowledge Graph Facts:\n';
    context += buildContextString(graphRecords);
  }

  return context;
}

/**
 * Confidence score that accounts for both vector and graph result quality.
 *
 * Scoring logic:
 * - Both graph + vector: high confidence (0.85-0.95) — graph confirms, text explains
 * - Vector only with good scores: medium-high (0.7-0.85) — document text is strong evidence
 * - Graph only: medium (0.6-0.7) — entity exists but no contextual detail
 * - Neither: low (0.1) — no evidence found
 *
 * The top vector score matters more than the average — if the best chunk is highly
 * relevant, the answer is likely good even if other chunks are mediocre.
 */
function calculateHybridConfidence(
  graphRecords: unknown[],
  vectorChunks: VectorSearchResult[],
): number {
  const hasGraph = graphRecords.length > 0;
  const hasVector = vectorChunks.length > 0;
  const topVectorScore = vectorChunks.length > 0
    ? Math.max(...vectorChunks.map((c) => c.score))
    : 0;
  const vectorCount = vectorChunks.length;

  if (hasGraph && hasVector) {
    // Both sources agree — strong confidence
    // Scale: 0.85 base + up to 0.10 from top vector quality
    return Math.min(0.95, 0.85 + topVectorScore * 0.1);
  }
  if (hasVector) {
    // Document chunks found — confidence based on best match + count
    // More chunks = more evidence = higher confidence
    const countBonus = Math.min(vectorCount * 0.03, 0.15);
    return Math.min(0.85, 0.55 + topVectorScore * 0.25 + countBonus);
  }
  if (hasGraph) return 0.6;
  return 0.1;
}

/**
 * Extract unique entity names from vector search results to use as
 * anchors when generating the Cypher query.
 */
function extractEntityHints(vectorChunks: VectorSearchResult[]): string[] {
  const names = new Set<string>();
  for (const chunk of vectorChunks) {
    for (const mention of chunk.entityMentions) {
      if (mention.name) names.add(mention.name);
    }
  }
  return Array.from(names).slice(0, 20); // cap at 20 to keep the prompt manageable
}

/**
 * Build the sources array for the API response.
 * Includes both graph entities (type: 'graph') and vector chunks (type: 'semantic').
 */
async function buildHybridSources(
  graphRecords: unknown[],
  vectorChunks: VectorSearchResult[],
  webResults?: WebSearchResult[],
  webImageUrl?: string,
): Promise<Array<{ name: string; type: string; relevance: number; text?: string; url?: string; imageUrl?: string }>> {
  const sources: Array<{ name: string; type: string; relevance: number; text?: string; url?: string; imageUrl?: string }> = [];

  // Resolve job IDs → filenames for semantic sources
  const jobIds = [...new Set(vectorChunks.map((c) => c.jobId).filter(Boolean))];
  const jobNameMap = new Map<string, string>();
  if (jobIds.length > 0) {
    try {
      const jobRows = await db
        .select({ id: jobs.id, input: jobs.input })
        .from(jobs)
        .where(inArray(jobs.id, jobIds));
      for (const row of jobRows) {
        const input = row.input as Record<string, unknown> | null;
        const filename = (input?.['originalFilename'] as string)
          || (input?.['text'] as string)?.slice(0, 40)
          || row.id.slice(0, 8);
        jobNameMap.set(row.id, filename);
      }
    } catch { /* non-fatal */ }
  }

  // Semantic sources from vector search
  for (const chunk of vectorChunks) {
    const sourceName = jobNameMap.get(chunk.jobId) || `Document ${chunk.jobId?.slice(0, 8) || 'unknown'}`;
    sources.push({
      name: sourceName,
      type: 'semantic',
      relevance: Math.round(chunk.score * 100) / 100,
      text: chunk.text,
    });
  }

  // Graph sources from Neo4j
  const sourceMap = new Map<string, { name: string; count: number }>();
  for (const record of graphRecords) {
    try {
      const rec = record as { keys: string[]; get: (key: string) => unknown };
      if (!rec.keys || !rec.get) continue;

      for (const key of rec.keys) {
        const val = rec.get(key);
        if (typeof val === 'object' && val !== null && 'properties' in (val as Record<string, unknown>)) {
          const props = (val as { properties: Record<string, unknown> }).properties;
          const name = String(props['name'] ?? props['label'] ?? 'Unknown');
          const existing = sourceMap.get(name);
          if (existing) existing.count++;
          else sourceMap.set(name, { name, count: 1 });
        } else if (typeof val === 'string' && val.length > 0) {
          if (!sourceMap.has(val)) sourceMap.set(val, { name: val, count: 1 });
        }
      }
    } catch { continue; }
  }

  const maxCount = Math.max(1, ...Array.from(sourceMap.values()).map((s) => s.count));
  for (const [, s] of Array.from(sourceMap.entries()).slice(0, 10)) {
    sources.push({
      name: s.name,
      type: 'graph',
      relevance: Math.round((s.count / maxCount) * 100) / 100,
    });
  }

  // Web sources
  if (webResults && webResults.length > 0) {
    for (const wr of webResults) {
      sources.push({
        name: wr.title || wr.url,
        type: 'web',
        relevance: 0.5,
        text: wr.snippet || wr.content?.slice(0, 150),
        url: wr.url,
        imageUrl: wr.imageUrl,
      });
    }
    // Attach image URL to first web source if available
    if (webImageUrl && sources.length > 0) {
      const firstWeb = sources.find((s) => s.type === 'web');
      if (firstWeb) firstWeb.imageUrl = webImageUrl;
    }
  }

  return sources.sort((a, b) => b.relevance - a.relevance);
}

async function deductToken(userId: string, conversationId?: string): Promise<void> {
  try {
    await db.transaction(async (tx) => {
      await tx
        .update(users)
        .set({ tokensBalance: sql`${users.tokensBalance} - ${TOKEN_COST_RAG}`, updatedAt: new Date() })
        .where(eq(users.id, userId));
      await tx.insert(tokenUsage).values({
        userId,
        action: 'rag_query',
        tokensSpent: TOKEN_COST_RAG,
        jobId: null,
      });
    });
  } catch (err) {
    console.error('[RAG] Token deduction failed (non-fatal):', err);
  }
}

async function checkTokenBalance(userId: string): Promise<boolean> {
  const [user] = await db
    .select({ tokensBalance: users.tokensBalance })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return (user?.tokensBalance ?? 0) >= TOKEN_COST_RAG;
}

async function verifyCompilationAccess(
  compilationId: string,
  userId: string,
  userClearance: UserClearance
): Promise<boolean> {
  const [comp] = await db
    .select({ classification: compilations.classification, userId: compilations.userId })
    .from(compilations)
    .where(eq(compilations.id, compilationId))
    .limit(1);

  if (!comp) return false;
  return canAccess(userClearance, comp.classification);
}

// ─── POST /api/rag/query ──────────────────────────────────────────────────────

router.post(
  '/query',
  optionalAuth,
  validate(querySchema),
  async (req: Request, res: Response): Promise<void> => {
    const body = req.body as z.infer<typeof querySchema>;
    const isStandard = body.mode === 'standard';

    // Standard mode requires auth
    if (isStandard && !req.user) {
      res.status(401).json({ error: 'Standard mode requires authentication' });
      return;
    }

    // Token gate for authenticated users
    if (req.user) {
      const hasBalance = await checkTokenBalance(req.user.sub);
      if (!hasBalance) {
        res.status(402).json({
          error: 'Insufficient token balance',
          required: TOKEN_COST_RAG,
        });
        return;
      }
    }

    // Resolve clearance for ACL filtering
    const userClearance: UserClearance = req.user?.clearance ?? 'PUBLIC';
    const allowedClassifications = getAllowedClassifications(userClearance);

    // Verify compilation access if specified
    if (body.compilationId && req.user) {
      const hasAccess = await verifyCompilationAccess(
        body.compilationId,
        req.user.sub,
        userClearance
      );
      if (!hasAccess) {
        res.status(403).json({ error: 'Access to this compilation is denied' });
        return;
      }
    }

    const llmConfig = resolveLlmConfig(body.llmConfig);

    try {
      // ── 1. Vector search (with graceful fallback) ──────────────────────────
      let vectorChunks: VectorSearchResult[] = [];
      let vectorError: string | undefined;

      try {
        const qdrantReady = await isQdrantAvailable();
        if (qdrantReady) {
          const queryVector = await generateEmbedding(body.message);
          vectorChunks = await searchChunks(
            queryVector,
            body.compilationId,
            5,   // top-5 chunks
            0.3, // min cosine similarity
          );
          console.log(`[RAG] Vector search found ${vectorChunks.length} chunks`);
        } else {
          console.warn('[RAG] Qdrant unavailable — skipping vector search');
        }
      } catch (err) {
        vectorError = err instanceof Error ? err.message : String(err);
        console.warn(`[RAG] Vector search failed (falling back to graph-only): ${vectorError}`);
      }

      // ── 2. Extract entity hints from vector results ────────────────────────
      const entityHints = extractEntityHints(vectorChunks);
      if (entityHints.length > 0) {
        console.log(`[RAG] Entity hints from vector search: ${entityHints.slice(0, 5).join(', ')}`);
      }

      // ── 3. Generate Cypher (with entity hints as anchors) ──────────────────
      const { cypher, explanation } = await generateCypher(
        body.message,
        llmConfig,
        body.compilationId,
        allowedClassifications,
        entityHints.length > 0 ? entityHints : undefined,
      );

      // ── 4. Execute Cypher against Neo4j ───────────────────────────────────
      let neo4jRecords: unknown[] = [];
      let cypherError: string | undefined;

      try {
        const params: Record<string, unknown> = {
          allowedClassifications,
          searchTerm: body.message,
        };
        if (body.compilationId) {
          params['compilationId'] = body.compilationId;
        }

        const result = await runQuery(cypher, params);
        neo4jRecords = result.records;
      } catch (err) {
        cypherError = err instanceof Error ? err.message : String(err);
        console.warn(`[RAG] Cypher execution failed: ${cypherError}`);
        // Continue — LLM will answer from vector context alone if available
      }

      // ── 5. Web search enrichment (when local data is insufficient) ──────────
      let webResults: WebSearchResult[] = [];
      let webImageUrl: string | undefined;

      const preliminaryConfidence = calculateHybridConfidence(neo4jRecords, vectorChunks);

      // Check if vector results actually relate to the question
      // If the query mentions a name/entity not found in any chunk, results are noise
      const queryWords = body.message.toLowerCase().split(/\s+/).filter((w: string) => w.length > 3);
      const chunksRelevant = vectorChunks.some((c) => {
        const chunkText = c.text.toLowerCase();
        return queryWords.some((w: string) => chunkText.includes(w));
      });
      const graphRelevant = neo4jRecords.length > 0;

      const shouldSearchWeb =
        preliminaryConfidence < 0.75 ||
        vectorChunks.length < 2 ||
        (!chunksRelevant && !graphRelevant) ||  // No local data matches the query at all
        (neo4jRecords.length === 0 && vectorChunks.every((c) => c.score < 0.5));

      if (shouldSearchWeb) {
        try {
          const isPersonQuery = looksLikePersonQuery(body.message);
          const webData = await webSearch(body.message, {
            includeImages: isPersonQuery,
            maxResults: 3,
          });
          webResults = webData.results;
          webImageUrl = webData.imageUrl;
          if (webResults.length > 0) {
            console.log(`[RAG] Web search found ${webResults.length} results${webImageUrl ? ' + image' : ''}`);
          }
        } catch (err) {
          console.warn(`[RAG] Web search failed (non-fatal): ${err}`);
        }
      }

      // ── 6. Fuse context: vector chunks + graph results + web ────────────────
      let contextStr = buildHybridContext(neo4jRecords, vectorChunks);

      // Append web results to context
      if (webResults.length > 0) {
        contextStr += '\n\nWeb Search Results (additional context from the internet):\n';
        for (const wr of webResults) {
          contextStr += `[Source: ${wr.title} — ${wr.url}]\n${wr.content || wr.snippet}\n\n`;
        }
      }

      // ── 6. Generate answer via LLM ─────────────────────────────────────────
      // Build conversation history for context continuity.
      // IMPORTANT: Only pass short summaries of prior Q&A — NOT full answers with
      // web search content, otherwise the LLM mixes facts from different questions.
      let priorMessages: Array<{ role: string; content: string }> | undefined;

      function truncateForHistory(content: string, role: string): string {
        if (role === 'user' || role === 'human') return content; // keep questions in full
        // For AI answers: keep first 200 chars to give topic context, drop details
        if (content.length <= 200) return content;
        return content.slice(0, 200) + '...';
      }

      if (body.context && body.context.length > 0) {
        priorMessages = body.context.map((m: { role: string; content: string }) => ({
          role: m.role,
          content: truncateForHistory(m.content, m.role),
        }));
      } else if (isStandard && body.conversationId && req.user) {
        try {
          const prior = await db
            .select({ role: messages.role, content: messages.content })
            .from(messages)
            .where(eq(messages.conversationId, body.conversationId))
            .orderBy(messages.createdAt)
            .limit(6); // fewer messages, more focused
          if (prior.length > 0) {
            priorMessages = prior.map((m) => ({
              role: m.role,
              content: truncateForHistory(m.content, m.role),
            }));
          }
        } catch { /* non-fatal */ }
      }

      const llmResponse = await generateResponse(
        llmConfig,
        RAG_SYSTEM_PROMPT,
        body.message,
        contextStr || undefined,
        priorMessages,
      );

      // ── 7. Confidence + trace + sources ────────────────────────────────────
      let confidence = calculateHybridConfidence(neo4jRecords, vectorChunks);

      // If vector chunks exist but don't actually match the query, penalize confidence
      if (!chunksRelevant && vectorChunks.length > 0) {
        confidence = Math.min(confidence, 0.3);
      }

      // Boost confidence if web results enrich the answer
      if (webResults.length > 0) {
        confidence = Math.max(confidence, 0.5); // web results guarantee at least medium confidence
        if (confidence < 0.85) confidence = Math.min(confidence + 0.1, 0.85);
      }
      const graphTrace: GraphTrace = await traceAnswer(cypher, neo4jRecords);
      const sources = await buildHybridSources(neo4jRecords, vectorChunks, webResults, webImageUrl);

      // 8. Persist for standard mode
      let conversationId: string | undefined;
      let messageId: string | undefined;

      if (isStandard && req.user) {
        const userId = req.user.sub;

        // Resolve or create conversation
        if (body.conversationId) {
          // Verify ownership
          const [existing] = await db
            .select({ id: conversations.id })
            .from(conversations)
            .where(
              and(
                eq(conversations.id, body.conversationId),
                eq(conversations.userId, userId)
              )
            )
            .limit(1);

          if (!existing) {
            res.status(404).json({ error: 'Conversation not found' });
            return;
          }
          conversationId = body.conversationId;
        } else {
          // Create new conversation — derive title from first message
          const title = body.message.slice(0, 120).replace(/\n/g, ' ');
          const modelLabel = body.llmConfig
            ? `${body.llmConfig.provider}:${body.llmConfig.model}`
            : 'ollama:llama3.2';

          const [newConv] = await db
            .insert(conversations)
            .values({
              userId,
              compilationId: body.compilationId ?? null,
              title,
              model: modelLabel,
              mode: 'standard',
            })
            .returning({ id: conversations.id });

          conversationId = newConv?.id;
        }

        if (conversationId) {
          // Save user message
          await db.insert(messages).values({
            conversationId,
            role: 'user',
            content: body.message,
          });

          // Save assistant message
          const [assistantMsg] = await db
            .insert(messages)
            .values({
              conversationId,
              role: 'assistant',
              content: llmResponse.content,
              cypherQuery: cypher,
              sources: sources,
              confidence,
              graphTrace: graphTrace as unknown as Record<string, unknown>,
              tokensUsed: llmResponse.tokensUsed,
            })
            .returning({ id: messages.id });

          messageId = assistantMsg?.id;

          // Update conversation timestamp
          await db
            .update(conversations)
            .set({ updatedAt: new Date() })
            .where(eq(conversations.id, conversationId));

          // Deduct token
          await deductToken(userId, conversationId);
        }
      }

      res.json({
        answer: llmResponse.content,
        conversationId: isStandard ? conversationId : undefined,
        messageId: isStandard ? messageId : undefined,
        sources,
        cypher,
        cypherExplanation: explanation,
        cypherError: cypherError ?? null,
        confidence,
        graphTrace,
        tokensUsed: llmResponse.tokensUsed,
        model: llmResponse.model,
        ...(webImageUrl ? { imageUrl: webImageUrl } : {}),
      });
    } catch (err) {
      console.error('[RAG] Query failed:', err);
      res.status(500).json({
        error: 'RAG query failed',
        details: err instanceof Error ? err.message : String(err),
      });
    }
  }
);

// ─── GET /api/rag/conversations ───────────────────────────────────────────────

router.get(
  '/conversations',
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    const userId = req.user!.sub;

    try {
      // Count messages per conversation via subquery
      const rows = await db
        .select({
          id: conversations.id,
          title: conversations.title,
          model: conversations.model,
          compilationId: conversations.compilationId,
          mode: conversations.mode,
          createdAt: conversations.createdAt,
          updatedAt: conversations.updatedAt,
        })
        .from(conversations)
        .where(eq(conversations.userId, userId))
        .orderBy(desc(conversations.updatedAt));

      // Attach message counts
      const ids = rows.map((r) => r.id);
      let countMap: Map<string, number> = new Map();

      if (ids.length > 0) {
        // Count per conversation
        const counts = await db
          .select({
            conversationId: messages.conversationId,
            cnt: count(messages.id),
          })
          .from(messages)
          .where(
            sql`${messages.conversationId} = ANY(ARRAY[${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)}])`
          )
          .groupBy(messages.conversationId);

        countMap = new Map(counts.map((c) => [c.conversationId, Number(c.cnt)]));
      }

      const result = rows.map((r) => ({
        ...r,
        messageCount: countMap.get(r.id) ?? 0,
      }));

      res.json({ conversations: result });
    } catch (err) {
      console.error('[RAG] List conversations failed:', err);
      res.status(500).json({ error: 'Failed to list conversations' });
    }
  }
);

// ─── GET /api/rag/conversations/:id ──────────────────────────────────────────

router.get(
  '/conversations/:id',
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    const userId = req.user!.sub;
    const convId = req.params['id'];

    if (!convId) {
      res.status(400).json({ error: 'Conversation ID is required' });
      return;
    }

    try {
      const [conv] = await db
        .select()
        .from(conversations)
        .where(
          and(eq(conversations.id, convId), eq(conversations.userId, userId))
        )
        .limit(1);

      if (!conv) {
        res.status(404).json({ error: 'Conversation not found' });
        return;
      }

      const convMessages = await db
        .select()
        .from(messages)
        .where(eq(messages.conversationId, convId))
        .orderBy(messages.createdAt);

      res.json({ conversation: { ...conv, messages: convMessages } });
    } catch (err) {
      console.error('[RAG] Get conversation failed:', err);
      res.status(500).json({ error: 'Failed to get conversation' });
    }
  }
);

// ─── DELETE /api/rag/conversations/:id ───────────────────────────────────────

router.delete(
  '/conversations/:id',
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    const userId = req.user!.sub;
    const convId = req.params['id'];

    if (!convId) {
      res.status(400).json({ error: 'Conversation ID is required' });
      return;
    }

    try {
      const [conv] = await db
        .select({ id: conversations.id })
        .from(conversations)
        .where(
          and(eq(conversations.id, convId), eq(conversations.userId, userId))
        )
        .limit(1);

      if (!conv) {
        res.status(404).json({ error: 'Conversation not found' });
        return;
      }

      // Cascade delete handles messages automatically (FK constraint)
      await db
        .delete(conversations)
        .where(eq(conversations.id, convId));

      res.json({ success: true });
    } catch (err) {
      console.error('[RAG] Delete conversation failed:', err);
      res.status(500).json({ error: 'Failed to delete conversation' });
    }
  }
);

// ─── GET /api/rag/models ──────────────────────────────────────────────────────

router.get('/models', async (_req: Request, res: Response): Promise<void> => {
  try {
    const ollamaModels = await listOllamaModels();

    // Filter out embedding-only models (they can't generate text)
    const EMBEDDING_MODELS = ['nomic-embed-text', 'mxbai-embed-large', 'all-minilm', 'snowflake-arctic-embed'];
    const chatModels = ollamaModels.filter(
      (m) => !EMBEDDING_MODELS.some((emb) => m.name.startsWith(emb))
    );

    const localModels = chatModels.map((m) => ({
      provider: 'ollama' as const,
      model: m.name,
      name: `${m.name} (Local)`,
      available: true,
      requiresKey: false,
    }));

    // If no Ollama models detected, show default as available
    if (localModels.length === 0) {
      localModels.push({
        provider: 'ollama',
        model: 'llama3.2',
        name: 'Llama 3.2 (Local)',
        available: false,
        requiresKey: false,
      });
    }

    const cloudModels = [
      {
        provider: 'openai' as const,
        model: 'gpt-4o',
        name: 'GPT-4o',
        available: false,
        requiresKey: true,
      },
      {
        provider: 'openai' as const,
        model: 'gpt-4o-mini',
        name: 'GPT-4o Mini',
        available: false,
        requiresKey: true,
      },
      {
        provider: 'anthropic' as const,
        model: 'claude-sonnet-4-20250514',
        name: 'Claude Sonnet 4',
        available: false,
        requiresKey: true,
      },
      {
        provider: 'anthropic' as const,
        model: 'claude-haiku-4-20250514',
        name: 'Claude Haiku 4',
        available: false,
        requiresKey: true,
      },
      {
        provider: 'openrouter' as const,
        model: 'auto',
        name: 'OpenRouter Auto',
        available: false,
        requiresKey: true,
      },
    ];

    res.json({ models: [...localModels, ...cloudModels] });
  } catch (err) {
    console.error('[RAG] List models failed:', err);
    res.status(500).json({ error: 'Failed to list models' });
  }
});

// ─── POST /api/rag/kex-from-chat ─────────────────────────────────────────────

router.post(
  '/kex-from-chat',
  requireAuth,
  validate(kexFromChatSchema),
  async (req: Request, res: Response): Promise<void> => {
    const userId = req.user!.sub;
    const body = req.body as z.infer<typeof kexFromChatSchema>;

    // Check token balance
    const hasBalance = await checkTokenBalance(userId);
    if (!hasBalance) {
      res.status(402).json({
        error: 'Insufficient token balance',
        required: TOKEN_COST_RAG,
      });
      return;
    }

    try {
      // Delegate to KEX worker via queue
      const { addKexJob } = await import('../services/queue.js');

      const jobId = uuidv4();

      // Insert job record
      const { jobs: jobsTable } = await import('../models/schema.js');
      const [job] = await db
        .insert(jobsTable)
        .values({
          id: jobId,
          userId,
          type: 'kex_extract',
          status: 'pending',
          input: {
            text: body.text,
            compilationId: body.compilationId,
            ontologyId: body.ontologyId,
            source: 'chat',
          },
        })
        .returning({ id: jobsTable.id });

      const resolvedJobId = job?.id ?? jobId;

      await addKexJob(resolvedJobId, {
        userId,
        type: 'kex_extract',
        input: {
          text: body.text,
          compilationId: body.compilationId ?? null,
          ontologyId: body.ontologyId ?? null,
          source: 'chat',
        },
      });

      await deductToken(userId);

      res.json({
        jobId: resolvedJobId,
        status: 'pending',
        message: 'KEX extraction started from chat input',
      });
    } catch (err) {
      console.error('[RAG] KEX from chat failed:', err);
      res.status(500).json({ error: 'Failed to start extraction' });
    }
  }
);

export default router;

