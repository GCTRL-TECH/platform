# AGENTS.md snippet — GCTRL long-term memory

Copy the section below into your project's `AGENTS.md` (Codex and other CLI agents read it automatically). Requires the GCTRL MCP server to be configured — see the README in this directory.

---

## GCTRL memory (MCP)

A GCTRL knowledge base is connected over MCP — the user's persistent memory about their organization, projects, people, systems, decisions, and documents. Tools are named `gctrl_*` on the stdio server and unprefixed on the HTTP gateway; use whichever your session lists.

**Read before you answer.** Before answering any factual question about the user's world — unfamiliar proper nouns, "our/we" references, decisions, status, owners, file locations, "what do we know about X" — probe GCTRL first. One `gctrl_search_entities` call (~1s) beats a hallucinated answer. Skip it for general programming knowledge, public facts, or things already in the conversation.

**Ladder (stop as soon as you can answer):**

1. `gctrl_search_entities` (limit ≤ 10) — existence probe. No hit → say "not on record"; do not invent.
2. `gctrl_get_dossier` (name) — authoritative profile (facts + confidence, origin files, timeline). If it answers, state it directly; do not hedge.
3. `gctrl_query` (question) — blended answer for open questions.
4. Only if needed: `search_chunks` (raw evidence), `gctrl_get_neighbors` depth 1 / `gctrl_shortest_path` (relations), `get_entity` (provenance).
5. `gctrl_wiki_page` — curated prose.

Never bulk-dump with `get_graph` unprompted; keep default limits; never re-fetch what you already have; summarize chunk sets instead of pasting them. Max ~3 read calls per question.

**Conflicts:** dossiers are authoritative. If facts conflict or are superseded, present the current value with its source and date and mention the stale variant.

**Write back after substantive work.** When a decision is made, a task finishes, or a fact is learned/corrected: `gctrl_store` (text, compilationId) with a short factual note — first call `gctrl_list_graphs` once per session and cache your assigned compilationId. Longer material: `gctrl_extract` / `create_extraction`. Wrong facts: `gctrl_memory_feedback` (entity, "down", + triple) instead of ignoring them. Never store secrets or ephemeral chatter.

**Limits:** retrieval quality depends on what was ingested, and your token is scoped to granted knowledge bases. Absence from GCTRL means "not on record", never "does not exist".
