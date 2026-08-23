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
    expect(edges).toContain('IMPORTS src/index.ts -> node:fs');
    // u.greet(...): 'u' has no import binding, but `const u = new User()` is tracked as a
    // local constructor binding (RawAssign) - resolves User -> its file, then finds the
    // `greet` method on it. This used to be excluded on purpose (c30ade3, before local
    // constructor binding existed); now that the receiver's origin is actually known
    // (not guessed), the repo-wide bare-name path isn't even needed for this case.
    expect(edges).toContain('CALLS src/index.ts::main -> src/models/user.ts::User.greet');
  });
  it('typescript: tsconfig baseUrl/paths resolves a non-relative "@/..." specifier', async () => {
    const idx = await indexFixture('ts-paths');
    expect(resolveImport('src/app.ts', { module: '@/lib/util', names: ['add'], line: 1 }, 'typescript', idx)).toBe('src/lib/util.ts');
    const out = fileOutputs(idx, 'src/app.ts');
    const edges = out.edges.map(e => `${e.type} ${e.head} -> ${e.tail} (${e.confidence})`);
    expect(edges).toContain('CALLS src/app.ts::main -> src/lib/util.ts::add (0.6)');
  });
  it('rust: mod and use resolve to files; scoped calls resolve', async () => {
    const idx = await indexFixture('rust');
    expect(resolveImport('src/lib.rs', { module: 'util', names: [], alias: 'mod', line: 1 }, 'rust', idx)).toBe('src/util/mod.rs');
    expect(resolveImport('src/main.rs', { module: 'mylib::util', names: ['math'], line: 1 }, 'rust', idx)).toBe('src/util/math.rs');
    const out = fileOutputs(idx, 'src/main.rs');
    const edges = out.edges.map(e => `${e.type} ${e.head} -> ${e.tail}`);
    expect(edges).toContain('CALLS src/main.rs::main -> src/lib.rs::Engine.new');
    expect(edges).toContain('CALLS src/main.rs::main -> src/util/math.rs::add');
    // let e = Engine::new(); e.run() - local constructor binding resolves 'e' -> Engine
    // (defined in lib.rs, a different file) -> Engine.run.
    expect(edges).toContain('CALLS src/main.rs::main -> src/lib.rs::Engine.run');
  });
  it('refined bare-name fallback (0.4): a unique non-generic method resolves through an unresolved receiver; generic/short callees never fall back, receiver or not', () => {
    const rawSym = (kind: 'function' | 'method' | 'class', qualname: string, name = qualname, parent?: string) => ({
      kind, qualname, name, line_start: 1, line_end: 2, signature: '', doc: '', exported: true, parent,
    });
    const walked = (p: string) => ({ path: p, abs: p, sha256: 'x', lang: 'python' as const, size: 0 });
    const idx = buildRepoIndex([
      { walked: walked('installer.py'), ex: { symbols: [rawSym('function', 'info')], imports: [], calls: [], inherits: [], assigns: [], localsByScope: {} } },
      {
        walked: walked('kg.py'),
        ex: {
          symbols: [rawSym('class', 'KGBuilder'), rawSym('method', 'KGBuilder.build_graph', 'build_graph', 'KGBuilder')],
          imports: [], calls: [], inherits: [], assigns: [], localsByScope: {},
        },
      },
      {
        walked: walked('b.py'),
        ex: {
          symbols: [rawSym('function', 'run')],
          imports: [],
          calls: [
            { callee: 'info', receiver: 'logger', inside: 'run', line: 1 },       // generic callee + unbound receiver -> no edge
            { callee: 'info', inside: 'run', line: 2 },                          // generic callee, receiver-less -> STILL no edge (stop-list, not just the receiver rule)
            { callee: 'build_graph', receiver: 'kg', inside: 'run', line: 3 },    // non-generic, unique method, unbound receiver -> resolves (0.4)
          ],
          inherits: [], assigns: [], localsByScope: {},
        },
      },
    ]);
    const out = fileOutputs(idx, 'b.py');
    const callsEdges = out.edges.filter(e => e.type === 'CALLS');
    expect(callsEdges).toHaveLength(1);
    expect(callsEdges[0]).toMatchObject({ type: 'CALLS', head: 'b.py::run', tail: 'kg.py::KGBuilder.build_graph', confidence: 0.4 });
  });
  it('round 2 guards: same-language family, external-binding block, extended stop-list', () => {
    const rawSym = (kind: 'function' | 'method' | 'class', qualname: string, name = qualname, parent?: string) => ({
      kind, qualname, name, line_start: 1, line_end: 2, signature: '', doc: '', exported: true, parent,
    });
    const walked = (p: string, lang: 'python' | 'typescript' | 'rust' = 'typescript') => ({ path: p, abs: p, sha256: 'x', lang, size: 0 });
    const idx = buildRepoIndex([
      // cross-language guard: a unique `login` lives in Rust; a TS file calls login() bare.
      { walked: walked('auth.rs', 'rust'), ex: { symbols: [rawSym('function', 'login')], imports: [], calls: [], inherits: [], assigns: [], localsByScope: {} } },
      // external-binding guard: `createClient` is both a real repo symbol (cli/api.ts) and
      // imported from an external package ('redis') in the caller file below.
      { walked: walked('cli/api.ts'), ex: { symbols: [rawSym('function', 'createClient')], imports: [], calls: [], inherits: [], assigns: [], localsByScope: {} } },
      // stop-list: a unique `resolve` method elsewhere must never satisfy a bare
      // `resolve(...)` Promise-executor-style call.
      { walked: walked('promise-like.ts'), ex: { symbols: [rawSym('method', 'Deferred.resolve', 'resolve', 'Deferred')], imports: [], calls: [], inherits: [], assigns: [], localsByScope: {} } },
      {
        walked: walked('app.ts'),
        ex: {
          symbols: [rawSym('function', 'main')],
          imports: [{ module: 'redis', names: ['createClient'], line: 1 }],
          calls: [
            { callee: 'login', inside: 'main', line: 1 },        // unique but cross-language (Rust) -> no edge
            { callee: 'createClient', inside: 'main', line: 2 }, // bound to an unresolved external import -> no edge
            { callee: 'resolve', inside: 'main', line: 3 },      // stop-list -> no edge
          ],
          inherits: [], assigns: [], localsByScope: {},
        },
      },
    ]);
    const out = fileOutputs(idx, 'app.ts');
    expect(out.edges.filter(e => e.type === 'CALLS')).toHaveLength(0);
  });
  it('round 3: rust receiver calls never use the 0.4 fallback (bare calls still may)', () => {
    const rawSym = (kind: 'function' | 'method' | 'struct', qualname: string, name = qualname, parent?: string) => ({
      kind, qualname, name, line_start: 1, line_end: 2, signature: '', doc: '', exported: true, parent,
    });
    const walked = (p: string) => ({ path: p, abs: p, sha256: 'x', lang: 'rust' as const, size: 0 });
    const idx = buildRepoIndex([
      // `struct S; impl S { fn is_empty(&self) -> bool { true } }` - a receiver call to
      // this unique-in-fixture method must never fall back (round 3 disables the
      // receiver-call fallback for rust outright, independent of GENERIC_CALLEES also
      // stop-listing `is_empty` by name - the shape rule covers names that aren't
      // explicitly listed too).
      { walked: walked('session.rs'), ex: { symbols: [rawSym('struct', 'S'), rawSym('method', 'S.is_empty', 'is_empty', 'S')], imports: [], calls: [], inherits: [], assigns: [], localsByScope: {} } },
      { walked: walked('other.rs'), ex: { symbols: [rawSym('function', 'helper')], imports: [], calls: [], inherits: [], assigns: [], localsByScope: {} } },
      {
        walked: walked('main.rs'),
        ex: {
          symbols: [rawSym('function', 'main')],
          imports: [],
          calls: [
            { callee: 'is_empty', receiver: 'name', inside: 'main', line: 1 },  // receiver call, unique method -> NO edge (round 3)
            { callee: 'helper', inside: 'main', line: 2 },                      // bare call, unique fn -> still resolves (0.4)
          ],
          inherits: [], assigns: [], localsByScope: {},
        },
      },
    ]);
    const out = fileOutputs(idx, 'main.rs');
    const callsEdges = out.edges.filter(e => e.type === 'CALLS');
    expect(callsEdges).toHaveLength(1);
    expect(callsEdges[0]).toMatchObject({ type: 'CALLS', head: 'main.rs::main', tail: 'other.rs::helper', confidence: 0.4 });
  });
  it('round 3: a bare call whose callee shadows a local binding, directly or via a nested closure, never uses the 0.4 fallback', () => {
    const rawSym = (kind: 'function' | 'method', qualname: string, name = qualname, parent?: string) => ({
      kind, qualname, name, line_start: 1, line_end: 2, signature: '', doc: '', exported: true, parent,
    });
    const walked = (p: string) => ({ path: p, abs: p, sha256: 'x', lang: 'typescript' as const, size: 0 });
    const idx = buildRepoIndex([
      // b.ts defines a `setMode` that is otherwise a unique repo-wide bare name.
      { walked: walked('b.ts'), ex: { symbols: [rawSym('function', 'setMode')], imports: [], calls: [], inherits: [], assigns: [], localsByScope: {} } },
      {
        walked: walked('a.ts'),
        ex: {
          symbols: [rawSym('function', 'App')],
          imports: [],
          calls: [
            { callee: 'setMode', inside: 'App', line: 1 },              // bare call, 'setMode' is a local in its OWN scope 'App' -> no edge
            { callee: 'setMode', inside: 'App.handleBack', line: 2 },    // bare call from a nested named callback that closes over
                                                                          // 'App''s local without redeclaring it -> still no edge
          ],
          inherits: [], assigns: [],
          // `const [mode, setMode] = useState(...)` lives directly in App's own scope, not
          // in the nested 'App.handleBack' callback that references it (real closure shape).
          localsByScope: { App: ['mode', 'setMode'] },
        },
      },
    ]);
    const out = fileOutputs(idx, 'a.ts');
    expect(out.edges.filter(e => e.type === 'CALLS')).toHaveLength(0);
  });
});
