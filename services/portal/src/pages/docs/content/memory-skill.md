# GCTRL Memory Skill

The **GCTRL Memory** skill is a short discipline that teaches a connected agent *how* to use GCTRL's memory layers well. It has two halves: **read the right layer** for each question, and **write conclusions back** after each task. The write-back habit is the payoff — it is what makes memory compound across sessions.

## Where it ships

- **System skill.** It ships with the platform — every internally-connected agent already follows it.
- **Copyable.** It is exportable into external agents as a **Claude Code skill** or **Cursor rules**, straight from the connect UI, so your own agents adopt the same discipline.

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
