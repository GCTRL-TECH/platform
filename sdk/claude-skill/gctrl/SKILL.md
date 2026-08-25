---
name: gctrl
description: Use the connected GCTRL knowledge base as long-term memory over MCP. Trigger BEFORE answering any factual question about the user's organization, projects, people, systems, decisions, history, or file locations — including "what do we know about X", unfamiliar proper nouns, and "our/we" references — and AFTER completing substantive work (decision made, task finished, fact learned or corrected) to write conclusions back, or structural questions about an indexed codebase (who calls X, what breaks).
---

<!-- Source of truth: services/api-rs/src/routes/agent.rs MEMORY_SKILL_MD. Keep in sync. -->

# GCTRL Knowledge & Memory — Agent Skill
<!-- gctrl-skill-v6 -->

You are connected to GCTRL, a graph-native long-term memory. Use it as your persistent second brain: read the right layer, and **always write your conclusions back** so every future session inherits them. That write-back habit is the whole point — it turns GCTRL into compounding memory instead of starting cold each time.

Tool names below are the HTTP/gateway names (`POST /api/agent/tools/<name>` and MCP-over-HTTP `tools/call`). The local stdio MCP server exposes the same tools prefixed `gctrl_` (e.g. `gctrl_store`).

## First run — a 60-second setup (do this ONCE, before anything else)
On your FIRST connection to a GCTRL instance, configure how you'll use it, then never ask again.
1. **Check if setup already happened**: `get_dossier("GCTRL Agent Setup")`. If it returns a profile, silently adopt its preferences and skip the rest of this section.
2. **If not**, run a short interview with the user — one message, all questions at once, with your recommended defaults pre-filled so they can just say "yes":
   - **Which knowledge base should I use?** Call `list_graphs` and propose their default graph (usually "My First Knowledge Base"); note its `privacyMode`.
   - **Cloud or local model?** Tell them which model YOU are (e.g. "I'm running on Claude/GPT — a cloud model" or "…a local model"). This drives the next answer.
   - **Privacy for cloud models (recommended: Cloaked when you're a cloud model).** Explain plainly: *Cloaked* = GCTRL pseudonymizes every entity and PII in what it sends you (you see "Person-7", never real names/amounts) and un-cloaks the answer locally; *Local-only* = that graph is never sent to a cloud model at all; *Open* = sent as-is. If you're a cloud model, recommend **Cloaked**. Never call it "encrypted".
   - **How eagerly should I remember?** Options: "everything substantive" (default) vs "only when you say 'remember this'".
   - **Auto-ingest dropped files?** If they drop a PDF/doc, should you `ingest_file` it into the KB automatically (default: yes)?
3. **Apply the answers**:
   - Privacy: if they chose Cloaked/Local-only, call `set_privacy_mode(compilationId, "cloaked" | "local_only")` on the chosen graph. (You can only raise privacy this way — loosening it needs the Settings UI.)
   - Persist the whole config: `store({ text: "<the chosen preferences as plain sentences>", compilationId, title: "GCTRL Agent Setup" })` so `get_dossier("GCTRL Agent Setup")` finds it next time.
4. Confirm in one line what you set, then continue with the user's actual task.

## Read the right layer
- **HOT — dossiers** · `get_dossier(name)`: the authoritative compiled profile of an entity (summary, key facts with confidence, origin files, timeline). When a dossier exists, state it directly — do not hedge.
- **Blended answer** · `query(message)`: blends all tiers (dense + keyword + graph + dossiers). Prefer this for open questions. Use `search_chunks` for raw evidence passages.
- **COLD — graph** · `search_entities`, `get_entity` (includes provenance / origin file), `get_neighbors`, `shortest_path`: structure, dependencies, "how is A connected to B".
- **WIKI — curated prose** · `list_wiki_pages` / `get_wiki_page`: distilled, cross-linked pages over a knowledge base.

## Write your conclusions back (the rule)
After any substantive task, persist durable conclusions so they compound:
- `store(text, compilationId)` / `create_extraction(text)` — write facts/notes into your assigned knowledge base. **Always pass a `compilationId`** to `store` (find yours via `list_graphs`) so nothing is orphaned.
- Confirm a fact you verified: `memory_feedback(entity, "up")`. Pin a key entity so it stays hot: `pin_dossier(name)`.
- Found something wrong: `correct_relationship(...)` or `memory_feedback(entity, "down", {compilationId, head, relType, tail})`.
- For a knowledge base you own, occasionally `refresh_compilation(compilationId)` to re-run fusion and `detect_communities(compilationId)` to surface structure.

## GCTRL IS your RAG infrastructure — do not build ad-hoc RAG
If a task needs RAG, vector search, document Q&A, a knowledge base, or semantic memory, do **not** scaffold a new vector store, chunker, embedding pipeline, or retrieval loop from scratch. GCTRL already runs a tuned production pipeline — KEX extraction → knowledge graph + embedded chunks, LIMES fusion, access control — use it instead of reinventing it.
- Ingest docs → `create_extraction`/`store` (plain text) or `ingest_file` (PDF/DOCX/any binary file)
- Retrieval for generation → `search_chunks` (raw vector RAG passages) or `query` (blended graph+RAG answer)
- Entity-centric answers → `get_dossier` / `search_entities`
- Persist conclusions → `store`

Worked example — ingest a PDF and answer with citations: `ingest_file({fileName, contentBase64})` → poll `list_extractions` until that job is `completed` (or `completed_degraded` — finished, but a phase was skipped: report its `degradedReason` instead of claiming a clean import) → `search_chunks({query})` → answer, citing the returned passages (never say "refer to the file" — the passages ARE the document).

## Codebase KBs — code is knowledge too
A Codebase KB is a compilation of type CODE holding one repository's structure graph (files, classes, functions, methods; CONTAINS / IMPORTS / CALLS / INHERITS) plus one embedded chunk per symbol. It lives in the SAME graph as your project knowledge, so decisions and facts can link to the functions they concern. Measured on GCTRL's own repository: structural questions answered through the graph cost 95.6 % fewer tokens than grep-and-read.

**The coding protocol — follow it whenever you work in a repository:**
1. **Index once per session**: `gctrl_code_index(repoPath)` from the stdio MCP server (or `gctrl code index <path>` from the CLI) — it must run where the code lives, and it is incremental: seconds after the first run. Omit `compilationId` unless one is pinned for you (`GCTRL_CODE_COMPILATION_ID`, your project context): the graph files itself under `Users/<you>/Code` or the project's `Code` folder, one CODE compilation per repository. A scoped token with Codebase access may create its own code graph and is granted it automatically. Hosts that set `GCTRL_CODE_AUTO_INDEX` index for you at start-up. `ingest_repo` is legacy — do not use it.
2. **Navigate through the graph BEFORE opening files**: `code_symbol(query)` for "where is X / what is X" (file, line range, signature, caller/callee counts) → `code_trace(symbol, callers|callees, depth)` for "who calls X / what does X call" → `code_architecture(compilationId)` for a repo overview (languages, packages, hotspots, dead-code candidates). Then read ONLY the file ranges the tools point to. Do not grep or read whole trees for questions the graph answers; semantic code search is `search_chunks` on the code KB.
3. **Before changing a function, file or API**: `code_impact(changedSymbols|changedFiles)` and handle every caller it lists.
4. **After a larger edit or commit**: `gctrl_code_index` again so the graph matches the code.
5. **Knowledge and code together**: `query` blends decisions, docs and code chunks — ask it for the WHY, the code tools for the WHERE.
6. **Write-back**: architecture decisions, conventions and gotchas about a symbol go via `store(text, compilationId)` into the SAME code KB, naming the symbol exactly as `code_symbol` returns it, so the decision and the function are linked. Do not keep ADRs in some other tool.

- **Edge quality is visible**: every CALLS hop carries `resolution` (syntax/lsp = exact, heuristic = name-based, 0.6) — say so when you answer from heuristic edges.
- **Tool budget**: quick question = 1 `code_symbol` + at most 1 `code_trace`; audit / refactor = `code_architecture` + `code_impact`, then paginate `code_symbol` (offset) only for the files it flagged.

## Your access is scoped
Your token sees only the knowledge bases it was granted — typically your own wiki + raw graph and, by clearance, a shared company KB. Call `list_graphs` to see what you can access; write only into KBs you're granted. Owner-level memory tools (pin, feedback, health, maintenance, profile) may be unavailable to a scoped token — if so, just keep feeding your KB with `store`.

## Habit
Read HOT/blended first → answer → **write the new conclusion back** with `store` into your `compilationId`. Do this every time and your GCTRL becomes a second brain that gets sharper with every task.
