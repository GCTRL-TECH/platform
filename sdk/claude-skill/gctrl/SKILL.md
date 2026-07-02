---
name: gctrl
description: Use the connected GCTRL knowledge base as long-term memory over MCP. Trigger BEFORE answering any factual question about the user's organization, projects, people, systems, decisions, history, or file locations — including "what do we know about X", unfamiliar proper nouns, and "our/we" references — and AFTER completing substantive work (decision made, task finished, fact learned or corrected) to write conclusions back.
---

# GCTRL Long-Term Memory

You are connected to a GCTRL knowledge base over MCP. It holds the user's persistent memory: their organization, projects, people, systems, decisions, and documents. You do not know what it contains until you look — and the user assumes you will look.

## When to read (the most important rule)

Check GCTRL BEFORE answering ANY factual question about the user's world. Mandatory triggers:

- A proper noun you do not recognize (person, project, system, customer, codename).
- "our", "we", "the team", "the project" — the user is assuming shared context you may only have in GCTRL.
- Questions about decisions, status, owners, deadlines, or where a file/document lives.
- "What do we know about X", "remind me", "what was decided", "who is responsible for".
- Anything the user's phrasing assumes you already know.

Rule of thumb: one `gctrl_search_entities` probe costs about a second. A hallucinated answer costs the user's trust. When in doubt, probe.

Do NOT query GCTRL for: general programming knowledge, public facts, or things already established earlier in this conversation.

## The tool ladder (context discipline)

Descend one rung at a time. Stop as soon as you can answer.

1. `gctrl_search_entities` (query, limit ≤ 10) — cheap existence probe. Does memory know this name at all? No hit → say it is not on record; do not invent.
2. `gctrl_get_dossier` (name) — the authoritative compiled profile: summary, key facts with confidence, origin files, timeline. If the dossier answers the question, state it directly. Do not hedge on a dossier.
3. `gctrl_query` (question) — blended answer across all memory layers, for open or multi-entity questions.
4. Evidence and structure, only when rungs 1–3 are insufficient:
   - `search_chunks` — raw source passages for verbatim evidence; quote sparingly.
   - `gctrl_get_neighbors` (name, depth 1) — what X is connected to; `gctrl_shortest_path` (from, to) — how A relates to B.
   - `get_entity` (name) — provenance: which file or extraction job a fact came from.
5. `gctrl_wiki_page` — curated prose page when the user wants readable context, not facts.

NEVER call `get_graph` (bulk dump) with large limits unprompted. Keep every tool's default limits unless the user explicitly asks for an exhaustive listing.

## Trust and conflicts

- Dossiers are HOT and authoritative (each carries a trust score). State their facts plainly.
- If memory holds conflicting values for the same fact (superseded, corrected, or two sources disagree): present the current / highest-confidence value with its origin file and date, and mention that a stale variant exists. Do not silently pick one.
- When the user confirms which value is right, record it (see write-back below) instead of leaving the conflict in place.

## Write-back (what makes memory compound)

- Session start, before your first write: call `gctrl_list_graphs`, pick your assigned knowledge base, and cache its compilationId for the whole session. Never write without an explicit compilationId.
- After substantive work — a decision was made, a task finished, a fact learned or corrected — call `gctrl_store` (text, compilationId) with a short factual note: what was decided or built, why, who owns it. For longer material (a document, a full analysis) use `gctrl_extract` / `create_extraction` instead.
- Found a wrong fact in memory? Call `gctrl_memory_feedback` (entity, "down", plus the triple compilationId/head/relType/tail) so the wrong edge is removed and the correction is remembered. Confirmed a fact is right? Vote "up". Do not just ignore bad memory — you are its editor.
- Do NOT store: secrets or credentials, ephemeral chatter, or anything the user asked to keep out.

## Budget rules

- Use default limits; never re-fetch something already in your context.
- Summarize retrieved chunk sets in your own words — do not paste walls of raw passages into the conversation.
- A typical question should need at most 3 read calls. If 3 rungs of the ladder have not answered it, report precisely what memory does and does not contain and stop.

## Honest limits

Retrieval quality depends on what was ingested. Absence from GCTRL is not evidence of absence in reality — say "not on record in the knowledge base", never "does not exist". Your token is scoped: `gctrl_list_graphs` shows exactly what you may see; a missing entity may simply be out of scope.

## Transport note

The local stdio MCP server prefixes tools with `gctrl_` (e.g. `gctrl_search_entities`); the HTTP gateway exposes the same surface unprefixed (`search_entities`). A few tools exist on one transport only: `gctrl_query` / `gctrl_store` (direct stdio), `search_chunks` / `get_entity` / `create_extraction` / `get_graph` (gateway). Use whichever names your session lists — the ladder and habits above are identical. Full tool reference: the "Agents & MCP" page in the GCTRL docs; this skill is about when and how, not the API.
