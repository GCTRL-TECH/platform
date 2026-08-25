# Codebase KB - Your Code Brain

Point GCTRL at a repository and its structure becomes a knowledge graph that lives in your cloud, is shared by every agent you use, and answers "where is X, who calls it, what breaks" for a fraction of what grep-and-read costs.

## What it does

A **Codebase KB** is a knowledge base of type CODE. It holds one repository's structure - files, classes, functions and methods as graph nodes, connected by CONTAINS, IMPORTS, CALLS, INHERITS and IMPLEMENTS edges - plus one searchable, embedded chunk per symbol. It lives in the **same graph** as your project knowledge, so a decision, a customer requirement or a gotcha can link straight to the function it concerns.

Indexing runs where the code already is (the published MCP server, the CLI, or an Anvil agent) and uploads only structure and per-symbol chunks; re-indexing is incremental, so after a commit only the changed files travel - seconds, not minutes.

Agents get four tools on top of it:

| question | tool |
|---|---|
| Where is X defined? What is its signature, how many callers? | `code_symbol` |
| Who calls X? What does X call? (with depth) | `code_trace` |
| What breaks if I change these files or symbols? | `code_impact` |
| What is this repository, its packages, hotspots and dead code? | `code_architecture` |

## Why it matters

**Your knowledge stops living in one chat window.** Today every coding agent rebuilds its picture of your repository from scratch - per session, per tool, per machine. Claude Code on the laptop, Cursor at the office, Codex in CI and the agent on your server each pay for the same exploration again, and none of them remembers what the other one found out. With a Codebase KB in your cloud, they all connect to the same code brain: what one agent learned, the next one already knows. Switch harness, switch machine, switch model - the knowledge comes along, because it is stored in GCTRL, not in the tool.

**Tokens go to thinking, not to grep.** Structural questions are the bulk of what an agent does before it edits anything, and grep-and-read is the most expensive way to answer them: whole trees scanned into the context window, on every turn. Answered from the graph they cost a fraction - measured on GCTRL's own repository (Rust, TypeScript, Python, 468 code files): **94 % fewer tokens** across twelve structural questions, all twelve answered correctly; on a 1,000-file TypeScript application **90 % fewer**, again 12/12. The method and the raw numbers are in the [benchmarks](/docs/benchmarks#coding-with-the-graph).

**The why lives next to the where.** Architecture decisions, conventions and the reason a function looks the way it does are stored on the very symbols they concern. `query` blends decisions, docs and code chunks into one answer; the code tools give the exact place. The next session inherits both instead of rediscovering them.

**Yours, scoped, on your terms.** The code brain runs in your cloud or on-prem. Every access token carries its own *Codebase access*; a KB-scoped colleague token sees the repositories it was granted and nothing else - and can create the code graph of the repository it works in without an administrator preparing anything. Indexing is a line someone writes (`GCTRL_CODE_AUTO_INDEX`, `gctrl init`); code never leaves the machine by accident.

## How agents use it - the coding protocol

The GCTRL skill (served at `/api/agent/skill.md`, shipped with the MCP server) tells every connected agent how to work in a repository:

1. **Index once per session** - `gctrl_code_index(repoPath)`; hosts that set `GCTRL_CODE_AUTO_INDEX` do it at start-up.
2. **Navigate through the graph before opening files** - `code_symbol`, `code_trace`, `code_architecture`; then read only the ranges they point to.
3. **Before changing a symbol** - `code_impact`, and handle every caller it lists.
4. **After larger edits** - index again.
5. **Why vs where** - `query` for decisions and docs, the code tools for the place.
6. **Write back** - decisions and gotchas into the repository's CODE knowledge base, naming symbols exactly.

## Switch it on

- **Any agent, two lines:** create an access token on the Access page, run `gctrl init` in the repository. It writes the MCP config with the gateway entry (knowledge tools) and a `gctrl-code` entry (code tools, auto-index of this repository) for Claude Code, Cursor or Codex - or copy the same two-entry snippet from the Access page.
- **Anvil:** nothing to do. Project sessions index the project directory into the project's code graph (`Projects/<client>/<project>/Code`) when the agent starts; personal sessions file code under `Users/<name>/Code`.
- **CLI:** `gctrl code index <path>` and `gctrl code status <compilationId>`.

## See also

- [Benchmarks](/docs/benchmarks) - the protocol bench numbers and method
- [The GCTRL Memory Skill](/docs/memory-skill) - Rule 3, the coding protocol
- [Agents & MCP](/docs/agents-mcp) - connecting any harness
- [Access Control](/docs/access-control) - Codebase access per token
