import path from 'node:path';
import type { Lang } from './parser.js';
import type { EdgeOut, SymbolOut, WalkedFile } from './types.js';
import type { Extracted, RawImport, RawSymbol } from './extract/types.js';

export const symName = (p: string, qualname: string) => `${p}::${qualname}`;
const posix = (p: string) => p.split(path.sep).join('/');

export interface RepoIndex {
  files: Map<string, { walked: WalkedFile; ex: Extracted }>;
  symbolsByFile: Map<string, RawSymbol[]>;
  byBareName: Map<string, string[]>;
  allPaths: Set<string>;
}

export function buildRepoIndex(files: Array<{ walked: WalkedFile; ex: Extracted }>): RepoIndex {
  const idx: RepoIndex = { files: new Map(), symbolsByFile: new Map(), byBareName: new Map(), allPaths: new Set() };
  for (const f of files) {
    idx.files.set(f.walked.path, f); idx.allPaths.add(f.walked.path);
    idx.symbolsByFile.set(f.walked.path, f.ex.symbols);
    for (const s of f.ex.symbols) {
      const full = symName(f.walked.path, s.qualname);
      const arr = idx.byBareName.get(s.name) ?? []; arr.push(full); idx.byBareName.set(s.name, arr);
    }
  }
  return idx;
}

function firstExisting(idx: RepoIndex, candidates: string[]): string | null {
  for (const c of candidates) { const n = posix(path.normalize(c)).replace(/^\.\//, ''); if (idx.allPaths.has(n)) return n; }
  return null;
}

function ancestors(p: string): string[] { const out: string[] = []; let d = path.posix.dirname(p); while (true) { out.push(d === '.' ? '' : d); if (d === '.' || d === '') break; d = path.posix.dirname(d); } return out; }

export function resolveImport(fromPath: string, imp: RawImport, lang: Lang, idx: RepoIndex): string | null {
  const dir = path.posix.dirname(fromPath) === '.' ? '' : path.posix.dirname(fromPath);
  if (lang === 'python') {
    const mod = imp.module.replace(/\./g, '/');
    if (imp.relativeLevel) {
      let base = dir; for (let i = 1; i < imp.relativeLevel; i++) base = path.posix.dirname(base);
      const rel = mod ? path.posix.join(base, mod) : base;
      const viaName = imp.names.length === 1 && imp.names[0] !== '*' ? [path.posix.join(rel, imp.names[0] + '.py')] : [];
      return firstExisting(idx, [`${rel}.py`, `${rel}/__init__.py`, ...viaName]);
    }
    const cands: string[] = [];
    for (const a of ancestors(fromPath)) { const base = a ? `${a}/${mod}` : mod; cands.push(`${base}.py`, `${base}/__init__.py`); }
    return firstExisting(idx, cands);
  }
  if (lang === 'typescript' || lang === 'tsx' || lang === 'javascript') {
    if (!imp.module.startsWith('.')) return null;
    const base = path.posix.join(dir, imp.module).replace(/\.(js|mjs|cjs|jsx)$/, '');
    const exts = ['.ts', '.tsx', '.mts', '.js', '.mjs', '.jsx', '.cjs'];
    return firstExisting(idx, [...exts.map(e => base + e), ...exts.map(e => `${base}/index${e}`)]);
  }
  if (lang === 'rust') {
    if (imp.alias === 'mod') {                                   // `mod foo;`
      const stem = path.posix.basename(fromPath) === 'mod.rs' || /(main|lib)\.rs$/.test(fromPath) ? dir : fromPath.replace(/\.rs$/, '');
      return firstExisting(idx, [`${stem}/${imp.module}.rs`, `${stem}/${imp.module}/mod.rs`]);
    }
    const parts = imp.module.split('::').filter(Boolean);
    if (!parts.length) return null;
    // crate root = nearest ancestor dir containing lib.rs or main.rs (usually "src")
    let root = dir; while (root && !idx.allPaths.has(`${root}/lib.rs`) && !idx.allPaths.has(`${root}/main.rs`)) root = path.posix.dirname(root) === '.' ? '' : path.posix.dirname(root);
    const first = parts[0];
    let segs: string[];
    if (first === 'crate') segs = parts.slice(1);
    else if (first === 'self') { segs = parts.slice(1); root = dir; }
    else if (first === 'super') { segs = parts.slice(1); root = path.posix.dirname(dir); }
    else segs = parts.slice(1);                                    // external crate name or own lib name -> try under crate root
    const tryPath = (s: string[]) => s.length ? firstExisting(idx, [`${root}/${s.join('/')}.rs`, `${root}/${s.join('/')}/mod.rs`]) : firstExisting(idx, [`${root}/lib.rs`]);
    // `use crate::util::math;` names the last segment via `names`, not `module` — the
    // resolved item may itself be a submodule file (math.rs), which the mod.rs-of-parent
    // fallback below would miss. Try module+name as a path first.
    if (imp.names.length === 1 && imp.names[0] !== '*') {
      const viaName = tryPath([...segs, imp.names[0]]);
      if (viaName) return viaName;
    }
    return tryPath(segs) ?? (segs.length > 1 ? tryPath(segs.slice(0, -1)) : null);
  }
  return null;
}

export function fileOutputs(idx: RepoIndex, p: string): { symbols: SymbolOut[]; edges: EdgeOut[] } {
  const entry = idx.files.get(p); if (!entry) return { symbols: [], edges: [] };
  const { walked, ex } = entry; const lang = walked.lang as Lang;
  const symbols: SymbolOut[] = []; const edges: EdgeOut[] = [];
  const seenSym = new Set<string>(); const seenEdge = new Set<string>();
  const addSym = (s: SymbolOut) => { if (!seenSym.has(s.name)) { seenSym.add(s.name); symbols.push(s); } };
  const addEdge = (e: EdgeOut) => { const k = `${e.type}|${e.head}|${e.tail}`; if (e.head !== e.tail && !seenEdge.has(k)) { seenEdge.add(k); edges.push(e); } };
  const stub = (full: string, kind: SymbolOut['kind']) => { const file = full.split('::')[0]; if (file !== p) addSym({ kind, name: full, stub: true, file }); };
  const localFull = (q: string) => symName(p, q);
  const localByName = new Map<string, RawSymbol[]>();
  for (const s of ex.symbols) { const a = localByName.get(s.name) ?? []; a.push(s); localByName.set(s.name, a); }

  addSym({ kind: 'file', name: p, lang });
  for (const s of ex.symbols) {
    addSym({ kind: s.kind, name: localFull(s.qualname), line_start: s.line_start, line_end: s.line_end, signature: s.signature, doc: s.doc, exported: s.exported, lang });
    addEdge({ type: 'CONTAINS', head: s.parent ? localFull(s.parent) : p, tail: localFull(s.qualname), confidence: 1, resolution: 'syntax' });
  }
  // imports -> file or module ; remember name -> (file, name) bindings for call resolution
  const binding = new Map<string, { file: string | null; name?: string }>();   // local identifier -> where it comes from
  for (const imp of ex.imports) {
    const target = resolveImport(p, imp, lang, idx);
    if (target) { addSym({ kind: 'file', name: target, stub: true, file: target }); addEdge({ type: 'IMPORTS', head: p, tail: target, confidence: 1, resolution: 'syntax' }); }
    else { const modName = imp.module || imp.names[0] || ''; if (modName && imp.alias !== 'mod') { addSym({ kind: 'module', name: modName }); addEdge({ type: 'IMPORTS', head: p, tail: modName, confidence: 1, resolution: 'syntax' }); } }
    if (imp.alias && imp.alias !== 'mod') binding.set(imp.alias, { file: target });                // ns.x() / pb.helper()
    for (const n of imp.names) if (n !== '*' && n !== 'default') binding.set(n, { file: target, name: n });
    if (imp.names.includes('default') && imp.alias) binding.set(imp.alias, { file: target, name: 'default' });
    if (lang === 'python' && !imp.names.length && !imp.alias && !imp.relativeLevel) binding.set(imp.module.split('.')[0], { file: target }); // import pkg.b ; pkg.b.helper()
  }
  const findIn = (file: string | null, name: string): string | null => {
    if (!file) return null; const syms = idx.symbolsByFile.get(file) ?? [];
    const hit = syms.filter(s => s.name === name && s.kind !== 'method'); if (hit.length === 1) return symName(file, hit[0].qualname);
    const anyHit = syms.filter(s => s.name === name); return anyHit.length === 1 ? symName(file, anyHit[0].qualname) : null;
  };
  // inheritance
  for (const inh of ex.inherits) {
    const parentName = inh.parent.split('.').pop()!;
    const local = localByName.get(parentName)?.find(s => s.kind !== 'method');
    let tail: string | null = local ? localFull(local.qualname) : null;
    if (!tail) { const b = binding.get(parentName) ?? binding.get(inh.parent.split('.')[0]); tail = b ? findIn(b.file, parentName) : null; }
    if (!tail) { const g = idx.byBareName.get(parentName) ?? []; if (g.length === 1) tail = g[0]; }
    if (tail) { stub(tail, local?.kind ?? 'class'); addEdge({ type: inh.kind, head: localFull(inh.child), tail, confidence: 1, resolution: 'syntax' }); }
  }
  // calls
  for (const c of ex.calls) {
    if (!c.inside) continue;
    const head = localFull(c.inside);
    let tail: string | null = null; let conf = 0.6;
    const enclosingClass = c.inside.includes('.') ? c.inside.split('.').slice(0, -1).join('.') : null;
    if ((c.receiver === 'self' || c.receiver === 'this') && enclosingClass) {
      const m = localByName.get(c.callee)?.find(s => s.parent === enclosingClass); if (m) tail = localFull(m.qualname);
    } else if (c.receiver && binding.has(c.receiver)) {
      tail = findIn(binding.get(c.receiver)!.file, c.callee);
    } else if (c.receiver) {
      // receiver may be a local class/var: Engine::new, Thing.run ; try Class.method locally, then via imported class, then unique method globally
      const cls = localByName.get(c.receiver)?.find(s => s.kind === 'class' || s.kind === 'struct');
      const m = cls ? localByName.get(c.callee)?.find(s => s.parent === cls.qualname) : undefined;
      if (m) tail = localFull(m.qualname);
      else if (binding.has(c.receiver)) tail = findIn(binding.get(c.receiver)!.file, c.callee);
      else { const b = binding.get(c.receiver); const viaFile = b ? findIn(b.file, c.callee) : null; tail = viaFile; }
      if (!tail) { // local var of a known class in this file? (t = Thing(); t.run()) -> unique method name in file
        const ms = localByName.get(c.callee)?.filter(s => s.kind === 'method'); if (ms && ms.length === 1) tail = localFull(ms[0].qualname);
      }
    } else {
      const loc = localByName.get(c.callee)?.filter(s => s.kind !== 'method');
      if (loc && loc.length === 1) tail = localFull(loc[0].qualname);
      else if (binding.has(c.callee)) tail = findIn(binding.get(c.callee)!.file, c.callee);
    }
    if (!tail) { const g = idx.byBareName.get(c.callee) ?? []; if (g.length === 1) { tail = g[0]; conf = 0.4; } }
    if (tail && tail !== head) { const kind = (idx.symbolsByFile.get(tail.split('::')[0]) ?? []).find(s => symName(tail!.split('::')[0], s.qualname) === tail)?.kind ?? 'function'; stub(tail, kind); addEdge({ type: 'CALLS', head, tail, confidence: conf, resolution: 'heuristic' }); }
  }
  return { symbols, edges };
}
