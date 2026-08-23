import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { walkRepo } from './walk.js';
import { extractFile } from './extract/engine.js';
import { buildRepoIndex, fileOutputs } from './resolve.js';
import { buildChunks } from './chunks.js';
import type { FileOut, IndexBatch } from './types.js';
import type { Lang } from './parser.js';
import type { Extracted } from './extract/types.js';
import type { WalkedFile } from './types.js';

export type RequestFn = (method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown) => Promise<unknown>;
export interface IndexOptions { repoPath: string; compilationId?: string; request: RequestFn; full?: boolean; classificationLevelId?: string; batchFiles?: number; pollMs?: number; onProgress?: (msg: string) => void; createCompilationIfMissing?: boolean }
export interface IndexSummary { compilationId: string; repo: string; commit: string | null; filesTotal: number; filesChanged: number; filesRemoved: number; batches: number; symbols: number; edges: number; chunks: number; jobIds: string[]; warnings: string[] }

export function gitCommit(repoPath: string): string | null {
  try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoPath, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || null; }
  catch { return null; }
}

export function makeBatches(files: FileOut[], removed: string[], batchFiles: number): Array<{ files: FileOut[]; removed: string[] }> {
  const out: Array<{ files: FileOut[]; removed: string[] }> = [];
  for (let i = 0; i < files.length; i += batchFiles) out.push({ files: files.slice(i, i + batchFiles), removed: [] });
  if (removed.length) { if (out.length) out[0].removed = removed; else out.push({ files: [], removed }); }
  return out;
}

async function waitJob(request: RequestFn, jobId: string, pollMs: number, log: (m: string) => void): Promise<string> {
  for (let i = 0; i < 400; i++) {
    await new Promise(r => setTimeout(r, pollMs));
    const j = (await request('GET', `/kex/jobs/${jobId}`)) as { job?: { status?: string; error?: string } };
    const st = j.job?.status ?? 'pending';
    if (st.startsWith('completed')) return st;
    if (st === 'failed') throw new Error(`code job ${jobId} failed: ${j.job?.error ?? 'unknown'}`);
    if (i % 10 === 9) log(`job ${jobId} still ${st}...`);
  }
  throw new Error(`code job ${jobId} timed out`);
}

export async function indexRepo(opts: IndexOptions): Promise<IndexSummary> {
  const log = opts.onProgress ?? (() => {});
  const repoPath = path.resolve(opts.repoPath);
  if (!fs.existsSync(repoPath)) throw new Error(`repoPath does not exist: ${repoPath}`);
  const repoName = path.basename(repoPath);
  const commit = gitCommit(repoPath);
  const warnings: string[] = [];

  let compilationId = opts.compilationId;
  if (!compilationId) {
    if (opts.createCompilationIfMissing === false) throw new Error('compilationId is required');
    const created = (await opts.request('POST', '/kg/compilations', { name: `${repoName} (code)`, type: 'CODE', description: `Codebase KB for ${repoName}` })) as { id?: string };
    if (!created.id) throw new Error('could not create CODE compilation');
    compilationId = created.id; log(`created CODE compilation ${compilationId}`);
  }

  log('walking repo...');
  const walked = await walkRepo(repoPath);
  const parsed: Array<{ walked: WalkedFile; ex: Extracted; source: string }> = [];
  for (const w of walked) {
    if (w.lang === 'other') continue;
    const source = fs.readFileSync(w.abs, 'utf8');
    try { parsed.push({ walked: w, ex: await extractFile(w.lang as Lang, source), source }); }
    catch (e) { warnings.push(`parse failed ${w.path}: ${(e as Error).message}`); }
  }
  log(`parsed ${parsed.length}/${walked.length} files`);
  const idx = buildRepoIndex(parsed, repoPath);

  const manifest = (await opts.request('GET', `/kex/code/manifest?compilationId=${encodeURIComponent(compilationId)}`)) as { files?: Record<string, string> };
  const known = manifest.files ?? {};
  const localPaths = new Set(parsed.map(p => p.walked.path));
  const changed = parsed.filter(p => opts.full || known[p.walked.path] !== p.walked.sha256);
  const removed = Object.keys(known).filter(k => !localPaths.has(k));

  const files: FileOut[] = changed.map(p => {
    const { symbols, edges } = fileOutputs(idx, p.walked.path);
    return { path: p.walked.path, sha256: p.walked.sha256, lang: p.walked.lang, symbols, edges, chunks: buildChunks(p.walked.path, p.source, p.ex.symbols) };
  });
  const batches = makeBatches(files, removed, opts.batchFiles ?? 200);
  const jobIds: string[] = [];
  let symbols = 0, edges = 0, chunks = 0;
  for (const [i, b] of batches.entries()) {
    const body: IndexBatch = { compilationId, repo: { name: repoName, root: repoPath, commit }, classificationLevelId: opts.classificationLevelId, files: b.files, removed: b.removed };
    log(`uploading batch ${i + 1}/${batches.length} (${b.files.length} files, ${b.removed.length} removed)`);
    const r = (await opts.request('POST', '/kex/code', body)) as { jobId?: string; error?: string };
    if (!r.jobId) throw new Error(`POST /kex/code failed: ${r.error ?? JSON.stringify(r)}`);
    jobIds.push(r.jobId);
    const st = await waitJob(opts.request, r.jobId, opts.pollMs ?? 3000, log);
    if (st === 'completed_degraded') warnings.push(`job ${r.jobId} completed degraded`);
    for (const f of b.files) { symbols += f.symbols.length; edges += f.edges.length; chunks += f.chunks.length; }
  }
  return { compilationId, repo: repoName, commit, filesTotal: parsed.length, filesChanged: files.length, filesRemoved: removed.length, batches: batches.length, symbols, edges, chunks, jobIds, warnings };
}
