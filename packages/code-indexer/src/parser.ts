import { createRequire } from 'node:module';
import path from 'node:path';
import { Parser, Language, Tree, Node as SyntaxNode } from 'web-tree-sitter';

export type Lang = 'python' | 'typescript' | 'tsx' | 'javascript' | 'rust';
export type { Tree, Language, SyntaxNode };

const require = createRequire(import.meta.url);

/** tree-sitter-wasms ships prebuilt grammars as out/tree-sitter-<name>.wasm */
const WASM_NAME: Record<Lang, string> = {
  python: 'python', typescript: 'typescript', tsx: 'tsx', javascript: 'javascript', rust: 'rust',
};

const EXT: Record<string, Lang> = {
  '.py': 'python', '.pyi': 'python',
  '.ts': 'typescript', '.mts': 'typescript', '.cts': 'typescript',
  '.tsx': 'tsx',
  '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript', '.jsx': 'javascript',
  '.rs': 'rust',
};

export function langForPath(p: string): Lang | 'other' {
  return EXT[path.extname(p).toLowerCase()] ?? 'other';
}

let initPromise: Promise<void> | null = null;
const langCache = new Map<Lang, Promise<Language>>();

export function initParser(): Promise<void> {
  if (!initPromise) initPromise = Parser.init();
  return initPromise;
}

export function getLanguage(lang: Lang): Promise<Language> {
  let p = langCache.get(lang);
  if (!p) {
    p = (async () => {
      await initParser();
      const wasmPath = require.resolve(`tree-sitter-wasms/out/tree-sitter-${WASM_NAME[lang]}.wasm`);
      return Language.load(wasmPath);
    })();
    langCache.set(lang, p);
  }
  return p;
}

export async function parseSource(lang: Lang, source: string): Promise<Tree> {
  const language = await getLanguage(lang);
  const parser = new Parser();
  parser.setLanguage(language);
  const tree = parser.parse(source);
  parser.delete();
  if (!tree) throw new Error(`tree-sitter failed to parse source as ${lang}`);
  return tree;
}
