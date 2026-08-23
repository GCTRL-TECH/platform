import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractFile } from '../src/extract/engine.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const read = (p: string) => fs.readFileSync(path.join(here, 'fixtures', 'rust', p), 'utf8');

describe('rust extractor', () => {
  it('finds fns, structs, traits, impl methods with visibility', async () => {
    const ex = await extractFile('rust', read('src/lib.rs'));
    const q = Object.fromEntries(ex.symbols.map(s => [s.qualname, s]));
    expect(q['Engine'].kind).toBe('struct');
    expect(q['Engine.new']).toMatchObject({ kind: 'method', parent: 'Engine', exported: true });
    expect(q['Engine.private_step']).toMatchObject({ kind: 'method', exported: false });
    expect(q['Runner'].kind).toBe('interface');
    expect(q['Engine.go']).toMatchObject({ kind: 'method', parent: 'Engine' });
    expect(ex.inherits).toEqual([{ child: 'Engine', parent: 'Runner', kind: 'IMPLEMENTS' }]);
    expect(ex.imports).toEqual(expect.arrayContaining([expect.objectContaining({ module: 'util', names: [], alias: 'mod' })]));
  });
  it('records use declarations and calls', async () => {
    const ex = await extractFile('rust', read('src/main.rs'));
    expect(ex.imports).toEqual(expect.arrayContaining([
      expect.objectContaining({ module: 'mylib', names: ['Engine'] }),
      expect.objectContaining({ module: 'mylib::util', names: ['math'] }),
    ]));
    expect(ex.calls).toEqual(expect.arrayContaining([
      expect.objectContaining({ callee: 'new', receiver: 'Engine', inside: 'main' }),
      expect.objectContaining({ callee: 'run', receiver: 'e', inside: 'main' }),
      expect.objectContaining({ callee: 'add', receiver: 'math', inside: 'main' }),
    ]));
  });
});
