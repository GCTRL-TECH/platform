import type { ChunkOut } from './types.js';
import type { RawSymbol } from './extract/types.js';
import { symName } from './resolve.js';

export const MAX_CHUNK_CHARS = 2000;
const CHUNK_KINDS = new Set(['function', 'method', 'class', 'interface', 'struct', 'enum']);

export function buildChunks(p: string, source: string, symbols: RawSymbol[]): ChunkOut[] {
  const lines = source.split('\n');
  const out: ChunkOut[] = [];
  for (const s of symbols) {
    if (!CHUNK_KINDS.has(s.kind)) continue;
    const body = lines.slice(s.line_start - 1, s.line_end).join('\n');
    const header = `${p}:L${s.line_start}-L${s.line_end} ${s.signature}`.trim();
    const content = `${header}\n${body}`.slice(0, MAX_CHUNK_CHARS);
    out.push({ symbol: symName(p, s.qualname), kind: s.kind, content });
  }
  return out;
}
