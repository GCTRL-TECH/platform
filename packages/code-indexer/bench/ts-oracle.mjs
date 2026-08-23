#!/usr/bin/env node
// Gauntlet tooling (P1a): independent ground truth for TypeScript/JavaScript CALLS
// edges. Uses the real `typescript` LanguageService (not the heuristic indexer) to
// resolve each call site's definition, and compares it against the edge the
// indexer produced. This is the objective oracle for TS/JS; non-TS/JS languages
// (and any TS/JS call the LanguageService can't resolve) fall through to the LLM
// judge packet (judge-packet.mjs).
//
// Usage: node bench/ts-oracle.mjs <repoPath> <edges.jsonl> [--out verdicts.jsonl]
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { walkRepo, findNearestTsconfig } from '../dist/index.js';

const require = createRequire(import.meta.url);
const TS_LIB_DIR = path.dirname(require.resolve('typescript'));

const TS_LANGS = new Set(['typescript', 'tsx', 'javascript']);

function parseArgs(argv) {
  const args = { repoPath: null, edgesPath: null, out: 'verdicts.jsonl' };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') args.out = argv[++i];
    else if (a === '--help' || a === '-h') args.help = true;
    else positional.push(a);
  }
  [args.repoPath, args.edgesPath] = positional;
  return args;
}

function usage() {
  console.error('usage: node bench/ts-oracle.mjs <repoPath> <edges.jsonl> [--out verdicts.jsonl]');
}

function readJsonl(p) {
  return fs.readFileSync(p, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}

function posixRel(from, to) {
  return path.relative(from, to).split(path.sep).join('/');
}

// Minimal ts.LanguageServiceHost backed directly by the filesystem: no incremental
// versions (each run is a fresh one-shot). `pathsConfig` (a TsPathsConfig from the
// indexer's own tsPaths.js, or null) supplies this project's baseUrl/paths so
// `getDefinitionAtPosition`/alias-following can resolve a "@/hooks/useApi"-style
// specifier the same way the indexer's own tsconfig-aware resolveImport now does.
// `fileNames` is always the FULL repo-wide TS/JS file set (not just this project's
// own files) so cross-file navigation still works regardless of which project's
// host answered the query - only baseUrl/paths differ per host.
function makeHost(repoPath, fileNames, pathsConfig) {
  const files = new Set(fileNames);
  const snapshotCache = new Map();
  const compilerOptions = {
    allowJs: true,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler ?? ts.ModuleResolutionKind.NodeNext,
    target: ts.ScriptTarget.ES2022,
    jsx: ts.JsxEmit.Preserve,
    ...(pathsConfig ? {
      baseUrl: pathsConfig.baseUrl ?? pathsConfig.configDir,
      paths: Object.fromEntries(pathsConfig.paths.map((p) => [
        p.star ? `${p.prefix}*${p.suffix}` : p.prefix,
        p.targets,
      ])),
    } : {}),
  };
  return {
    getScriptFileNames: () => [...files],
    getScriptVersion: () => '0',
    getScriptSnapshot: (fileName) => {
      if (snapshotCache.has(fileName)) return snapshotCache.get(fileName);
      if (!fs.existsSync(fileName)) return undefined;
      const snap = ts.ScriptSnapshot.fromString(fs.readFileSync(fileName, 'utf8'));
      snapshotCache.set(fileName, snap);
      return snap;
    },
    getCurrentDirectory: () => repoPath,
    getCompilationSettings: () => compilerOptions,
    getDefaultLibFileName: (options) => path.join(TS_LIB_DIR, ts.getDefaultLibFileName(options)),
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
    useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
  };
}

// A single global ts.LanguageService can only have one compilerOptions, but this repo
// has many sub-project tsconfigs (services/portal, services/web, cli, ...) each
// declaring their own "@/*" -> "./src/*" relative to their OWN directory - a merged
// global paths map would let e.g. services/web's `cn()` resolve to services/portal's
// identically-aliased, identically-named `cn()` (a real collision seen in this repo's
// shadcn-style utils/hooks). So: one LanguageService per distinct tsconfig project
// (found via the indexer's own findNearestTsconfig, keyed by its configDir; files
// under no applicable tsconfig share a single no-paths default project), sharing one
// DocumentRegistry. Returns { serviceForFile(absFile) -> { ls, program } }.
function makeProjectServices(repoPath, fileNames) {
  const registry = ts.createDocumentRegistry();
  const byConfigDir = new Map(); // configDir key ('' = default) -> { ls, program }
  const fileToKey = new Map();
  for (const abs of fileNames) {
    const cfg = findNearestTsconfig(path.dirname(abs), repoPath);
    const key = cfg ? cfg.configDir : '';
    fileToKey.set(abs, key);
    if (!byConfigDir.has(key)) {
      const host = makeHost(repoPath, fileNames, cfg);
      const ls = ts.createLanguageService(host, registry);
      byConfigDir.set(key, { ls, program: ls.getProgram() });
    }
  }
  const defaultEntry = byConfigDir.get('') ?? (() => {
    const host = makeHost(repoPath, fileNames, null);
    const ls = ts.createLanguageService(host, registry);
    const entry = { ls, program: ls.getProgram() };
    byConfigDir.set('', entry);
    return entry;
  })();
  return {
    serviceForFile: (absFile) => byConfigDir.get(fileToKey.get(absFile) ?? '') ?? defaultEntry,
  };
}

function lineColToPos(source, line0, col0) {
  const lines = source.split('\n');
  let pos = 0;
  for (let i = 0; i < line0; i++) pos += lines[i].length + 1;
  return pos + col0;
}

// True when `pos` falls inside an ImportDeclaration node of `sourceFile` - i.e. the
// definition TS handed back is really the *local import specifier* (`import { add }
// from '@/lib/util'`), not the thing it re-exports. Walks the already-parsed AST from
// the LanguageService's Program (no extra parse).
function isPositionInImportDeclaration(sourceFile, pos) {
  let found = false;
  const visit = (node) => {
    if (found || pos < node.getStart(sourceFile) || pos >= node.getEnd()) return;
    if (ts.isImportDeclaration(node)) { found = true; return; }
    node.forEachChild(visit);
  };
  sourceFile.forEachChild(visit);
  return found;
}

// A definition whose `kind` is 'alias' (an import specifier) - or whose span sits
// inside an import declaration in its own file - is one hop short of the real
// target. Follow it once (getDefinitionAtPosition, falling back to
// getTypeDefinitionAtPosition) and substitute the followed definition(s) in its
// place. Only one hop: re-export chains longer than that are rare enough not to be
// worth chasing here, and stop the oracle from ever infinite-looping on a cycle.
function followAliasDefs(ls, program, defs) {
  const out = [];
  for (const d of defs) {
    const sf = program?.getSourceFile(d.fileName);
    const looksLikeImportBinding = d.kind === 'alias' || (sf && isPositionInImportDeclaration(sf, d.textSpan.start));
    if (looksLikeImportBinding) {
      let followed;
      try { followed = ls.getDefinitionAtPosition(d.fileName, d.textSpan.start); } catch { followed = undefined; }
      if (!followed || !followed.length) {
        try { followed = ls.getTypeDefinitionAtPosition(d.fileName, d.textSpan.start); } catch { followed = undefined; }
      }
      if (followed && followed.length) { out.push(...followed); continue; }
    }
    out.push(d);
  }
  return out;
}

const isNodeModulesPath = (fileName) => /(^|[\\/])node_modules([\\/]|$)/.test(fileName);

const tierOf = (confidence) => (confidence === 1 ? '1.0' : confidence === 0.6 ? '0.6' : confidence === 0.4 ? '0.4' : String(confidence));

// Find the callee identifier (last dotted segment of the tail qualname, e.g.
// "greet" for "User.greet") inside the head symbol's line range, as a call
// expression: the identifier followed by optional whitespace and `(` or `<`
// (the `<` covers a generic call like `foo<T>(...)`).
function findCallSite(source, lineStart1, lineEnd1, identifier) {
  const lines = source.split('\n');
  const re = new RegExp(`\\b${identifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[(<]`);
  const from = Math.max(0, lineStart1 - 1);
  const to = Math.min(lines.length - 1, lineEnd1 - 1);
  for (let li = from; li <= to; li++) {
    const m = re.exec(lines[li]);
    if (m) return { line0: li, col0: m.index };
  }
  return null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.repoPath || !args.edgesPath) { usage(); process.exit(args.help ? 0 : 1); }
  const repoPath = path.resolve(args.repoPath);
  if (!fs.existsSync(repoPath)) { console.error(`repoPath does not exist: ${repoPath}`); process.exit(1); }
  if (!fs.existsSync(args.edgesPath)) { console.error(`edges file does not exist: ${args.edgesPath}`); process.exit(1); }

  const edges = readJsonl(args.edgesPath).filter((e) => (e.type ?? 'CALLS') === 'CALLS' && TS_LANGS.has(e.lang));
  if (!edges.length) {
    console.error('ts-oracle: no TS/JS CALLS edges found in input, nothing to verify');
    fs.writeFileSync(path.resolve(args.out), '');
    return;
  }

  const walked = await walkRepo(repoPath);
  const fileNames = walked.filter((w) => TS_LANGS.has(w.lang)).map((w) => w.abs);
  const projects = makeProjectServices(repoPath, fileNames);

  const sourceCache = new Map();
  const readSource = (relPath) => {
    if (sourceCache.has(relPath)) return sourceCache.get(relPath);
    const abs = path.join(repoPath, relPath);
    const src = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
    sourceCache.set(relPath, src);
    return src;
  };

  const out = fs.createWriteStream(path.resolve(args.out));
  let correct = 0, incorrect = 0, unknown = 0, external = 0;
  const tierStats = new Map(); // tier -> { correct, incorrect, unknown, external }
  const bumpTier = (confidence, verdict) => {
    const tier = tierOf(confidence);
    const s = tierStats.get(tier) ?? { correct: 0, incorrect: 0, unknown: 0, external: 0 };
    s[verdict]++;
    tierStats.set(tier, s);
  };

  for (const e of edges) {
    const identifier = e.tail.split('::').pop().split('.').pop();
    const headSource = readSource(e.headFile);
    let verdict = 'unknown';
    let oracleFile = null;
    let oracleName = null;

    if (headSource != null && e.headLineStart != null && e.headLineEnd != null) {
      const site = findCallSite(headSource, e.headLineStart, e.headLineEnd, identifier);
      if (site) {
        const absHead = path.join(repoPath, e.headFile);
        const pos = lineColToPos(headSource, site.line0, site.col0);
        const { ls, program } = projects.serviceForFile(absHead);
        let defs;
        try { defs = ls.getDefinitionAtPosition(absHead, pos); }
        catch { defs = undefined; }
        if (defs && defs.length) {
          defs = followAliasDefs(ls, program, defs);
        }
        if (defs && defs.length) {
          const match = defs.find((d) => posixRel(repoPath, d.fileName) === e.tailFile && (d.name ?? '').includes(identifier));
          if (match) {
            verdict = 'correct';
            oracleFile = posixRel(repoPath, match.fileName);
            oracleName = match.name ?? null;
          } else {
            const d0 = defs[0];
            verdict = isNodeModulesPath(d0.fileName) ? 'external' : 'incorrect';
            oracleFile = posixRel(repoPath, d0.fileName);
            oracleName = d0.name ?? null;
          }
        }
      }
    }

    if (verdict === 'correct') correct++;
    else if (verdict === 'incorrect') incorrect++;
    else if (verdict === 'external') external++;
    else unknown++;
    bumpTier(e.confidence, verdict);

    out.write(JSON.stringify({ head: e.head, tail: e.tail, verdict, oracleFile, oracleName }) + '\n');
  }
  out.end();
  await new Promise((resolve, reject) => { out.on('finish', resolve); out.on('error', reject); });

  const scored = correct + incorrect;
  const precision = scored ? correct / scored : null;
  console.error(`ts-oracle: ${edges.length} TS/JS CALLS edges checked`);
  console.error(`  correct=${correct} incorrect=${incorrect} unknown=${unknown} external=${external}`);
  console.error(`  precision (correct/(correct+incorrect)) = ${precision === null ? 'n/a (no scored edges)' : precision.toFixed(3)}`);
  console.error('  per-tier breakdown:');
  for (const tier of [...tierStats.keys()].sort((a, b) => Number(b) - Number(a))) {
    const s = tierStats.get(tier);
    const tScored = s.correct + s.incorrect;
    const tPrecision = tScored ? s.correct / tScored : null;
    console.error(`    tier ${tier}: correct=${s.correct} incorrect=${s.incorrect} unknown=${s.unknown} external=${s.external} precision=${tPrecision === null ? 'n/a' : tPrecision.toFixed(3)}`);
  }
}

main().catch((e) => { console.error(e.stack || e.message || e); process.exit(1); });
