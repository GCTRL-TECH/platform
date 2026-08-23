import path from 'node:path';
import type { Lang } from './parser.js';
import type { EdgeOut, SymbolOut, WalkedFile } from './types.js';
import type { Extracted, RawImport, RawSymbol } from './extract/types.js';
import { findNearestTsconfig, mapSpecifierViaConfig } from './tsPaths.js';

export const symName = (p: string, qualname: string) => `${p}::${qualname}`;
const posix = (p: string) => p.split(path.sep).join('/');

/**
 * Callees too generic/ubiquitous to trust a repo-wide "unique bare name" guess for,
 * even when the name happens to be unique across the indexed repo right now (a
 * second file using the same generic name is only a matter of time). Kept short and
 * literal, no explanation needed callsite-by-callsite.
 */
export const GENERIC_CALLEES = new Set([
  'get', 'set', 'add', 'put', 'post', 'delete', 'remove', 'update', 'run', 'start', 'stop', 'close', 'open',
  'read', 'write', 'append', 'push', 'pop', 'find', 'filter', 'map', 'each', 'send', 'recv', 'exec', 'call',
  'apply', 'bind', 'new', 'init', 'main', 'json', 'text', 'data', 'value', 'len', 'size', 'count', 'next',
  'parse', 'format', 'log', 'info', 'debug', 'warn', 'warning', 'error', 'print', 'dump', 'load', 'save',
  'sleep', 'wait', 'join', 'split', 'strip', 'trim', 'clone', 'copy', 'keys', 'values', 'items', 'insert',
  'index', 'iter', 'into', 'from', 'to', 'as', 'is', 'has', 'ok', 'err', 'unwrap', 'expect', 'default',
  'min', 'max', 'sum',
  // Round 2: bare callback-parameter names (Promise executors, event emitters, iteratee
  // callbacks) that collide with unrelated same-named methods elsewhere far too often to
  // trust a repo-wide unique-name guess (e.g. `resolve(...)`/`reject(...)` inside a `new
  // Promise((resolve, reject) => ...)` executor is never a call to some other file's
  // `resolve` method).
  'resolve', 'reject', 'callback', 'cb', 'done', 'next', 'then', 'catch', 'finally', 'emit', 'on', 'off', 'once',
  // Round 3: common Rust std/trait method names (Option/Result/String/Vec/Iterator/
  // Display/Hash/...) that are near-ubiquitously reimplemented per-type across a repo -
  // a repo-wide "unique name" match for one of these is a coincidence of the sample,
  // not evidence of a real cross-file call (e.g. `x.is_empty()` matching some unrelated
  // `CloakSession::is_empty` must never become a CALLS edge).
  'is_empty', 'is_some', 'is_none', 'is_ok', 'is_err', 'into_response', 'from_str', 'to_string', 'to_owned',
  'to_vec', 'as_str', 'as_ref', 'as_mut', 'unwrap_or', 'unwrap_or_else', 'unwrap_or_default', 'ok_or',
  'ok_or_else', 'map_err', 'and_then', 'or_else', 'collect', 'into_iter', 'contains', 'starts_with',
  'ends_with', 'push_str', 'extend', 'retain', 'get_mut', 'entry', 'or_insert', 'with_capacity', 'first',
  'last', 'build', 'builder', 'try_from', 'try_into', 'eq', 'ne', 'cmp', 'hash', 'fmt',
]);

/** Language "families" for the 0.4-tier same-language guard: a unique bare-name match is
 * only trusted when the candidate symbol's file is written in the same family as the
 * caller - a TS file calling a bare `login()` must never match a Rust `login` just
 * because tree-sitter happened to give it a unique name repo-wide. */
const LANG_FAMILY: Record<string, string> = {
  typescript: 'ts', tsx: 'ts', javascript: 'ts',
  python: 'python',
  rust: 'rust',
};

export interface RepoIndex {
  files: Map<string, { walked: WalkedFile; ex: Extracted }>;
  symbolsByFile: Map<string, RawSymbol[]>;
  byBareName: Map<string, string[]>;
  allPaths: Set<string>;
  /** absolute, native-separator repo root (best-effort; '' if it couldn't be inferred) */
  root: string;
}

/** Recover the absolute repo root from the first walked file's `abs` minus its `path`
 * (both are set consistently by walkRepo), used when the caller doesn't pass one
 * explicitly. Only needed for tsconfig baseUrl/paths lookups. */
function inferRoot(files: Array<{ walked: WalkedFile }>): string {
  for (const f of files) {
    const relNative = f.walked.path.split('/').join(path.sep);
    if (relNative && f.walked.abs.endsWith(relNative)) {
      const root = f.walked.abs.slice(0, f.walked.abs.length - relNative.length).replace(/[\\/]+$/, '');
      if (root) return root;
    }
  }
  return '';
}

export function buildRepoIndex(files: Array<{ walked: WalkedFile; ex: Extracted }>, root?: string): RepoIndex {
  const idx: RepoIndex = { files: new Map(), symbolsByFile: new Map(), byBareName: new Map(), allPaths: new Set(), root: root ? path.resolve(root) : inferRoot(files) };
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
    const exts = ['.ts', '.tsx', '.mts', '.js', '.mjs', '.jsx', '.cjs'];
    if (imp.module.startsWith('.')) {
      const base = path.posix.join(dir, imp.module).replace(/\.(js|mjs|cjs|jsx)$/, '');
      return firstExisting(idx, [...exts.map(e => base + e), ...exts.map(e => `${base}/index${e}`)]);
    }
    // Non-relative specifier (e.g. "@/hooks/useApi"): try the nearest tsconfig's
    // baseUrl/paths before giving up (external package otherwise).
    if (!idx.root) return null;
    const cfg = findNearestTsconfig(path.join(idx.root, dir), idx.root);
    if (!cfg) return null;
    const bases = mapSpecifierViaConfig(cfg, imp.module)
      .map(abs => path.relative(idx.root, abs).split(path.sep).join('/'))
      .filter(rel => rel && !rel.startsWith('..'));
    if (!bases.length) return null;
    const candidates: string[] = [];
    for (const base of bases) { for (const e of exts) candidates.push(base + e); for (const e of exts) candidates.push(`${base}/index${e}`); }
    return firstExisting(idx, candidates);
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
  // Look up a fully-qualified symbol name's own kind in the repo index (works for
  // local-file and cross-file targets alike, since symbolsByFile covers every indexed file).
  const kindOf = (tail: string): SymbolOut['kind'] | undefined => {
    const file = tail.split('::')[0];
    return (idx.symbolsByFile.get(file) ?? []).find(s => symName(file, s.qualname) === tail)?.kind;
  };
  // Fully-qualified symbol lookup: given a raw symbol name found via idx.byBareName
  // (already "file::qualname"), fetch its own RawSymbol record (for .kind/.parent checks).
  const rawSymOf = (full: string): RawSymbol | undefined => {
    const file = full.split('::')[0]; const qualname = full.slice(file.length + 2);
    return (idx.symbolsByFile.get(file) ?? []).find(s => s.qualname === qualname);
  };
  // local-variable -> constructor-name bindings, scoped by enclosing def ('' = module level)
  const localCtor = new Map<string, Map<string, string>>();
  for (const a of ex.assigns) {
    const scope = a.inside ?? '';
    const m = localCtor.get(scope) ?? new Map<string, string>();
    m.set(a.name, a.ctor);
    localCtor.set(scope, m);
  }
  const ctorOf = (scope: string, name: string): string | undefined => localCtor.get(scope)?.get(name) ?? localCtor.get('')?.get(name);
  // Is `name` a local binding visible from `scope`, counting lexical closure over every
  // enclosing scope (not just `scope` itself)? Dot-separated qualnames ('Outer.Inner')
  // are exactly the lexical nesting chain built by each extractor's `enclosing*()`
  // helper, so walking it name-segment-by-name-segment up to module scope ('') mirrors
  // real JS/Python closures: `setMode` destructured in a component's own scope is still
  // a local from the perspective of a nested named callback (`Component.handleClick`)
  // that references it without redeclaring it.
  const isLocalInScope = (scope: string, name: string): boolean => {
    let cur = scope;
    while (true) {
      if (ex.localsByScope[cur]?.includes(name)) return true;
      if (!cur) return false;
      const dot = cur.lastIndexOf('.');
      cur = dot === -1 ? '' : cur.slice(0, dot);
    }
  };
  // Resolve a constructor name (`Thing`, `Engine`, ...) to its class/struct symbol:
  // same file first, then via this file's import bindings, then a repo-wide unique bare name.
  const resolveCtorClass = (ctor: string): { file: string; qualname: string } | null => {
    const local = localByName.get(ctor)?.find(s => s.kind === 'class' || s.kind === 'struct');
    if (local) return { file: p, qualname: local.qualname };
    const b = binding.get(ctor);
    if (b?.file) {
      const hit = (idx.symbolsByFile.get(b.file) ?? []).find(s => s.name === ctor && (s.kind === 'class' || s.kind === 'struct'));
      if (hit) return { file: b.file, qualname: hit.qualname };
    }
    const g = idx.byBareName.get(ctor) ?? [];
    if (g.length === 1) {
      const sym = rawSymOf(g[0]);
      if (sym && (sym.kind === 'class' || sym.kind === 'struct')) return { file: g[0].split('::')[0], qualname: sym.qualname };
    }
    return null;
  };
  // inheritance
  for (const inh of ex.inherits) {
    const parentName = inh.parent.split('.').pop()!;
    const local = localByName.get(parentName)?.find(s => s.kind !== 'method');
    let tail: string | null = local ? localFull(local.qualname) : null;
    if (!tail) { const b = binding.get(parentName) ?? binding.get(inh.parent.split('.')[0]); tail = b ? findIn(b.file, parentName) : null; }
    if (!tail) { const g = idx.byBareName.get(parentName) ?? []; if (g.length === 1) tail = g[0]; }
    if (tail) { stub(tail, kindOf(tail) ?? 'class'); addEdge({ type: inh.kind, head: localFull(inh.child), tail, confidence: 1, resolution: 'syntax' }); }
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
      // receiver may be a local class/var: Engine::new, Thing.run ; try Class.method locally, then unique method globally.
      // (binding.has(c.receiver) is always false here -- the preceding branch already handled that case.)
      const cls = localByName.get(c.receiver)?.find(s => s.kind === 'class' || s.kind === 'struct');
      const m = cls ? localByName.get(c.callee)?.find(s => s.parent === cls.qualname) : undefined;
      if (m) tail = localFull(m.qualname);
      if (!tail) { // local var of a known class in this file? (t = Thing(); t.run()) -> unique method name in file
        const ms = localByName.get(c.callee)?.filter(s => s.kind === 'method'); if (ms && ms.length === 1) tail = localFull(ms[0].qualname);
      }
      if (!tail) {
        // local constructor binding: `x = Thing()` / `let x = Engine::new()` tracked earlier in this
        // file, then `x.method()` resolves Thing/Engine to its class/struct and looks up the method.
        const ctor = ctorOf(c.inside, c.receiver);
        const classLoc = ctor ? resolveCtorClass(ctor) : null;
        if (classLoc) {
          const method = (idx.symbolsByFile.get(classLoc.file) ?? []).find(s => s.parent === classLoc.qualname && s.name === c.callee);
          if (method) tail = symName(classLoc.file, method.qualname);
        }
      }
    } else {
      const loc = localByName.get(c.callee)?.filter(s => s.kind !== 'method');
      if (loc && loc.length === 1) tail = localFull(loc[0].qualname);
      else if (binding.has(c.callee)) tail = findIn(binding.get(c.callee)!.file, c.callee);
    }
    // Repo-wide "unique bare name" fallback (low-confidence heuristic). Skipped for
    // generic/short callees (too likely to collide with an unrelated same-named method
    // elsewhere) and, when the call has a receiver, unless that receiver is an
    // unresolved local (not an import binding, not self/this/super/cls) AND the unique
    // candidate is itself a method (has a `parent`) — a plain top-level function is
    // never called via a receiver, so `foo.bar()` matching a unique bare *function*
    // `bar` would be a false positive (e.g. `logger.info(...)` must never match a
    // top-level `info` function, nor is `info` eligible at all: it's in the stop-list).
    // Round 2 guards, both gated on the same `g.length === 1` unique-name candidate:
    //  - same-language family: a TS caller must never match a Rust/Python candidate
    //    just because the name happens to be repo-wide unique right now.
    //  - external binding: a bare callee already bound to an import that resolved to
    //    NO repo file (an external package, e.g. `createClient` from 'redis') must
    //    never fall through to guessing some unrelated repo symbol of the same name.
    // Round 3 guards:
    //  - rust receiver calls never use this fallback at all (`x.foo()` / `Type::foo()`
    //    with an unresolved receiver): Rust's trait system means a same-named method on
    //    an unrelated type (`is_empty`, `into_response`, `from_str`, ...) is the common
    //    case, not the exception - a receiver-less bare call (`helper()`) is still
    //    eligible, since Rust free functions don't have that ambiguity.
    //  - local-binding shadow: a BARE call (no receiver) whose callee is declared as a
    //    local (parameter, destructured binding, loop/with target, or plain const/let/var)
    //    anywhere in its calling scope's lexical closure chain must never be guessed
    //    against some unrelated file's same-named symbol (`setMode(...)` from a
    //    destructured `const [mode, setMode] = useState(...)` at the component's own
    //    scope, called from a nested named callback that closes over it without
    //    redeclaring it; a `resolve` callback parameter; an `edgeKey` closure variable) -
    //    the local wins even when the indexer can't tell where its value came from.
    if (!tail) {
      const rustReceiverCall = lang === 'rust' && !!c.receiver;
      const isLocalShadow = !c.receiver && isLocalInScope(c.inside ?? '', c.callee);
      const eligible = c.callee.length >= 4 && !GENERIC_CALLEES.has(c.callee) && !rustReceiverCall && !isLocalShadow;
      if (eligible) {
        const g = idx.byBareName.get(c.callee) ?? [];
        if (g.length === 1) {
          const candidateLang = idx.files.get(g[0].split('::')[0])?.walked.lang;
          const sameFamily = (LANG_FAMILY[lang] ?? lang) === (LANG_FAMILY[candidateLang ?? ''] ?? candidateLang);
          if (sameFamily) {
            if (!c.receiver) {
              const calleeBinding = binding.get(c.callee);
              const externallyBound = !!calleeBinding && calleeBinding.file === null;
              if (!externallyBound) { tail = g[0]; conf = 0.4; }
            } else {
              const receiverBound = binding.has(c.receiver);
              const receiverSpecial = c.receiver === 'self' || c.receiver === 'this' || c.receiver === 'super' || c.receiver === 'cls';
              const candidateIsMethod = !!rawSymOf(g[0])?.parent;
              if (!receiverBound && !receiverSpecial && candidateIsMethod) { tail = g[0]; conf = 0.4; }
            }
          }
        }
      }
    }
    if (tail && tail !== head) { stub(tail, kindOf(tail) ?? 'function'); addEdge({ type: 'CALLS', head, tail, confidence: conf, resolution: 'heuristic' }); }
  }
  return { symbols, edges };
}
