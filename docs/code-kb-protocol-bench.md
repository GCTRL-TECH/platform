# Codebase KB - protocol bench (2026-08-25)

What a coding agent pays to answer structural questions about a repository through the
Codebase KB (`gctrl_code_*` over the stdio MCP server, following the coding protocol of the
GCTRL skill v6) versus the grep-and-read habit it falls back to without one. Both sides answer
the same questions on the same checkout; the answer is checked on both sides.

Harness: `packages/code-indexer/bench/protocol-bench.mjs` (questions in
`protocol-questions-<repo>.json`, results in `protocol-result-<repo>.json`).

## Method

- **Graph side** = the tool calls the protocol prescribes. `where is X` = one `code_symbol`.
  `who calls X` / `what does X call` / `what breaks` = `code_symbol` (to resolve the exact graph
  name) + `code_trace` / `code_impact`; both calls are charged. `overview` = one
  `code_architecture`. Cost = bytes of tool results the model has to read.
- **Grep side** = what an agent without the graph does: `grep -rn <name>` over the source tree
  (node_modules, dist, target, .next excluded), then read a **40-line window** around each hit -
  the definition for `where`, every hit for callers/impact (only reading a hit tells the agent
  whether it is a call, a definition, a comment or a string). `overview` = a listing of every
  source file. Whole-file reads are deliberately NOT charged; the baseline is generous to grep.
- Tokens estimated at 4 bytes per token (conservative for code).
- **Correct** = `where`: the answer names the file grep finds the definition in; callers /
  callees / impact: the answer lists at least one hop; overview: a non-trivial answer. An empty
  result counts as wrong - it sends the agent back to grep, which is the cost being measured.

## Results

### borghive (GCTRL platform: Rust + TypeScript + Python, 468 code files, 7,209 symbols)

Local dev stack, CODE compilation `3adaabd8`, indexed at commit `8d78254`.

| question | kind | graph tokens | grep tokens | correct |
|---|---|---:|---:|---|
| resolve_purpose | where | 185 | 1,021 | yes |
| ensure_folder_path | where | 114 | 827 | yes |
| indexRepo | where | 89 | 1,076 | yes |
| api_key_scope | where | 184 | 2,986 | yes* |
| ensure_folder_path | callers | 298 | 4,426 | yes |
| api_key_scope | callers | 849 | 31,273 | yes |
| job_scope | callers | 1,089 | 26,409 | yes |
| enqueue_code_job | callees | 534 | 2,086 | yes |
| resolve_for_user | callees | 384 | 15,863 | yes |
| api_key_scope | impact | 2,084 | 31,273 | yes |
| default_code_folder | impact | 216 | 3,354 | yes |
| (repo) | architecture | 1,673 | 12,387 | yes |
| **total** | | **7,699** | **132,981** | **12/12** |

**94.2 % fewer tokens** for the same twelve questions. (*the first run scored this row as a miss
because the checker compared against grep's first definition file, which was a same-named local
helper; the checker now accepts any defining file.) With `--bare` (the agent types the bare name
and the server resolves it, see below): **94.9 %**, 12/12 - one call instead of two.

### anvil (Next.js/TypeScript app, 1,019 code files, 15,668 symbols)

Local dev stack, CODE compilation `3de5ad3d`, indexed at commit `23fca1d`.

| question | kind | graph tokens | grep tokens | correct |
|---|---|---:|---:|---|
| createKnowledgeBase | where | 78 | 852 | yes |
| ensureUserGctrlMcpConfig | where | 104 | 753 | yes |
| provisionProjectGraph | where | 172 | 1,016 | yes |
| placementSegments | where | 95 | 2,015 | yes |
| createKnowledgeBase | callers | 380 | 5,707 | yes |
| ensureUserGctrlMcpConfig | callers | 420 | 4,520 | yes |
| gctrlFetch | callers | 1,626 | 31,677 | yes |
| provisionProjectGraphOnce | callees | 470 | 933 | yes |
| ensureProjectGraphKey | callees | 602 | 5,862 | yes |
| placementSegments | impact | 441 | 17,127 | yes |
| getUserGctrlToken | impact | 5,850 | 36,723 | yes |
| (repo) | architecture | 1,565 | 8,450 | yes |
| **total** | | **11,803** | **115,635** | **12/12** |

**89.8 % fewer tokens** (90.5 % with `--bare`, 12/12). The smaller margin comes from
`impact-getUserGctrlToken`: a widely used helper has many callers and the impact answer lists
all of them - that is the answer the agent needs before touching it, and it is still 6x cheaper
than opening the 36 grep hits.

### Summary

| repo | language mix | graph tokens | grep tokens | saving | correct |
|---|---|---:|---:|---:|---|
| borghive | Rust + TS + Python | 7,699 (bare: 6,767) | 132,981 | 94.2 % (94.9 %) | 12/12 |
| anvil | TypeScript | 11,803 (bare: 10,982) | 115,635 | 89.8 % (90.5 %) | 12/12 |

### What the bench found before the numbers

The first run answered **0 of 7** trace/impact questions: the graph stores file-scoped names
(`services/api-rs/src/routes/kg.rs::api_key_scope`) and `code_trace` / `code_impact` matched the
exact name only, so the bare name an agent naturally types returned an **empty** result - which
reads as "no callers", the most dangerous wrong answer before a refactor. Fixed in
`services/api-rs/src/routes/code_tools.rs` (both cyphers also match the `::<name>` suffix; test
`trace_and_impact_resolve_bare_symbol_names`). The protocol's `code_symbol` → `code_trace` chain
was never affected; the fix removes the trap for agents that skip the first step.

## What this changes for every connected agent

- The coding protocol (index once per session → navigate through the graph before reading →
  `code_impact` before changes → re-index after edits → `query` for the why → store decisions
  next to the symbols) is in the served skill (v6), the stdio server's instructions and the
  gateway's instructions, the Cursor/Codex copies and the docs page.
- A KB-scoped token with Codebase access can create the code graph of the repository it indexes
  and is granted it automatically; `gctrl-mcp` 1.2.0 indexes the repository at start-up when
  `GCTRL_CODE_AUTO_INDEX` is set; the Access page snippet and `gctrl init` set it.
