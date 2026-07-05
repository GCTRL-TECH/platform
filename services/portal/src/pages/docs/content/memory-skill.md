# GCTRL Memory Skill — Install the Skill

The **GCTRL Memory** skill is a short discipline that teaches a connected agent *how* to use GCTRL's memory layers well: run the one-time setup interview, **read the right layer** for each question, and **write conclusions back** after each task. The write-back habit is the payoff — it is what makes memory compound across sessions instead of every agent starting cold.

Connecting the MCP server gives an agent the *tools*. Installing the skill is what gives it the *discipline* to use them — without it, the tools sit there unused or get called at random. **Always install the skill right after you connect the MCP server or a direct-HTTP integration.**

## One canonical file

The skill text lives in exactly one place and is mirrored everywhere it's needed:

- **Live, always current:** `GET /api/agent/skill.md` on your own instance, or the public mirror at **[gctrl.tech/skill.md](https://gctrl.tech/skill.md)**.
- Every install method below is just "get that file to where your agent reads it from."

## Install per client

### Claude Code

```bash
mkdir -p .claude/skills/gctrl
curl -fsSL https://gctrl.tech/skill.md -o .claude/skills/gctrl/SKILL.md
# user-level alternative (all projects): ~/.claude/skills/gctrl/SKILL.md
```

Claude Code loads it automatically as a project (or user) skill.

### Cursor

```bash
mkdir -p .cursor/rules
curl -fsSL https://gctrl.tech/skill.md -o .cursor/rules/gctrl.mdc
```

Cursor rules read plain Markdown; the file works as-is. (For a `description` + `alwaysApply` front-matter block tuned for Cursor's rule-matching, see `sdk/claude-skill/cursor/gctrl.mdc` in the repo.)

### Codex / AGENTS.md-based CLIs

Append the skill text to the project's `AGENTS.md` (Codex and similar CLIs read it automatically):

```bash
curl -fsSL https://gctrl.tech/skill.md >> AGENTS.md
```

### Any other framework — paste as a system prompt

No skill-file convention? Fetch the text and drop it straight into the agent's system prompt:

```bash
curl -fsSL https://gctrl.tech/skill.md
```

This is the same drop-in pattern used for frameworks like Paperclip or Hermes — `GET /api/agent/skill.md` on your own instance returns your token-aware instance's copy; it never requires an MCP client.

### MCP clients: automatic skill delivery

GCTRL's MCP gateway exposes the **full skill as an MCP resource** (`gctrl://skill`). A compliant client can list it (`resources/list`) and read it (`resources/read`) — so the whole skill can be pulled automatically on connect, no copy step. The `initialize` handshake also returns a short instruction that points the agent at that resource, and MCP clients that fold `initialize.instructions` into their system prompt get the pointer for free.

That short form is a summary, not a substitute: for clients that don't auto-read resources or surface `initialize.instructions`, **installing the full skill file is the reliable path** — it works across every client.

## Where it ships

- **System skill.** It ships with the platform — every internally-connected agent (Pi) already follows it.
- **Copyable.** Exportable into external agents from the connect UI (Onboarding's "Connect Agent" step, or Settings → Agent / Access Control), or via the install commands above.

## Rule 1 — Read the right layer

Match the tool to the question. Reading the wrong layer produces hedged or unfounded answers.

| Question shape | Use | Then |
|----------------|-----|------|
| "What is X? Give me the authoritative answer." | `get_dossier` (HOT) | **State it. Do not hedge** — the dossier is the canonical view. |
| "Tell me about X" (general) | `query` (blended) | Give a blended answer drawn across tiers, with citations. |
| "How is X connected? Where did this come from?" | graph tools (`get_entity`, `get_neighbors`, `shortest_path`) | Report provenance and structure. |
| "Explain X in context" | `wiki_page` (WIKI) | Return the curated prose. |

- **HOT dossier → assert.** When you have an authoritative dossier, answer plainly. Hedging on a trusted dossier wastes the layer.
- **Blended query → synthesize + cite.** For open questions, let the hybrid retrieval blend dossiers, chunks, and graph, and cite sources.
- **Graph tools → provenance/structure.** When the question is about relationships or lineage, traverse rather than guess.
- **Wiki → prose.** When a human needs explanation, hand back curated pages.

## Rule 2 — Write conclusions back

After each task, **write what you concluded** back into your assigned knowledge base:

- Store new facts (`store`), corrections (`correct`), and links (`add_relationships`).
- Pin a dossier (`pin_dossier`) when a conclusion is authoritative and should never be evicted.
- This is the habit that pays off: **future sessions inherit your conclusions** instead of re-deriving them. Memory compounds.

```text
TASK LOOP
  1. Classify the question  → pick the layer (Rule 1)
  2. Read with the matching tool
  3. Answer (assert on HOT, cite on blended)
  4. Write conclusions back → store / correct / add_relationships / pin_dossier
```

## Scoped-token awareness

An agent **only sees the knowledge bases it is granted** by its scoped token (`GCTRL_API_TOKEN`). The skill makes the agent aware of this:

- Do not assume a KB exists — `list_graphs` shows what is in scope.
- A missing entity may simply be out of scope, not absent.
- Every read and write is **clearance-filtered and audited**, so write back only into KBs you are entitled to.

## See also

[Memory Layers](memory-layers.md) · [Agents & MCP](agents-mcp.md) · [Modules](modules.md)
