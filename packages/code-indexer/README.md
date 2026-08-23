# @gctrl/code-indexer

Turns a source repository into an `IndexBatch` (symbols, edges, chunks) and uploads it to a
GCTRL Codebase KB (compilation `type = CODE`). This is the P1a implementation of the "Codebase KB"
feature. The `IndexBatch` wire contract is in `docs/buildsummary.md` under "Codebase KB (P1a)"
(also section 10 of the local design spec, `docs/superpowers/specs/2026-08-22-codebase-kb-design.md`).

Indexing runs where the code lives (CLI, MCP server, or any Node process that can inject an HTTP
`request` function); the server only stores what it receives.

## What it does

1. **Walk** the repo, honoring `.gitignore` plus fixed excludes (`node_modules`, `target`, `dist`,
   `build`, `.git`, `__pycache__`, `.venv`/`venv`, `.next`, `.turbo`, `coverage`) and binaries.
   Files over 1 MB are skipped, and so is any file that cannot be read.
2. **Parse** every walked file with tree-sitter (symbols: file/module/class/interface/function/method
   with qualname, line range, signature, doc). Files in a language the indexer has no grammar for
   are skipped entirely - they produce no symbols and no edges at all.
3. **Resolve** edges heuristically: `IMPORTS` via a per-language module resolver (relative paths,
   tsconfig `paths`, Python packages), `CALLS` by name resolution within file/module scope and,
   as a fallback, by repo-wide unique bare name. Every edge carries `resolution` and `confidence`
   so a caller can see the quality, not just the shape.
4. **Diff** against the server's manifest (`GET /kex/code/manifest`) by content hash - only
   changed/new files are re-parsed for upload purposes and only those (plus explicit removals) go
   over the wire. All files are still parsed locally on every run because call resolution into
   unchanged files needs the full symbol table; tree-sitter makes that cheap.
5. **Chunk** one chunk per function/method/class header (body capped ~2000 chars) for embedding
   and `search_chunks`/`query`.
6. **Upload** in batches to `POST /kex/code`, polling `GET /kex/jobs/:id` until each batch's
   `kex_code` job completes.

## Supported languages (P1a)

| Language | Depth |
|---|---|
| Python | full: symbols + IMPORTS/CALLS/INHERITS heuristics |
| TypeScript / TSX / JavaScript | full: symbols + IMPORTS/CALLS/INHERITS/IMPLEMENTS heuristics |
| Rust | full: symbols + IMPORTS/CALLS/IMPLEMENTS heuristics |
| everything else | skipped - not walked into the batch at all (no file symbol, no edges) |

An LSP pass (real language servers - typescript-language-server, pyright, rust-analyzer, then
gopls/jdtls/csharp-ls) that upgrades heuristic edges to `confidence 1.0, resolution: lsp` is P1b,
not implemented here. Heuristic edges are never deleted when LSP is unavailable - they just stay
at their heuristic confidence.

## Edge confidence tiers

- `confidence 1, resolution: syntax` - a structural fact, not a guess: `CONTAINS`, a resolved
  `IMPORTS` target, and an `INHERITS`/`IMPLEMENTS` parent found in the same file or through an
  import binding.
- `confidence 0.6, resolution: heuristic` - call resolved within file/module scope (import-aware).
  Gauntlet (borghive dogfood, 2026-08-23): 1114/1114 edges at this tier scored correct - part of
  1119 CALLS edges scored overall (100% precision), split as 1031/1031 TS/JS edges against a
  TypeScript-compiler oracle plus 88 Python/Rust/module-level edges against an LLM judge, 0
  incorrect.
- `confidence 0.4, resolution: heuristic` - repo-wide unique bare name match, guarded: at least 4
  characters, not in the generic-name stop-list, candidate in the same language family, not bound
  to an external import, not shadowed by a local, and (for receiver calls) the candidate must be a
  method - never used for rust receiver calls at all. The same guarded tier backs the
  `INHERITS`/`IMPLEMENTS` fallback and the cross-file rust `impl Type {}` owner lookup. Lower
  precision than the 0.6 tier; every edge at this tier is labeled as such so a caller can decide
  whether to trust it. Gauntlet: 5/5 Python edges at this tier scored correct.

## Usage: `indexRepo`

```ts
import { indexRepo } from '@gctrl/code-indexer';

const request = async (method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown) => {
  const { data } = await httpClient.request({ method, url: path, data: body });
  return data;
};

const summary = await indexRepo({
  repoPath: '/path/to/repo',
  compilationId: undefined, // omit to create a new CODE compilation named after the repo
  request,
  full: false, // true = re-upload every file, ignore the manifest diff
  onProgress: (msg) => console.error(msg),
});
// summary: { compilationId, repo, commit, filesTotal, filesChanged, filesRemoved,
//            batches, symbols, edges, chunks, jobIds, warnings }
```

The caller supplies `request` (auth, base URL, retries are the caller's concern) - the indexer
never talks HTTP directly. This is how both the CLI and the MCP server use it.

## CLI

```bash
gctrl code index <path> [--kb <compilationId>] [--full] [--classification <levelId>]
gctrl code status <compilationId>   # manifest summary: repo, commit, indexed file count
```

## MCP

Tool `gctrl_code_index(repoPath, compilationId?, full?, classificationLevelId?)` wraps `indexRepo`
for stdio MCP clients (Claude Code, Anvil, Hermes). Read tools (`gctrl_code_symbol`,
`gctrl_code_trace`, `gctrl_code_impact`, `gctrl_code_architecture`) are server-side and reach the
agent through the HTTP gateway, not through this package. Set `GCTRL_MCP_TOOLS=code` to expose
only the code tools from a stdio server instance.

## Limits

- 1 MB per file (larger files are skipped, not truncated); a batch is also cut at 20 MB of
  serialized JSON, not just at 200 files.
- One unreadable or unparseable file is a warning, not a failed run - and it is never reported
  as removed, so its existing symbols survive.
- Heuristic-only in P1a - no type inference, no cross-language resolution.
- Deleted symbols are dropped by URI set-difference after each write, so a rename shows up as an
  add + a delete, not an update.
- Code jobs currently skip credit metering (product decision, not a bug).
- Calls inside anonymous callbacks at file top level (e.g. Express route handlers) are
  attributed to no symbol and produce no edge (precision first; follow-up: anonymous-scope
  attribution).

## Measured numbers (dogfood: indexing borghive itself, 2026-08-23)

- 464 files (Python/TypeScript/Rust) -> 7134 symbols, 9080 edges, 3726 chunks.
- Incremental re-run with no changes: 0/464 files uploaded.
- Full run wall time: roughly 2-4 minutes on a dev box: embeddings dominate, parsing is fast.
- Gauntlet: CALLS precision 100% on 1119 scored edges - 1031/1031 TS/JS edges against a
  TypeScript-compiler oracle plus 88 Python/Rust/module-level edges against an LLM judge, 0
  incorrect. By tier: 1114/1114 at confidence 0.6, 5/5 Python at confidence 0.4.
- Module-level (file-head) CALLS edges are scored only for true top-level calls (65 in borghive);
  25/25 judged correct.
- Token efficiency vs. grep-style exploration over 5 structural questions: 95.6% overall
  (85.8%-99.9% per question) - using `code_symbol`/`code_trace` instead of grepping the repo.

## Bench scripts

`bench/` holds the scripts used to produce the numbers above:

- `bench/dump-edges.mjs` - dumps all CALLS edges from an indexed repo for inspection/sampling.
- `bench/ts-oracle.mjs` - checks TS/JS CALLS edges against the TypeScript compiler's own symbol
  resolution (ground truth for the 0.6-tier precision number).
- `bench/judge-packet.mjs` - builds a packet of sampled edges for an LLM judge to score (used for
  Python/Rust, which have no compiler oracle wired up here).
