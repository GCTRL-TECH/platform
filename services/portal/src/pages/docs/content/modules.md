# Modules

GCTRL ships four cooperating modules that form a single pipeline from raw sources to agent-ready memory: **KEX** (extraction), **FUSE** (fusion / entity resolution), **Manage KGs** (lifecycle), and **Talk-to-Graph** (retrieval). Each is reachable from the portal UI and over the API/MCP layer. Endpoint paths below are illustrative.

## KEX - Knowledge Extraction

KEX is the ingestion front door. It turns raw, unstructured input into structured graph fragments plus embedded text chunks.

**What it does**

- **Ingests raw text and files** - documents, plain text, and uploads.
- **Parses code repositories deterministically** - repo structure, symbols, and relationships are extracted by rule rather than guesswork, so the same repo always yields the same graph.
- **Runs NER + relation extraction** - identifies entities and the relationships between them.
- **Chunks and embeds text** - splits source text into passages and writes embeddings into the vector store for later semantic retrieval.
- **Tags classification + source provenance** - every extracted item carries its classification (clearance) and a pointer back to its exact source.

**Execution model**

KEX is **job-queue based**. Ingestion runs as asynchronous jobs so large corpora process without blocking, and job status is queryable.

**Endpoints (illustrative)**

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/api/kex/extract` | Run extraction over supplied text/source |
| `POST` | `/api/kex/upload` | Upload a file for ingestion |
| `GET`  | `/api/kex/jobs` | List extraction jobs and their status |

## FUSE - Knowledge Fusion / Entity Resolution

FUSE merges many extraction jobs into one clean, unified knowledge graph. Without it, repeated ingests produce a pile of near-duplicate entities; FUSE collapses them into single canonical nodes.

**Entity resolution (high level)**

FUSE uses a **multi-stage resolver**:

1. An **exact / near-exact pre-filter** quickly matches obvious duplicates.
2. A **semantic resolver with blocking** compares remaining candidates within efficient blocks rather than across the whole graph.
3. An **optional graph-embedding link-prediction** stage surfaces non-obvious links the earlier stages miss.

> The resolver's tuning is intentionally not published here - this is a high-level description of the stages only.

**Beyond merging**

- **Builds HOT dossiers** - compiled authoritative summaries for important entities.
- **Detects communities and central nodes** - finds clusters and the high-influence nodes within them.
- **Distills human-readable Wiki pages** - turns the graph into curated prose.

**Endpoints (illustrative)**

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/api/fuse/merge` | Merge extraction jobs into a unified graph |

## Manage KGs

Manage KGs is the lifecycle layer for knowledge compilations. A compilation can be a **RAW graph** (the structured entities/relations) or a **WIKI view** (the curated prose surface).

**Capabilities**

- **CRUD compilations** - create, read, update, and delete RAW graphs and WIKI views.
- **Graph traversal** - search entities, fetch neighbors, compute shortest paths.
- **Provenance / lineage** - trace any fact back to its source and ingestion job.
- **Corrections** - fix wrong facts so they are **never re-extracted**; the correction sticks across future ingests.
- **Audit** - every change is logged.
- **Export** - extract compilations for downstream use.
- **Scheduled refresh** - keep compilations current on a cron schedule (incremental new-only or full regeneration).

## Talk-to-Graph (RAG)

Talk-to-Graph is the retrieval and question-answering layer over everything KEX and FUSE built.

**Retrieval**

- **Hybrid retrieval** - combines vector (semantic) and lexical (keyword) search over text chunks *and* the knowledge graph, so structural facts and fuzzy recall arrive together.
- **Clearance-filtered** - results are scoped to what the caller is allowed to see.

**Answering modes**

- **Single-pass** - fast, one retrieval round for direct questions.
- **Agentic deep mode** - multi-hop reasoning that traverses the graph across several steps for complex questions.
- **Citations** - answers point back to the chunks and entities they were built from.

**Privacy modes**

- **GDPR incognito** - sessions live in browser memory only; nothing is persisted server-side.
- **Standard mode** - conventional session handling for non-sensitive workflows.

## See also

[Architecture](architecture.md) · [Memory Layers](memory-layers.md) · [Agents & MCP](agents-mcp.md)
