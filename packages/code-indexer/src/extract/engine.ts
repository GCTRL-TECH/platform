import { parseSource, type Lang, type SyntaxNode } from '../parser.js';
import type { Extracted, LanguageExtractor } from './types.js';
import { pythonExtractor } from './python.js';
import { tsExtractor } from './typescript.js'; // Task 4
import { rustExtractor } from './rust.js'; // Task 5

const EXTRACTORS: Partial<Record<Lang, LanguageExtractor>> = {
  python: pythonExtractor,
  typescript: tsExtractor,
  tsx: tsExtractor,
  javascript: tsExtractor,
  rust: rustExtractor,
};

export async function extractFile(lang: Lang, source: string): Promise<Extracted> {
  const ex = EXTRACTORS[lang];
  if (!ex) return { symbols: [], imports: [], calls: [], inherits: [], assigns: [] };
  const tree = await parseSource(lang, source);
  try {
    return ex.extract(tree, source);
  } finally {
    tree.delete();
  }
}

/** Walk all nodes depth-first. */
export function* walk(node: SyntaxNode): Generator<SyntaxNode> {
  yield node;
  for (let i = 0; i < node.namedChildCount; i++) yield* walk(node.namedChild(i)!);
}

/** First line of a node's text, trimmed, capped. */
export function firstLine(src: string, node: SyntaxNode, cap = 300): string {
  const t = src.slice(node.startIndex, node.endIndex);
  const nl = t.indexOf('\n');
  return (nl === -1 ? t : t.slice(0, nl)).trim().slice(0, cap);
}

/** Strip quotes from a string literal node's text. */
export function unquote(t: string): string {
  return t.replace(/^[rRbBuUfF]*("""|'''|"|')/, '').replace(/("""|'''|"|')$/, '').trim();
}
