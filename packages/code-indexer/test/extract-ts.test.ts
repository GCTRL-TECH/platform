import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractFile } from '../src/extract/engine.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const read = (p: string) => fs.readFileSync(path.join(here, 'fixtures', 'ts', p), 'utf8');

describe('typescript extractor', () => {
  it('finds functions, arrow consts, classes, methods, interfaces, enums, types with export flag', async () => {
    const ex = await extractFile('typescript', read('src/util.ts'));
    const q = Object.fromEntries(ex.symbols.map(s => [s.qualname, s]));
    expect(q['add']).toMatchObject({ kind: 'function', exported: true, line_start: 1 });
    expect(q['mul']).toMatchObject({ kind: 'function', exported: true });
    expect(q['hidden']).toMatchObject({ kind: 'function', exported: false });
    expect(q['Shape'].kind).toBe('interface');
    expect(q['Color'].kind).toBe('enum');
    expect(q['Id'].kind).toBe('type');
    const u = await extractFile('typescript', read('src/models/user.ts'));
    const uq = Object.fromEntries(u.symbols.map(s => [s.qualname, s]));
    expect(uq['User.greet']).toMatchObject({ kind: 'method', parent: 'User', doc: 'Greets.' });
    expect(uq['User.shout'].kind).toBe('method');
    expect(u.inherits).toEqual(expect.arrayContaining([
      { child: 'User', parent: 'Base', kind: 'INHERITS' },
      { child: 'User', parent: 'Printable', kind: 'IMPLEMENTS' },
    ]));
  });
  it('records imports and calls', async () => {
    const ex = await extractFile('typescript', read('src/index.ts'));
    expect(ex.imports).toEqual(expect.arrayContaining([
      expect.objectContaining({ module: './models/user', names: ['User'] }),
      expect.objectContaining({ module: './util', names: [], alias: 'util' }),
      expect.objectContaining({ module: 'node:fs', names: ['default'], alias: 'fs' }),
    ]));
    expect(ex.calls).toEqual(expect.arrayContaining([
      expect.objectContaining({ callee: 'User', inside: 'main' }),             // new User()
      expect.objectContaining({ callee: 'greet', receiver: 'u', inside: 'main' }),
      expect.objectContaining({ callee: 'add', receiver: 'util', inside: 'main' }),
    ]));
  });
  it('records local constructor-binding assignments', async () => {
    const ex = await extractFile('typescript', read('src/index.ts'));
    expect(ex.assigns).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'u', ctor: 'User', inside: 'main' }),
    ]));
  });
  it('records localsByScope: destructured hook-setter names and a nested function param, scoped separately', async () => {
    const src = 'export function App(){ const [mode, setMode] = useState(1); function inner(cb){ cb() } }';
    const ex = await extractFile('typescript', src);
    expect(ex.localsByScope['App']).toEqual(expect.arrayContaining(['mode', 'setMode']));
    expect(ex.localsByScope['App.inner']).toEqual(['cb']);
  });
  it('marks calls anonymous when they cross an anonymous callback, but not a named arrow-const or a bare top-level call', async () => {
    const src = [
      "helper();",                                                          // true top-level, no anonymous crossing
      "router.get('/x', async () => { helper2() });",                       // anonymous callback at top level
      "export function named(){ [1].map(() => helper3()) }",               // anonymous callback nested in a named fn
      "const f = () => { helper4() };",                                     // named arrow-const: not anonymous
      "React.forwardRef((props, ref) => { helper5() });",                   // anonymous callback wrapping a call arg
    ].join('\n');
    const ex = await extractFile('typescript', src);
    const byCallee = Object.fromEntries(ex.calls.map(c => [c.callee, c]));
    expect(byCallee['helper']).toMatchObject({ inside: undefined, anonymous: undefined });
    expect(byCallee['helper2']).toMatchObject({ inside: undefined, anonymous: true });
    expect(byCallee['helper3']).toMatchObject({ inside: 'named', anonymous: true });
    expect(byCallee['helper4']).toMatchObject({ inside: 'f', anonymous: undefined });
    expect(byCallee['helper5']).toMatchObject({ inside: undefined, anonymous: true });
  });
});
