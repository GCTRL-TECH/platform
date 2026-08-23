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
});
