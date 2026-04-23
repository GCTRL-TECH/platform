/**
 * Qdrant vector search service.
 * Searches the "GCTRL_chunks" collection for text chunks semantically
 * similar to an embedded query vector. Used by the hybrid RAG pipeline.
 *
 * Collection schema (set up by the ingestion worker):
 *   - 768-dim cosine vectors (nomic-embed-text output)
 *   - Payload fields: text, job_id, compilation_id, chunk_sequence,
 *                     entity_mentions[]{name, type, label}
 */

const QDRANT_URL = (process.env['QDRANT_URL'] || 'http://qdrant:6333').replace(/\/$/, '');
const COLLECTION = 'GCTRL_chunks';

export interface VectorSearchResult {
  score: number;
  text: string;
  jobId: string;
  compilationId?: string;
  entityMentions: Array<{ name: string; type: string; label: string }>;
  chunkSequence: number;
}

// ─── Qdrant response shape (minimal) ─────────────────────────────────────────

interface QdrantScoredPoint {
  id: string | number;
  score: number;
  payload?: {
    text?: string;
    job_id?: string;
    compilation_id?: string;
    chunk_sequence?: number;
    entity_mentions?: Array<{ name?: string; type?: string; label?: string }>;
  };
}

interface QdrantSearchResponse {
  result: QdrantScoredPoint[];
  status: string;
  time: number;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Search Qdrant for the most similar text chunks to the given query vector.
 *
 * @param queryVector   768-dim embedding of the user question
 * @param compilationId Optional — filter results to a specific compilation
 * @param limit         Maximum number of results to return (default 5)
 * @param scoreThreshold Minimum cosine similarity score (default 0.3)
 */
export async function searchChunks(
  queryVector: number[],
  compilationId?: string,
  limit: number = 5,
  scoreThreshold: number = 0.3,
): Promise<VectorSearchResult[]> {
  const body: Record<string, unknown> = {
    vector: queryVector,
    limit,
    score_threshold: scoreThreshold,
    with_payload: true,
  };

  // Apply compilation filter when specified
  if (compilationId) {
    body['filter'] = {
      must: [
        {
          key: 'compilation_id',
          match: { value: compilationId },
        },
      ],
    };
  }

  const resp = await fetch(`${QDRANT_URL}/collections/${COLLECTION}/points/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Qdrant search error ${resp.status}: ${text}`);
  }

  const data = (await resp.json()) as QdrantSearchResponse;

  return (data.result ?? []).map((point): VectorSearchResult => {
    const payload = point.payload ?? {};
    const mentions = (payload.entity_mentions ?? []).map((m) => ({
      name: m.name ?? '',
      type: m.type ?? '',
      label: m.label ?? '',
    }));

    return {
      score: point.score,
      text: payload.text ?? '',
      jobId: payload.job_id ?? '',
      compilationId: payload.compilation_id,
      entityMentions: mentions,
      chunkSequence: payload.chunk_sequence ?? 0,
    };
  });
}

/**
 * Check whether the Qdrant collection exists and is reachable.
 * Used by the hybrid pipeline to decide whether to attempt vector search.
 */
export async function isQdrantAvailable(): Promise<boolean> {
  try {
    const resp = await fetch(`${QDRANT_URL}/collections/${COLLECTION}`, {
      signal: AbortSignal.timeout(3000),
    });
    return resp.ok;
  } catch {
    return false;
  }
}

