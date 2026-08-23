import { describe, it, expect } from 'vitest';
import { parseSource, langForPath } from '../src/parser.js';

describe('parser runtime', () => {
  it('detects languages from extensions', () => {
    expect(langForPath('a/b.py')).toBe('python');
    expect(langForPath('a/b.ts')).toBe('typescript');
    expect(langForPath('a/b.tsx')).toBe('tsx');
    expect(langForPath('a/b.mjs')).toBe('javascript');
    expect(langForPath('a/b.rs')).toBe('rust');
    expect(langForPath('a/b.md')).toBe('other');
  });
  it('parses python, typescript and rust with the bundled wasm grammars', async () => {
    const py = await parseSource('python', 'def f():\n    return 1\n');
    expect(py.rootNode.type).toBe('module');
    const ts = await parseSource('typescript', 'export function f(): number { return 1 }');
    expect(ts.rootNode.type).toBe('program');
    const rs = await parseSource('rust', 'fn main() {}');
    expect(rs.rootNode.type).toBe('source_file');
  });
});
