import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import type { Ignore, Options as IgnoreOptions } from 'ignore';
import { langForPath } from './parser.js';
import type { WalkedFile } from './types.js';

// `ignore`'s .d.ts declares `export default ignore` but ships as a plain CJS
// `module.exports = factory` with no "type": "module" in its package.json. Under
// this project's `moduleResolution: Node16`, TS resolves that as a CommonJS
// impliedFormat module and types the ESM default import as the whole module
// namespace (not callable) rather than the factory function - a known interop
// gap for this package's types. `createRequire` sidesteps it (same pattern
// already used in parser.ts for the tree-sitter wasm loader): grab the real
// runtime factory via `require`, and pull the `Ignore`/`Options` types
// separately as a type-only import (unaffected, since those are named exports).
const require = createRequire(import.meta.url);
const ignore = require('ignore') as (options?: IgnoreOptions) => Ignore;

export const HARD_EXCLUDES = new Set(['.git', 'node_modules', 'target', 'dist', 'build', '__pycache__', '.venv', 'venv', '.next', '.turbo', 'coverage']);
export const MAX_FILE_BYTES = 1024 * 1024;

/**
 * Loads a directory's .gitignore (if any) merged with the parent's already-parsed
 * rules, so nested .gitignore files apply to their subtree while root-level rules
 * keep applying below.
 *
 * `ignore`'s public API has no "merge two Ignore instances" method, so we reach
 * into its internal `_rules` (present as `{ origin: string }[]` in the installed
 * ignore@5.3.2) to recover the parent's original pattern lines and re-add them to
 * a fresh instance alongside this directory's own .gitignore content. If a future
 * `ignore` version drops `_rules`, this falls back to just this directory's own
 * .gitignore (losing inherited parent rules below that point) rather than throwing.
 */
function loadIgnore(dir: string, parent: Ignore | null): Ignore | null {
  const gi = path.join(dir, '.gitignore');
  if (!fs.existsSync(gi)) return parent;
  const ig = ignore();
  const parentRules = (parent as unknown as { _rules?: { origin: string }[] } | null)?._rules;
  if (parentRules) ig.add(parentRules.map((r) => r.origin));
  ig.add(fs.readFileSync(gi, 'utf8'));
  return ig;
}

function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

export async function walkRepo(root: string): Promise<WalkedFile[]> {
  const absRoot = path.resolve(root);
  const out: WalkedFile[] = [];
  const stack: Array<{ dir: string; ig: Ignore | null }> = [{ dir: absRoot, ig: loadIgnore(absRoot, null) }];
  while (stack.length) {
    const { dir, ig } = stack.pop()!;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { continue; }                                  // unreadable directory: skip its subtree
    for (const ent of entries) {
      const abs = path.join(dir, ent.name);
      const rel = path.relative(absRoot, abs).split(path.sep).join('/');
      if (ent.isDirectory()) {
        if (HARD_EXCLUDES.has(ent.name)) continue;
        if (ig && ig.ignores(rel + '/')) continue;
        stack.push({ dir: abs, ig: loadIgnore(abs, ig) });
        continue;
      }
      if (!ent.isFile()) continue;
      if (ig && ig.ignores(rel)) continue;
      // One unreadable entry (permission denied, broken symlink, file deleted
      // between readdir and stat) must never abort the whole walk - skip it and
      // keep going, exactly like an ignored file.
      try {
        const st = fs.statSync(abs);
        if (st.size > MAX_FILE_BYTES) continue;
        const buf = fs.readFileSync(abs);
        if (looksBinary(buf)) continue;
        out.push({
          path: rel,
          abs,
          size: st.size,
          sha256: crypto.createHash('sha256').update(buf).digest('hex'),
          lang: langForPath(rel),
        });
      } catch {
        continue;
      }
    }
  }
  out.sort((a, b) => (a.path < b.path ? -1 : 1));
  return out;
}
