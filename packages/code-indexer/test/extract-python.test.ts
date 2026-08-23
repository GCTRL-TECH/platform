import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractFile } from '../src/extract/engine.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const read = (p: string) => fs.readFileSync(path.join(here, 'fixtures', 'py', p), 'utf8');

describe('python extractor', () => {
  it('finds classes, methods, functions with lines/signature/doc', async () => {
    const ex = await extractFile('python', read('pkg/a.py'));
    const q = Object.fromEntries(ex.symbols.map(s => [s.qualname, s]));
    expect(q['Thing'].kind).toBe('class');
    expect(q['Thing'].doc).toBe('A thing.');
    expect(q['Thing.run'].kind).toBe('method');
    expect(q['Thing.run'].parent).toBe('Thing');
    expect(q['Thing.run'].signature).toBe('def run(self, x)');
    expect(q['Thing.run'].line_start).toBe(9);
    expect(q['top'].kind).toBe('function');
    expect(q['top'].exported).toBe(true);
  });
  it('records imports with relative level and names', async () => {
    const ex = await extractFile('python', read('pkg/a.py'));
    expect(ex.imports).toEqual(expect.arrayContaining([
      expect.objectContaining({ module: 'os', names: [] }),
      expect.objectContaining({ module: 'b', names: ['helper', 'Base'], relativeLevel: 1 }),
    ]));
    const m = await extractFile('python', read('main.py'));
    expect(m.imports).toEqual(expect.arrayContaining([
      expect.objectContaining({ module: 'pkg.a', names: ['top'] }),
      expect.objectContaining({ module: 'pkg.b', names: [], alias: 'pb' }),
    ]));
  });
  it('records calls with receiver and enclosing def, and inheritance', async () => {
    const ex = await extractFile('python', read('pkg/a.py'));
    expect(ex.calls).toEqual(expect.arrayContaining([
      expect.objectContaining({ callee: 'helper', inside: 'Thing.run' }),
      expect.objectContaining({ callee: 'twice', receiver: 'self', inside: 'Thing.run' }),
      expect.objectContaining({ callee: 'Thing', inside: 'top' }),
      expect.objectContaining({ callee: 'run', receiver: 't', inside: 'top' }),
    ]));
    expect(ex.inherits).toEqual([{ child: 'Thing', parent: 'Base', kind: 'INHERITS' }]);
  });
  it('records local constructor-binding assignments', async () => {
    const ex = await extractFile('python', read('pkg/a.py'));
    expect(ex.assigns).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 't', ctor: 'Thing', inside: 'top' }),
    ]));
  });
  it('records localsByScope: params, assignment target, and for-loop target', async () => {
    const src = 'def f(resolve, y):\n    z = 1\n    for k in y:\n        pass\n';
    const ex = await extractFile('python', src);
    expect(ex.localsByScope['f']).toEqual(expect.arrayContaining(['resolve', 'y', 'z', 'k']));
  });
});
