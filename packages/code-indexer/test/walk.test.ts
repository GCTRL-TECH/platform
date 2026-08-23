import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { walkRepo } from '../src/walk.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const root = path.join(__dirname, 'fixtures', 'walk');

describe('walkRepo', () => {
  it('honours .gitignore, hard excludes, size and binary filters', async () => {
    const files = await walkRepo(root);
    const paths = files.map((f) => f.path);
    expect(paths).toContain('keep.py');
    expect(paths).toContain('sub/a.ts');
    expect(paths).not.toContain('ignored.log'); // .gitignore: *.log
    expect(paths.some((p) => p.startsWith('node_modules/'))).toBe(false);
    expect(paths).not.toContain('big.bin'); // binary (NUL bytes)
    const keep = files.find((f) => f.path === 'keep.py')!;
    expect(keep.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(keep.lang).toBe('python');
  });
});
