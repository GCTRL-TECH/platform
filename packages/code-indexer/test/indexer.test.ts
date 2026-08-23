import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { indexRepo, makeBatches, MAX_BATCH_BYTES } from '../src/indexer.js';
import { buildChunks } from '../src/chunks.js';
import type { FileOut } from '../src/types.js';

const here = fileURLToPath(new URL('.', import.meta.url));

describe('chunks', () => {
  it('one chunk per function/method/class with header line and cap', () => {
    const src = 'class A:\n    def m(self):\n        return 1\n\ndef f():\n    return 2\n';
    const chunks = buildChunks('x.py', src, [
      { kind: 'class', qualname: 'A', name: 'A', line_start: 1, line_end: 3, signature: 'class A', doc: '', exported: true },
      { kind: 'method', qualname: 'A.m', name: 'm', line_start: 2, line_end: 3, signature: 'def m(self)', doc: '', exported: true, parent: 'A' },
      { kind: 'function', qualname: 'f', name: 'f', line_start: 5, line_end: 6, signature: 'def f()', doc: '', exported: true },
    ]);
    expect(chunks.map(c => c.symbol)).toEqual(['x.py::A', 'x.py::A.m', 'x.py::f']);
    expect(chunks[2].content.startsWith('x.py:L5-L6 def f()\n')).toBe(true);
    expect(chunks[2].content).toContain('return 2');
  });
});

describe('indexRepo', () => {
  it('first run uploads everything; second run with identical manifest uploads nothing but reports removed', async () => {
    const calls: Array<{ method: string; path: string; body?: any }> = [];
    let manifest: Record<string, string> = {};
    const request = async (method: any, p: string, body?: any) => {
      calls.push({ method, path: p, body });
      if (p.startsWith('/kex/code/manifest')) return { repo: 'py', commit: null, files: manifest };
      if (p === '/kex/code') return { jobId: 'job-' + calls.length, status: 'pending' };
      if (p.startsWith('/kex/jobs/')) return { job: { status: 'completed', result: { symbols: 1 } } };
      if (p === '/kg/compilations') return { id: 'comp-new' };
      throw new Error('unexpected ' + p);
    };
    const repoPath = path.join(here, 'fixtures', 'py');
    const s1 = await indexRepo({ repoPath, compilationId: 'comp-1', request, pollMs: 1 });
    expect(s1.filesChanged).toBe(4);                       // __init__.py, pkg/a.py, pkg/b.py, main.py
    const post = calls.find(c => c.path === '/kex/code')!;
    expect(post.body.compilationId).toBe('comp-1');
    expect(post.body.files.some((f: any) => f.path === 'pkg/a.py' && f.symbols.length > 0 && f.chunks.length > 0)).toBe(true);
    // simulate server now knowing all files + one stale path
    manifest = Object.fromEntries(post.body.files.map((f: any) => [f.path, f.sha256]));
    manifest['gone.py'] = 'ff';
    calls.length = 0;
    const s2 = await indexRepo({ repoPath, compilationId: 'comp-1', request, pollMs: 1 });
    expect(s2.filesChanged).toBe(0);
    expect(s2.filesRemoved).toBe(1);
    const post2 = calls.find(c => c.path === '/kex/code')!;
    expect(post2.body.files).toEqual([]);
    expect(post2.body.removed).toEqual(['gone.py']);
  });
  it('creates a CODE compilation when none is given', async () => {
    const request = async (method: any, p: string, body?: any) => {
      if (p === '/kg/compilations') { expect(body.type).toBe('CODE'); return { id: 'comp-new' }; }
      if (p.startsWith('/kex/code/manifest')) return { files: {} };
      if (p === '/kex/code') return { jobId: 'j', status: 'pending' };
      if (p.startsWith('/kex/jobs/')) return { job: { status: 'completed' } };
      throw new Error(p);
    };
    const s = await indexRepo({ repoPath: path.join(here, 'fixtures', 'ts'), request, pollMs: 1 });
    expect(s.compilationId).toBe('comp-new');
  });

  it('a file that fails to parse is neither uploaded nor reported as removed', async () => {
    // Reporting an unparseable-but-present file as "removed" makes the server purge its
    // symbols, edges and chunks - the file is still on disk, so it must simply be skipped.
    let manifest: Record<string, string> = {};
    const bodies: any[] = [];
    const request = async (method: any, p: string, body?: any) => {
      if (p.startsWith('/kex/code/manifest')) return { files: manifest };
      if (p === '/kex/code') { bodies.push(body); return { jobId: 'j' }; }
      if (p.startsWith('/kex/jobs/')) return { job: { status: 'completed' } };
      throw new Error('unexpected ' + p);
    };
    const repoPath = path.join(here, 'fixtures', 'py');
    const boom = async (lang: any, source: string) => {
      if (source.includes('class Base')) throw new Error('synthetic parse failure');
      const { extractFile } = await import('../src/extract/engine.js');
      return extractFile(lang, source);
    };
    // First run: the server already knows every file (so nothing is "changed"), including
    // the one that now fails to parse.
    const probe = await indexRepo({ repoPath, compilationId: 'c', request, pollMs: 1 });
    manifest = Object.fromEntries(bodies[0].files.map((f: any) => [f.path, f.sha256]));
    expect(Object.keys(manifest)).toContain('pkg/b.py');
    bodies.length = 0;
    const s = await indexRepo({ repoPath, compilationId: 'c', request, pollMs: 1, full: true, extract: boom });
    expect(probe.filesTotal).toBe(4);
    expect(s.filesTotal).toBe(3);                                   // pkg/b.py failed to parse
    expect(s.warnings.some(w => w.startsWith('parse failed pkg/b.py'))).toBe(true);
    expect(s.filesRemoved).toBe(0);                                 // NOT purged
    expect(bodies[0].removed).toEqual([]);
    expect(bodies[0].files.map((f: any) => f.path)).not.toContain('pkg/b.py');
  });
});

describe('makeBatches', () => {
  const file = (p: string, bytes: number): FileOut =>
    ({ path: p, sha256: 'x', lang: 'python', symbols: [], edges: [], chunks: [{ symbol: p, kind: 'file', content: 'y'.repeat(bytes) }] }) as unknown as FileOut;

  it('cuts on the file count', () => {
    const batches = makeBatches([file('a', 1), file('b', 1), file('c', 1)], [], 2);
    expect(batches.map(b => b.files.length)).toEqual([2, 1]);
  });

  it('cuts on the accumulated byte budget as well', () => {
    const budget = 5000;
    const batches = makeBatches([file('a', 3000), file('b', 3000), file('c', 1000)], [], 200, budget);
    expect(batches.map(b => b.files.map(f => f.path))).toEqual([['a'], ['b', 'c']]);
    for (const b of batches) expect(JSON.stringify(b.files).length).toBeLessThanOrEqual(budget + 200);
  });

  it('a single oversized file still ships alone rather than being dropped', () => {
    const batches = makeBatches([file('big', 9000), file('small', 10)], [], 200, 5000);
    expect(batches.map(b => b.files.map(f => f.path))).toEqual([['big'], ['small']]);
  });

  it('removed paths ride along with the first batch; default budget is 20 MB', () => {
    expect(MAX_BATCH_BYTES).toBe(20 * 1024 * 1024);
    expect(makeBatches([file('a', 1)], ['gone.py'], 200)[0].removed).toEqual(['gone.py']);
    expect(makeBatches([], ['gone.py'], 200)).toEqual([{ files: [], removed: ['gone.py'] }]);
  });
});
