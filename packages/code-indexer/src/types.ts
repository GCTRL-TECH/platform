import type { Lang } from './parser.js';

export type SymbolKind = 'file' | 'module' | 'class' | 'interface' | 'enum' | 'struct' | 'type' | 'function' | 'method';

export interface SymbolOut {
  kind: SymbolKind;
  name: string;
  line_start?: number;
  line_end?: number;
  signature?: string;
  doc?: string;
  exported?: boolean;
  stub?: boolean;
  file?: string;
  lang?: string;
}

export type EdgeType = 'CONTAINS' | 'IMPORTS' | 'CALLS' | 'INHERITS' | 'IMPLEMENTS';

export interface EdgeOut {
  type: EdgeType;
  head: string;
  tail: string;
  confidence: number;
  resolution: 'syntax' | 'heuristic' | 'lsp';
}

export interface ChunkOut {
  symbol: string;
  kind?: string;
  content: string;
}

export interface FileOut {
  path: string;
  sha256: string;
  lang: string;
  symbols: SymbolOut[];
  edges: EdgeOut[];
  chunks: ChunkOut[];
}

export interface IndexBatch {
  compilationId: string;
  repo: { name: string; root: string; commit: string | null };
  classificationLevelId?: string;
  files: FileOut[];
  removed: string[];
}

export interface WalkedFile {
  path: string;
  abs: string;
  sha256: string;
  lang: Lang | 'other';
  size: number;
}
