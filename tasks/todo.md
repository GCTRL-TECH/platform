# tasks/todo.md

## Codebase KB follow-ups

P1a (indexer, `/kex/code`, manifest/purge, 4 read tools, skill extension, tests, dogfood) is done.
Remaining work for P1b/P2:

- **LSP pass** (P1b): drive real language servers per language - `typescript-language-server`,
  `pyright-langserver`, `rust-analyzer` first, then `gopls`, `jdtls`, `csharp-ls`. For each heuristic
  call site, `textDocument/definition` upgrades the CALLS edge to `confidence 1.0, resolution: lsp`
  (or corrects the target if the heuristic guessed wrong). Missing server binary = warning, heuristic
  result stands. Auto-install only behind explicit `--install-lsp`.
- **`gctrl_code_changes`** (P1b): local `git diff` -> changed symbols -> server `code_impact`, so an
  agent can ask "what breaks if I ship this diff" without a full re-index first.
- **GitHub/GitLab connector** (P2): server-side ingestion, heuristic-only (no local LSP available
  server-side), webhook-driven freshness.
- **Brain UI for CODE compilations** (P2): connect-repo flow + a code-KB view in the portal.
- **Publish packages** (manual step before next release): `@gctrl/code-indexer@0.1.0` to npm, then
  `gctrl-mcp@1.1.0` to npm/MCP registry, and switch the `file:` dev dependency to the published
  version.
- **Rebuild Anvil sandbox images** once the packages above are published, so the `gctrl-code` stdio
  entry ships with the real indexer instead of relying on a workspace-local build.
- **Qdrant payload index** on `source_document_id` if filter-delete (`delete_chunks_by_source`)
  gets slow on large repos.
- **Nested `.gitignore` anchored patterns**: the walker currently doesn't fully resolve
  anchored ignore patterns from `.gitignore` files below the repo root.
- **Credit metering**: code jobs (`kex_code`) currently skip credit metering entirely - this is a
  deliberate product decision for P1a, revisit if usage patterns change.
