import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { walkRepo } from '../src/walk.js';
import { extractFile } from '../src/extract/engine.js';
import { buildRepoIndex, fileOutputs, resolveImport } from '../src/resolve.js';

const here = fileURLToPath(new URL('.', import.meta.url));
async function indexFixture(name: string) {
  const walked = await walkRepo(path.join(here, 'fixtures', name));
  const files = [];
  for (const w of walked) if (w.lang !== 'other') files.push({ walked: w, ex: await extractFile(w.lang, fs.readFileSync(w.abs, 'utf8')) });
  return buildRepoIndex(files);
}

describe('resolver', () => {
  it('python: relative + package imports resolve to files; calls resolve same-file, imported and self', async () => {
    const idx = await indexFixture('py');
    expect(resolveImport('pkg/a.py', { module: 'b', names: ['helper'], relativeLevel: 1, line: 1 }, 'python', idx)).toBe('pkg/b.py');
    expect(resolveImport('main.py', { module: 'pkg.a', names: ['top'], line: 1 }, 'python', idx)).toBe('pkg/a.py');
    expect(resolveImport('pkg/a.py', { module: 'os', names: [], line: 1 }, 'python', idx)).toBeNull();
    const out = fileOutputs(idx, 'pkg/a.py');
    const edges = out.edges.map(e => `${e.type} ${e.head} -> ${e.tail} (${e.confidence})`);
    expect(edges).toContain('CONTAINS pkg/a.py -> pkg/a.py::Thing (1)');
    expect(edges).toContain('CONTAINS pkg/a.py::Thing -> pkg/a.py::Thing.run (1)');
    expect(edges).toContain('IMPORTS pkg/a.py -> pkg/b.py (1)');
    expect(edges).toContain('IMPORTS pkg/a.py -> os (1)');
    expect(edges).toContain('INHERITS pkg/a.py::Thing -> pkg/b.py::Base (1)');
    expect(edges).toContain('CALLS pkg/a.py::Thing.run -> pkg/b.py::helper (0.6)');
    expect(edges).toContain('CALLS pkg/a.py::Thing.run -> pkg/a.py::Thing.twice (0.6)');
    expect(edges).toContain('CALLS pkg/a.py::top -> pkg/a.py::Thing.run (0.6)');   // t = Thing() ; t.run()
    // stubs + module symbols present
    expect(out.symbols).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'function', name: 'pkg/b.py::helper', stub: true, file: 'pkg/b.py' }),
      expect.objectContaining({ kind: 'module', name: 'os' }),
      // INHERITS stub kind must come from a real lookup (Base is a class), not a hardcoded default
      expect.objectContaining({ name: 'pkg/b.py::Base', stub: true, kind: 'class' }),
    ]));
    // never an edge to a non-existent target
    expect(out.edges.every(e => e.type !== 'CALLS' || out.symbols.some(s => s.name === e.tail))).toBe(true);
  });
  it('typescript: relative imports with/without extension, namespace import calls', async () => {
    const idx = await indexFixture('ts');
    expect(resolveImport('src/index.ts', { module: './models/user', names: ['User'], line: 1 }, 'typescript', idx)).toBe('src/models/user.ts');
    expect(resolveImport('src/models/user.ts', { module: '../util.js', names: ['add'], line: 1 }, 'typescript', idx)).toBe('src/util.ts');
    const out = fileOutputs(idx, 'src/index.ts');
    const edges = out.edges.map(e => `${e.type} ${e.head} -> ${e.tail}`);
    expect(edges).toContain('CALLS src/index.ts::main -> src/models/user.ts::User');
    expect(edges).toContain('CALLS src/index.ts::main -> src/util.ts::add');
    expect(edges).toContain('CALLS src/index.ts::main -> src/models/user.ts::User.greet');
    expect(edges).toContain('IMPORTS src/index.ts -> node:fs');
  });
  it('rust: mod and use resolve to files; scoped calls resolve', async () => {
    const idx = await indexFixture('rust');
    expect(resolveImport('src/lib.rs', { module: 'util', names: [], alias: 'mod', line: 1 }, 'rust', idx)).toBe('src/util/mod.rs');
    expect(resolveImport('src/main.rs', { module: 'mylib::util', names: ['math'], line: 1 }, 'rust', idx)).toBe('src/util/math.rs');
    const out = fileOutputs(idx, 'src/main.rs');
    const edges = out.edges.map(e => `${e.type} ${e.head} -> ${e.tail}`);
    expect(edges).toContain('CALLS src/main.rs::main -> src/lib.rs::Engine.new');
    expect(edges).toContain('CALLS src/main.rs::main -> src/util/math.rs::add');
  });
});
