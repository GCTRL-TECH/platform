#!/usr/bin/env node
// Gauntlet tooling (P1a): walk+parse+resolve a repo with the code-indexer library
// and dump one JSON line per edge (CALLS by default, or every edge type with
// --all-edges), each carrying enough symbol metadata (file + line range + kind)
// for downstream precision scoring (ts-oracle.mjs, judge-packet.mjs) and the
// gauntlet report (bench/gauntlet/code_kb.py in the bench repo).
//
// Usage: node bench/dump-edges.mjs <repoPath> [--lang py|ts|rust] [--out edges.jsonl] [--all-edges]
import fs from 'node:fs';
import path from 'node:path';
import { walkRepo, extractFile, buildRepoIndex, fileOutputs } from '../dist/index.js';

const LANG_GROUPS = {
  py: new Set(['python']),
  ts: new Set(['typescript', 'tsx', 'javascript']),
  rust: new Set(['rust']),
};

function parseArgs(argv) {
  const args = { repoPath: null, lang: null, out: 'edges.jsonl', allEdges: false };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--lang') args.lang = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--all-edges') args.allEdges = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else positional.push(a);
  }
  args.repoPath = positional[0] ?? null;
  return args;
}

function usage() {
  console.error('usage: node bench/dump-edges.mjs <repoPath> [--lang py|ts|rust] [--out edges.jsonl] [--all-edges]');
}

// Resolve a fully-qualified symbol name ("file::qualname") to its own metadata by
// looking it up in the repo-wide symbolsByFile index built from buildRepoIndex.
// Works for both same-file and cross-file symbols since symbolsByFile covers every
// parsed file, not just the one currently being emitted. Returns null for names
// that aren't a symbol reference at all (e.g. a bare external module name in an
// unresolved IMPORTS edge, which has no "::").
// A name with no "::" is either a bare file path (CONTAINS/IMPORTS head/tail can be
// the file itself, e.g. a top-level symbol's CONTAINS head) or a bare external
// module name (an unresolved IMPORTS tail, e.g. "os"). Only the former is a real
// repo file.
function findMeta(idx, fullName) {
  const sep = fullName.indexOf('::');
  if (sep < 0) {
    if (idx.allPaths.has(fullName)) return { file: fullName, kind: 'file', line_start: null, line_end: null };
    return null;
  }
  const file = fullName.slice(0, sep);
  const qualname = fullName.slice(sep + 2);
  const syms = idx.symbolsByFile.get(file);
  if (!syms) return null;
  const s = syms.find((s) => s.qualname === qualname);
  if (!s) return null;
  return { file, kind: s.kind, line_start: s.line_start, line_end: s.line_end };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.repoPath) { usage(); process.exit(args.help ? 0 : 1); }
  const allowedLangs = args.lang ? LANG_GROUPS[args.lang] : null;
  if (args.lang && !allowedLangs) { console.error(`unknown --lang '${args.lang}' (expected py|ts|rust)`); process.exit(1); }

  const repoPath = path.resolve(args.repoPath);
  if (!fs.existsSync(repoPath)) { console.error(`repoPath does not exist: ${repoPath}`); process.exit(1); }

  const t0 = Date.now();
  const walked = await walkRepo(repoPath);
  const parsed = [];
  const parseWarnings = [];
  for (const w of walked) {
    if (w.lang === 'other') continue;
    const source = fs.readFileSync(w.abs, 'utf8');
    try { parsed.push({ walked: w, ex: await extractFile(w.lang, source) }); }
    catch (e) { parseWarnings.push(`parse failed ${w.path}: ${e.message}`); }
  }
  const idx = buildRepoIndex(parsed);

  const outPath = path.resolve(args.out);
  const out = fs.createWriteStream(outPath);

  let filesEmitted = 0;
  let symbolsTotal = 0;
  const byType = new Map();
  const callsByLangTier = new Map(); // lang -> tier -> count

  const tierOf = (confidence) => {
    if (confidence === 1) return '1.0';
    if (confidence === 0.6) return '0.6';
    if (confidence === 0.4) return '0.4';
    return String(confidence);
  };

  for (const p of parsed) {
    if (allowedLangs && !allowedLangs.has(p.walked.lang)) continue;
    filesEmitted++;
    symbolsTotal += p.ex.symbols.length;
    const { edges } = fileOutputs(idx, p.walked.path);
    for (const e of edges) {
      if (!args.allEdges && e.type !== 'CALLS') continue;
      byType.set(e.type, (byType.get(e.type) ?? 0) + 1);
      const headMeta = findMeta(idx, e.head);
      const tailMeta = findMeta(idx, e.tail);
      const rec = {
        type: e.type,
        head: e.head,
        tail: e.tail,
        confidence: e.confidence,
        resolution: e.resolution,
        lang: p.walked.lang,
        headFile: headMeta ? headMeta.file : p.walked.path,
        headLineStart: headMeta ? headMeta.line_start : null,
        headLineEnd: headMeta ? headMeta.line_end : null,
        tailFile: tailMeta ? tailMeta.file : (e.tail.includes('::') ? e.tail.split('::')[0] : null),
        tailLineStart: tailMeta ? tailMeta.line_start : null,
        tailLineEnd: tailMeta ? tailMeta.line_end : null,
        tailKind: tailMeta ? tailMeta.kind : null,
      };
      out.write(JSON.stringify(rec) + '\n');
      if (e.type === 'CALLS') {
        const key = p.walked.lang;
        if (!callsByLangTier.has(key)) callsByLangTier.set(key, new Map());
        const m = callsByLangTier.get(key);
        const tier = tierOf(e.confidence);
        m.set(tier, (m.get(tier) ?? 0) + 1);
      }
    }
  }
  out.end();
  await new Promise((resolve, reject) => { out.on('finish', resolve); out.on('error', reject); });

  const dtSec = ((Date.now() - t0) / 1000).toFixed(1);
  console.error(`dump-edges: ${filesEmitted} files parsed, ${symbolsTotal} symbols, wrote ${outPath} in ${dtSec}s`);
  console.error(`edge types: ${JSON.stringify(Object.fromEntries(byType))}`);
  const langSummary = {};
  for (const [lang, tiers] of callsByLangTier) langSummary[lang] = Object.fromEntries(tiers);
  console.error(`CALLS edges by lang/tier: ${JSON.stringify(langSummary)}`);
  if (parseWarnings.length) {
    console.error(`${parseWarnings.length} parse warnings (first 5):`);
    for (const w of parseWarnings.slice(0, 5)) console.error(`  ${w}`);
  }
}

main().catch((e) => { console.error(e.stack || e.message || e); process.exit(1); });
