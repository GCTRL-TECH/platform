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
import { walkRepo } from '../dist/index.js';

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

// Minimal ts.LanguageServiceHost backed directly by the filesystem: no project
// config resolution, no incremental versions (each run is a fresh one-shot).
function makeHost(repoPath, fileNames) {
  const files = new Set(fileNames);
  const snapshotCache = new Map();
  const compilerOptions = {
    allowJs: true,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler ?? ts.ModuleResolutionKind.NodeNext,
    target: ts.ScriptTarget.ES2022,
    jsx: ts.JsxEmit.Preserve,
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

function lineColToPos(source, line0, col0) {
  const lines = source.split('\n');
  let pos = 0;
  for (let i = 0; i < line0; i++) pos += lines[i].length + 1;
  return pos + col0;
}

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
  const host = makeHost(repoPath, fileNames);
  const ls = ts.createLanguageService(host, ts.createDocumentRegistry());

  const sourceCache = new Map();
  const readSource = (relPath) => {
    if (sourceCache.has(relPath)) return sourceCache.get(relPath);
    const abs = path.join(repoPath, relPath);
    const src = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
    sourceCache.set(relPath, src);
    return src;
  };

  const out = fs.createWriteStream(path.resolve(args.out));
  let correct = 0, incorrect = 0, unknown = 0;

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
        let defs;
        try { defs = ls.getDefinitionAtPosition(absHead, pos); }
        catch { defs = undefined; }
        if (defs && defs.length) {
          const match = defs.find((d) => posixRel(repoPath, d.fileName) === e.tailFile && (d.name ?? '').includes(identifier));
          if (match) {
            verdict = 'correct';
            oracleFile = posixRel(repoPath, match.fileName);
            oracleName = match.name ?? null;
          } else {
            verdict = 'incorrect';
            oracleFile = posixRel(repoPath, defs[0].fileName);
            oracleName = defs[0].name ?? null;
          }
        }
      }
    }

    if (verdict === 'correct') correct++;
    else if (verdict === 'incorrect') incorrect++;
    else unknown++;

    out.write(JSON.stringify({ head: e.head, tail: e.tail, verdict, oracleFile, oracleName }) + '\n');
  }
  out.end();
  await new Promise((resolve, reject) => { out.on('finish', resolve); out.on('error', reject); });

  const scored = correct + incorrect;
  const precision = scored ? correct / scored : null;
  console.error(`ts-oracle: ${edges.length} TS/JS CALLS edges checked`);
  console.error(`  correct=${correct} incorrect=${incorrect} unknown=${unknown}`);
  console.error(`  precision (correct/(correct+incorrect)) = ${precision === null ? 'n/a (no scored edges)' : precision.toFixed(3)}`);
}

main().catch((e) => { console.error(e.stack || e.message || e); process.exit(1); });
