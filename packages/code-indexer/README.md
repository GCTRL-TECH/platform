# @gctrl/code-indexer

Turns a source repository into an `IndexBatch` (symbols, edges, chunks) and uploads it to a
GCTRL Codebase KB (compilation `type = CODE`). This is the P1a implementation of the "Codebase KB"
feature - see the design spec for the full picture:
`docs/superpowers/specs/2026-08-22-codebase-kb-design.md` section 10 for the `IndexBatch` contract.

Indexing runs where the code lives (CLI, MCP server, or any Node process that can inject an HTTP
`request` function); the server only stores what it receives.

## What it does

1. **Walk** the repo, honoring `.gitignore` plus fixed excludes (`node_modules`, `target`, `dist`,
   `.git`, lockfiles, binaries). Files over 1 MB are skipped.
2. **Parse** every walked file with tree-sitter (symbols: file/module/class/interface/function/method
   with qualname, line range, signature, doc). Files in unsupported languages still get a `file`
   symbol and `CONTAINS` structure, nothing deeper.
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
| Rust | full: symbols + IMPORTS/CALLS heuristics |
| everything else | structure only: file symbol + `CONTAINS`, no CALLS/IMPORTS |

An LSP pass (real language servers - typescript-language-server, pyright, rust-analyzer, then
gopls/jdtls/csharp-ls) that upgrades heuristic edges to `confidence 1.0, resolution: lsp` is P1b,
not implemented here. Heuristic edges are never deleted when LSP is unavailable - they just stay
at their heuristic confidence.

## Edge confidence tiers

- `confidence 0.6, resolution: heuristic` - call resolved within file/module scope (import-aware).
  Measured on the borghive dogfood run (gauntlet, 2026-08-23): 997/997 correct against a
  TypeScript-compiler oracle for TS/JS, 30/30 against an LLM judge for Python + Rust.
- `confidence 0.4, resolution: heuristic` - repo-wide unique bare name match only (receiver calls
  are matched this way only when the method name is unique across the indexed repo). Lower
  precision than the 0.6 tier; every edge at this tier is labeled as such so a caller can decide
  whether to trust it.

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

- 1 MB per file (larger files are skipped, not truncated).
- Heuristic-only in P1a - no type inference, no cross-language resolution.
- Deleted symbols are dropped by URI set-difference after each write, so a rename shows up as an
  add + a delete, not an update.
- Code jobs currently skip credit metering (product decision, not a bug).

## Measured numbers (dogfood: indexing borghive itself, 2026-08-23)

- 461 files (Python/TypeScript/Rust) -> 7155 symbols, 9188 edges, 3681 chunks.
- Incremental re-run with no changes: 0/461 files uploaded.
- Full run wall time: roughly 2-4 minutes on a dev box: embeddings dominate, parsing is fast.
- Token efficiency vs. grep-style exploration over 5 structural questions: 95.7% overall
  (85.8%-99.9% per question) - using `code_symbol`/`code_trace` instead of grepping the repo.

## Bench scripts

`bench/` holds the scripts used to produce the numbers above:

- `bench/dump-edges.mjs` - dumps all CALLS edges from an indexed repo for inspection/sampling.
- `bench/ts-oracle.mjs` - checks TS/JS CALLS edges against the TypeScript compiler's own symbol
  resolution (ground truth for the 0.6-tier precision number).
- `bench/judge-packet.mjs` - builds a packet of sampled edges for an LLM judge to score (used for
  Python/Rust, which have no compiler oracle wired up here).
