# Introduction

**GCTRL** - *Ground Your AI. Command Your Data.* - is on-prem knowledge-graph and memory middleware for AI and autonomous agents. It sits **on top of your existing storage** and turns raw, unstructured content into a queryable knowledge graph plus a set of parallel memory layers that agents can reason over.

## What GCTRL is

GCTRL is a **middleware layer**, not another database. It runs above the storage you already operate:

| Layer | Default engine | Role | Swappable |
|-------|---------------|------|-----------|
| Graph | **Neo4j** | Knowledge graph storage (entities, relations, compilations) | Yes |
| Vectors | **Qdrant** | Semantic retrieval / embeddings index | Yes |
| Relational | **Postgres** | Platform state, accounts, licensing, job metadata | Yes |
| Cache / queue | **Redis** | Coordination, job queues, ephemeral state | Yes |

All four are **bundled by default** so a fresh install works out of the box, and every one is **swappable** - point GCTRL at your own managed Neo4j, Qdrant, or Postgres when you move to production.

## The ingestion + memory layer for AI

GCTRL does two things that most "AI memory" products do not:

- **Ingests at scale.** It pulls in documents, text, and other unstructured sources, extracts entities and relations, and resolves them into a coherent knowledge graph. This is the **KEX** (extraction) and **FUSE** (fusion / entity resolution) pipeline.
- **Organises memory into parallel layers.** It exposes more than one kind of memory at the same time:
  - **Raw deterministic storage** - exact, reproducible context an agent can store and recall verbatim. No paraphrasing, no drift.
  - **A curated Wiki-LLM** - an auto-distilled, human-readable knowledge surface over your company's data, grounded in the graph.

These layers run in parallel, so an agent can pull **deterministic facts** for grounding *and* **distilled company knowledge** for context in the same workflow.

## How this differs from "agent memory" tools

Most agent-memory tools let an agent **store and organise its own memory** - notes, summaries, conversation history. That is useful, but it starts *after* the data is already small and structured.

GCTRL starts earlier: it **ingests at scale** and **builds the knowledge graph** that the memory sits on top of. In short:

- **Agent-memory tools:** organise what the agent already saw.
- **GCTRL:** ingests the corpus, builds the graph, and *then* serves memory over it.

FUSE's entity-resolution engine is what lets large, messy ingests collapse into one clean graph instead of a pile of duplicates.

## On-prem and GDPR-ready by design

- **Fully on-prem.** Every component runs on hardware you control.
- **Local inference by default.** Embeddings and generation run on local Ollama - zero data leaves the machine, zero token cost.
- **GDPR-ready.** Because nothing is shipped to a third party unless you explicitly connect a cloud provider, GCTRL fits regulated and data-sovereign environments.

## Next steps

Continue to [Installation](installation.md) to bring up the stack with a single command.
