# Architecture

**GCTRL** is a **stateless orchestration middleware** for knowledge graphs and agent memory. It does not replace your databases - it sits *on top* of them, turning unstructured sources into a queryable graph plus organised memory layers, then serving that memory to your agents.

## Core idea: middleware, not a database

GCTRL coordinates four storage engines but holds no durable state of its own. Every fact, vector, and relationship lives in one of the backing stores. GCTRL is the **ingestion layer** and **memory organiser** that runs above them.

| Store | Default engine | Holds | Swappable |
|-------|---------------|-------|-----------|
| **Graph** | Neo4j | Entities, relationships, compilations (the cold, structured memory) | Yes |
| **Vectors** | Qdrant | Text-chunk embeddings for semantic retrieval | Yes |
| **Relational** | Postgres | Accounts, licensing, job metadata, audit, provenance | Yes |
| **Cache / queue** | Redis | Job queues, coordination, ephemeral state | Yes |

All four are **bundled** so a fresh install runs with one command. All four are **swappable** - point GCTRL at your own managed Neo4j, Qdrant, or Postgres via environment variables or **Settings → Infrastructure**. Because GCTRL keeps no hidden state, repointing a store is a configuration change, not a migration of GCTRL itself.

## Why stateless matters

- **Own your data.** Everything persists in stores you operate, on hardware you control. GCTRL can be torn down and redeployed without losing knowledge.
- **No lock-in.** Swap any backing engine for your managed/cloud-hosted equivalent. The middleware contract stays the same.
- **Deterministic raw storage.** Source chunks and graph triples are stored verbatim and reproducibly, giving agents grounded, drift-free context.
- **Organised memory on top.** Above the raw stores, GCTRL maintains parallel memory layers (dossiers, chunks, graph, wiki) so agents read the *right* representation for each task.
- **High-performance graph + vector combo.** A property graph (Neo4j) for structure and traversal plus a vector index (Qdrant) for semantic recall - hybrid retrieval gets both structural precision and fuzzy recall in a single query path.

## Layered architecture

```
                         ┌──────────────────────────────────────┐
                         │            AGENTS (via MCP)           │
                         │   Claude Code · Cursor · orchestrators │
                         └───────────────────┬──────────────────┘
                                             │  ~30 MCP tools (clearance-filtered, audited)
┌────────────────────────────────────────────┴───────────────────────────────────────────┐
│                                  GCTRL MIDDLEWARE (stateless)                             │
│                                                                                          │
│   KEX  ─────────▶  FUSE  ─────────▶  Manage KGs  ─────────▶  Talk-to-Graph (RAG)         │
│   extract           merge +            CRUD /                 hybrid vector + lexical      │
│   entities +        entity             traverse /             + graph retrieval            │
│   chunks            resolution         provenance                                          │
│                     → dossiers + wiki                                                      │
└───────────────────────────────┬──────────────────────────────────────────────────────────┘
                                 │  reads / writes (no GCTRL-side persistence)
        ┌────────────────┬───────┴────────┬─────────────────┬──────────────────┐
        ▼                ▼                ▼                 ▼                  ▼
   ┌─────────┐      ┌─────────┐      ┌──────────┐      ┌─────────┐
   │  Neo4j  │      │ Qdrant  │      │ Postgres │      │  Redis  │
   │ (graph) │      │(vectors)│      │(relational)│    │(queues) │
   └─────────┘      └─────────┘      └──────────┘      └─────────┘
        └──────── swappable: bring your own managed stores via env / Settings ─────────┘
```

## Data-flow pipeline

GCTRL moves data through four cooperating modules. Each stage writes to the backing stores; nothing is buffered permanently inside GCTRL.

```
Sources                KEX                    FUSE                       Stores
(files, text,   ─▶  extract entities  ─▶  merge jobs + entity     ─▶  Neo4j  (entities/relations)
 code repos,        + text chunks         resolution → unified        Qdrant (chunk embeddings)
 connectors)        + embeddings          graph, HOT dossiers,        Postgres (metadata/provenance)
                                          curated Wiki pages

Stores  ─▶  Manage KGs            ─▶  Talk-to-Graph         ─▶  Agents
            CRUD / traverse /          hybrid RAG over           consume via MCP tools,
            provenance / refresh       chunks + graph,           write conclusions back
                                       clearance-filtered,
                                       cited answers
```

1. **Sources → KEX.** Raw text, files, and code repositories are ingested. KEX extracts entities and relations and chunks + embeds the text.
2. **KEX → FUSE.** Multiple extraction jobs are merged. Entity resolution collapses duplicates into one unified graph, and FUSE distills HOT entity dossiers and human-readable Wiki pages.
3. **FUSE → Stores.** Structured entities/relations land in Neo4j; chunk embeddings in Qdrant; metadata, provenance, and audit in Postgres.
4. **Stores → Manage KGs.** Compilations are created, traversed, corrected, exported, and refreshed on schedule.
5. **Manage KGs → Talk-to-Graph.** Hybrid retrieval (vector + lexical + graph) answers questions with citations, filtered by clearance.
6. **Talk-to-Graph → Agents.** External agents reach every stage over MCP, with all calls clearance-filtered and audited.

## Benefits at a glance

- **Data sovereignty** - on-prem, swap any store, nothing leaves your control.
- **No vendor lock-in** - open backing engines, configuration-driven swaps.
- **Grounded context** - deterministic raw storage for reproducible recall.
- **Compounding memory** - organised layers that agents read from and write back to.
- **Performance** - graph traversal + vector recall combined in one retrieval path.

## See also

[Introduction](introduction.md) · [Modules](modules.md) · [Memory Layers](memory-layers.md) · [Agents & MCP](agents-mcp.md)
