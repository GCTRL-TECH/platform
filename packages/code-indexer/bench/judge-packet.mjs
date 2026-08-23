#!/usr/bin/env node
// Gauntlet tooling (P1a): build a stratified sample of CALLS edges (proportional
// by lang x confidence tier) with enough source context for an LLM judge to
// verdict them without opening the repo itself. Complements ts-oracle.mjs, which
// only covers TS/JS - this packet is the ground-truth path for Python, Rust, and
// any TS/JS call the LanguageService oracle couldn't resolve.
//
// Each sampled edge gets id = "<head> -> <tail>" - a stable, human-readable key
// that verdicts.json (filled in later by the judge) reuses to join back onto
// edges.jsonl, so no separate packet.json lookup is needed downstream.
//
// Usage: node bench/judge-packet.mjs <repoPath> <edges.jsonl> --sample 60 [--seed 42] --out packet.json
import fs from 'node:fs';
import path from 'node:path';

const HEAD_CAP_LINES = 80;
const TAIL_CAP_LINES = 25;

function parseArgs(argv) {
  const args = { repoPath: null, edgesPath: null, sample: 60, seed: 42, out: 'packet.json' };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--sample') args.sample = Number(argv[++i]);
    else if (a === '--seed') args.seed = Number(argv[++i]);
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--help' || a === '-h') args.help = true;
    else positional.push(a);
  }
  [args.repoPath, args.edgesPath] = positional;
  return args;
}

function usage() {
  console.error('usage: node bench/judge-packet.mjs <repoPath> <edges.jsonl> --sample 60 [--seed 42] --out packet.json');
}

function readJsonl(p) {
  return fs.readFileSync(p, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}

// mulberry32 - tiny seeded PRNG, deterministic across runs/platforms for a given seed.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(arr, rng) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const tierOf = (confidence) => {
  if (confidence === 1) return '1.0';
  if (confidence === 0.6) return '0.6';
  if (confidence === 0.4) return '0.4';
  return String(confidence);
};

// Proportional allocation across strata with a floor of `min(5, strataSize)` per
// non-empty stratum, then trim/top-up the largest strata to land on the exact
// total sample size.
function allocate(strata, total) {
  const keys = [...strata.keys()];
  const grand = keys.reduce((s, k) => s + strata.get(k).length, 0);
  const alloc = new Map();
  for (const k of keys) {
    const size = strata.get(k).length;
    const floor = Math.min(5, size);
    const proportional = Math.round((total * size) / grand);
    alloc.set(k, Math.max(floor, Math.min(size, proportional)));
  }
  let sum = [...alloc.values()].reduce((a, b) => a + b, 0);
  const bySize = keys.slice().sort((a, b) => strata.get(b).length - strata.get(a).length);
  // Trim excess from the largest strata first, never below the 5-floor.
  for (let i = 0; sum > total && i < bySize.length * 4; i++) {
    const k = bySize[i % bySize.length];
    const floor = Math.min(5, strata.get(k).length);
    if (alloc.get(k) > floor) { alloc.set(k, alloc.get(k) - 1); sum--; }
  }
  // Top up remaining budget into strata that still have room.
  for (let i = 0; sum < total && i < bySize.length * 4; i++) {
    const k = bySize[i % bySize.length];
    if (alloc.get(k) < strata.get(k).length) { alloc.set(k, alloc.get(k) + 1); sum++; }
  }
  return alloc;
}

function readLinesCapped(repoPath, relFile, start, end, cap) {
  if (!relFile || start == null || end == null) return { lines: null, code: null };
  const abs = path.join(repoPath, relFile);
  if (!fs.existsSync(abs)) return { lines: [start, end], code: null };
  const all = fs.readFileSync(abs, 'utf8').split('\n');
  const from = Math.max(0, start - 1);
  const to = Math.min(all.length, end, from + cap);
  const code = all.slice(from, to).join('\n');
  const truncated = to < Math.min(all.length, end);
  return { lines: [start, from + (to - from)], code: truncated ? `${code}\n... (truncated at ${cap} lines)` : code };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.repoPath || !args.edgesPath) { usage(); process.exit(args.help ? 0 : 1); }
  const repoPath = path.resolve(args.repoPath);
  if (!fs.existsSync(repoPath)) { console.error(`repoPath does not exist: ${repoPath}`); process.exit(1); }
  if (!fs.existsSync(args.edgesPath)) { console.error(`edges file does not exist: ${args.edgesPath}`); process.exit(1); }

  const edges = readJsonl(args.edgesPath).filter((e) => (e.type ?? 'CALLS') === 'CALLS');
  if (!edges.length) { console.error('judge-packet: no CALLS edges found in input'); process.exit(1); }

  const strata = new Map(); // "lang|tier" -> edges[]
  for (const e of edges) {
    const key = `${e.lang}|${tierOf(e.confidence)}`;
    if (!strata.has(key)) strata.set(key, []);
    strata.get(key).push(e);
  }

  const sampleSize = Math.min(args.sample, edges.length);
  const alloc = allocate(strata, sampleSize);
  const rng = mulberry32(args.seed);

  const sampled = [];
  for (const [key, list] of strata) {
    const n = alloc.get(key) ?? 0;
    const picked = shuffle(list, rng).slice(0, n);
    sampled.push(...picked);
  }

  const packetEdges = sampled.map((e) => {
    const head = readLinesCapped(repoPath, e.headFile, e.headLineStart, e.headLineEnd, HEAD_CAP_LINES);
    // "first 25 lines" of the tail symbol - cap the tail's own end to start+24 before reading.
    const tailEnd = e.tailLineEnd != null && e.tailLineStart != null
      ? Math.min(e.tailLineEnd, e.tailLineStart + TAIL_CAP_LINES - 1)
      : e.tailLineEnd;
    const tail = readLinesCapped(repoPath, e.tailFile, e.tailLineStart, tailEnd, TAIL_CAP_LINES);
    return {
      id: `${e.head} -> ${e.tail}`,
      head: e.head,
      tail: e.tail,
      confidence: e.confidence,
      lang: e.lang,
      headFile: e.headFile,
      headLines: head.lines,
      headCode: head.code,
      tailFile: e.tailFile,
      tailLines: tail.lines,
      tailCode: tail.code,
    };
  });

  const packet = { repo: repoPath, edges: packetEdges };
  fs.writeFileSync(path.resolve(args.out), JSON.stringify(packet, null, 2));

  console.error(`judge-packet: ${edges.length} CALLS edges across ${strata.size} strata (lang x tier), sampled ${packetEdges.length} -> ${args.out}`);
  const summary = {};
  for (const [key, n] of alloc) summary[key] = `${n}/${strata.get(key).length}`;
  console.error(`allocation (sampled/available): ${JSON.stringify(summary)}`);
}

main().catch((e) => { console.error(e.stack || e.message || e); process.exit(1); });
