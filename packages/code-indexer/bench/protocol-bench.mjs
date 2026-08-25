#!/usr/bin/env node
// Protocol bench: what does a coding agent pay to answer structural questions about a
// repository through the Codebase KB (gctrl_code_* over the stdio MCP server) versus the
// grep-and-read habit it falls back to without one?
//
// Both sides answer the SAME questions on the SAME checkout:
//   graph  - the MCP tool call(s) an agent following the coding protocol would make; cost =
//            bytes of tool results the model has to read.
//   grep   - what an agent without the graph does: `grep -rn <name>` over the tree, then read
//            every file that defines/declares the name in full; cost = grep output + file bytes.
// Tokens are estimated at 4 bytes/token (conservative for code). The answer is checked on
// both sides: the graph result must name the file grep finds the definition in.
//
//   node bench/protocol-bench.mjs --repo <path> --questions bench/protocol-questions.json \
//        [--compilation <id>] [--out result.json]
//   env: GCTRL_API_URL, GCTRL_API_TOKEN (direct mode), GCTRL_MCP=<path to gctrl-mcp dist/index.js>
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => a.startsWith('--') ? [a.slice(2), all[i + 1]] : []).filter(Boolean));
const repo = path.resolve(args.repo ?? '.');
const questions = JSON.parse(fs.readFileSync(args.questions, 'utf8'));
const compilationId = args.compilation;
const mcpJs = process.env.GCTRL_MCP ?? path.resolve('../../services/mcp/dist/index.js');
const T = (bytes) => Math.round(bytes / 4);

// ── minimal stdio MCP client (one server for the whole run) ─────────────────────────────
const child = spawn(process.execPath, [mcpJs], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, GCTRL_MCP_TOOLS: 'code' } });
let buf = ''; const pending = new Map(); let nextId = 1;
child.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!line) continue; try { const m = JSON.parse(line); if (m.id != null && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } } catch {} } });
child.stderr.on('data', () => {});
const rpc = (method, params) => new Promise((res) => { const id = nextId++; pending.set(id, res); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'protocol-bench', version: '0' } });
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n');
async function tool(name, a) {
  const r = await rpc('tools/call', { name, arguments: { ...a, ...(compilationId ? { compilationId } : {}) } });
  const text = (r.result?.content ?? []).map(c => c.text ?? '').join('\n');
  return { text, bytes: Buffer.byteLength(text) };
}

// ── grep-and-read baseline ───────────────────────────────────────────────────────────────
const EXCL = ['node_modules', '.git', 'dist', 'target', '.next', '__pycache__', 'build', '.worktrees'];
function grepOut(name) {
  try {
    const out = execFileSync('grep', ['-rn', '--include=*.ts', '--include=*.tsx', '--include=*.js', '--include=*.mjs', '--include=*.py', '--include=*.rs', ...EXCL.map(e => `--exclude-dir=${e}`), '-e', name, repo], { encoding: 'utf8', maxBuffer: 64 << 20 });
    return out;
  } catch (e) { return e.stdout ?? ''; }
}
const DEF_RE = (name) => new RegExp(`(function\\s+${name}\\b|(const|let)\\s+${name}\\s*=|def\\s+${name}\\b|fn\\s+${name}\\b|class\\s+${name}\\b|struct\\s+${name}\\b|async fn\\s+${name}\\b|pub(\\(crate\\))? fn\\s+${name}\\b|export (async )?function\\s+${name}\\b)`);
function definitionFiles(name, grep) {
  const files = new Set();
  for (const line of grep.split('\n')) {
    const m = line.match(/^(.+?):(\d+):(.*)$/); if (!m) continue;
    if (DEF_RE(name).test(m[3])) files.add(m[1]);
  }
  return [...files];
}
function grepAndRead(name) {
  const g = grepOut(name);
  const defs = definitionFiles(name, g);
  // An agent reads the defining file(s) in full to understand the symbol; for "who calls X"
  // it additionally opens every file grep hit (that is the honest cost of grep for callers).
  const fileBytes = defs.reduce((n, f) => n + (fs.existsSync(f) ? fs.statSync(f).size : 0), 0);
  const hitFiles = new Set(g.split('\n').map(l => l.split(':')[0]).filter(Boolean));
  const hitBytes = [...hitFiles].reduce((n, f) => n + (fs.existsSync(f) ? fs.statSync(f).size : 0), 0);
  return { grepBytes: Buffer.byteLength(g), defFiles: defs.map(f => path.relative(repo, f)), defBytes: fileBytes, hitFiles: hitFiles.size, hitBytes };
}

// ── run ──────────────────────────────────────────────────────────────────────────────────
const rows = [];
for (const q of questions) {
  const base = grepAndRead(q.symbol);
  let graph; let calls = 0;
  if (q.kind === 'where') { graph = await tool('gctrl_code_symbol', { query: q.symbol, limit: 5 }); calls = 1; }
  else if (q.kind === 'callers') { graph = await tool('gctrl_code_trace', { symbol: q.symbol, direction: 'callers', depth: 1 }); calls = 1; }
  else if (q.kind === 'callees') { graph = await tool('gctrl_code_trace', { symbol: q.symbol, direction: 'callees', depth: 1 }); calls = 1; }
  else if (q.kind === 'impact') { graph = await tool('gctrl_code_impact', { changedSymbols: [q.symbol], depth: 2 }); calls = 1; }
  else if (q.kind === 'architecture') { graph = await tool('gctrl_code_architecture', {}); calls = 1; }
  // Correctness: the graph answer must name the defining file grep found (where/callers/callees/impact).
  const defFile = base.defFiles[0] ? base.defFiles[0].replace(/\\/g, '/') : null;
  const hit = q.kind === 'architecture' ? graph.bytes > 0 : (defFile ? graph.text.replace(/\\\\/g, '/').includes(defFile) || graph.text.includes(path.basename(defFile)) : null);
  // grep cost: "where" = grep + defining files; callers/callees/impact = grep + every hit file
  // (an agent has to open them to see whether the hit is a call); architecture = a tree walk
  // approximated by every source file's first 40 lines is not modelled - counted as grep of the top-level.
  const grepCost = q.kind === 'where' ? base.grepBytes + base.defBytes : q.kind === 'architecture' ? base.grepBytes : base.grepBytes + base.hitBytes;
  rows.push({ id: q.id, kind: q.kind, symbol: q.symbol, graphCalls: calls, graphBytes: graph.bytes, graphTokens: T(graph.bytes), grepBytes: grepCost, grepTokens: T(grepCost), grepFiles: q.kind === 'where' ? base.defFiles.length : base.hitFiles, correct: hit, saving: grepCost ? +(1 - graph.bytes / grepCost).toFixed(3) : null });
  console.error(`${q.id.padEnd(28)} ${q.kind.padEnd(12)} graph ${String(T(graph.bytes)).padStart(6)} tok | grep ${String(T(grepCost)).padStart(7)} tok | correct=${hit}`);
}
child.kill();
const totalGraph = rows.reduce((n, r) => n + r.graphTokens, 0), totalGrep = rows.reduce((n, r) => n + r.grepTokens, 0);
const summary = { repo: path.basename(repo), compilationId: compilationId ?? null, questions: rows.length, graphTokens: totalGraph, grepTokens: totalGrep, saving: +(1 - totalGraph / totalGrep).toFixed(3), correct: rows.filter(r => r.correct === true).length, checked: rows.filter(r => r.correct !== null).length };
console.error(`\nTOTAL graph ${totalGraph} tok vs grep ${totalGrep} tok -> ${(summary.saving * 100).toFixed(1)}% fewer; correct ${summary.correct}/${summary.checked}`);
const out = { generatedAt: new Date().toISOString(), summary, rows };
if (args.out) fs.writeFileSync(args.out, JSON.stringify(out, null, 2));
console.log(JSON.stringify(summary));
