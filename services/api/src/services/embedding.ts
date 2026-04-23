/**
 * Embedding service — generates vector embeddings via Ollama nomic-embed-text.
 * Used by the hybrid RAG pipeline to embed user questions for Qdrant vector search.
 */

const OLLAMA_BASE = (process.env['OLLAMA_BASE'] || 'http://ollama:11434').replace(/\/$/, '');
const EMBEDDING_MODEL = 'nomic-embed-text';

export async function generateEmbedding(text: string): Promise<number[]> {
  const resp = await fetch(`${OLLAMA_BASE}/api/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: EMBEDDING_MODEL, input: text }),
    signal: AbortSignal.timeout(10000),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Ollama embed error ${resp.status}: ${body}`);
  }

  const data = (await resp.json()) as { embeddings: number[][] };

  const embedding = data.embeddings?.[0];
  if (!embedding || embedding.length === 0) {
    throw new Error('Ollama returned empty embedding');
  }

  return embedding;
}
