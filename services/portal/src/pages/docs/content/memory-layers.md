# Memory Layers

GCTRL organises memory into **four parallel tiers**. Each tier is a different *representation* of the same knowledge, optimised for a different kind of read. Agents pull from the tier that fits the question — and write conclusions back — so memory **compounds** instead of going stale.

## Why four tiers

A single store cannot serve every need. An authoritative one-line answer, the raw evidence behind it, the structural provenance, and a human-readable explanation are four different things. GCTRL keeps all four in sync and exposes each one directly.

| Tier | Name | Backing store | Best read for |
|------|------|---------------|---------------|
| **HOT** | Entity Dossiers | Postgres / graph | Authoritative summary — answer with confidence |
| **WARM** | Text Chunks | Qdrant (+ source) | Evidence passages for grounded answers |
| **COLD** | Knowledge Graph | Neo4j | Structure, relationships, provenance |
| **WIKI** | Curated Prose | Wiki view | Human-readable explanation |

## HOT — Entity Dossiers

Compiled, **authoritative summaries** for important entities, distilled by FUSE.

- **Pinnable** — operators can pin a dossier so it is never decayed or evicted.
- **Trust-scored** — each dossier carries a trust signal so consumers know how reliable it is.
- **Direct answer.** When an agent reads a dossier, it has the canonical view — it should *state* the fact, not hedge.

## WARM — Text Chunks

The **source passages** plus their embeddings, written by KEX into the vector store.

- **Evidence layer** — these are the actual snippets that back an answer and supply citations.
- **Heat-tracked** — usage is measured; frequently retrieved chunks run "hotter."
- **Used in answers** — Talk-to-Graph retrieves chunks here for grounded, cited responses.

## COLD — Knowledge Graph

The **structured entities and relationships** in Neo4j.

- **Permanent** — the durable backbone of all knowledge.
- **Clearance-gated** — traversal and reads respect access control.
- **Provenance** — the graph is where you trace how facts connect and where they came from.

## WIKI — Curated Prose

**LLM-distilled, cross-linked** human-readable pages built by FUSE over the graph.

- **Readable** — narrative prose rather than triples or vectors.
- **Cross-linked** — pages reference related entities for navigation.
- **For explanation** — the right layer when a human (or agent) needs context, not just a fact.

## Memory governance

Tiers stay healthy through an **automatic governance cycle** that runs continuously and can also be triggered on demand:

- **Decay** — stale, unused items lose heat and are aged out.
- **Dedup** — near-duplicate chunks are collapsed to keep the warm tier lean.
- **Promote** — frequently-used **warm → hot**: chunks that keep proving useful get compiled into dossiers.
- **Evict** — distrusted or cold items are removed so noise does not accumulate.

### Health snapshot

A `/memory/health` snapshot reports the state of the tiers:

| Metric | Meaning |
|--------|---------|
| Coverage | How much of the corpus is represented across tiers |
| Store sizes | Item counts per tier (hot / warm / cold / wiki) |
| Heat distribution | How retrieval is spread across chunks |
| Trust distribution | Spread of trust scores across dossiers |

### On-demand maintenance

Operators (and agents with the right scope) can trigger a **maintenance run** to execute the decay/dedup/promote/evict cycle immediately rather than waiting for the scheduled pass.

## The payoff: compounding memory

Agents **read the right layer** for the job:

- **Authoritative dossier** (HOT) → state the answer.
- **Evidence chunks** (WARM) → ground and cite.
- **Graph** (COLD) → trace provenance and structure.
- **Curated prose** (WIKI) → explain in context.

And they **write conclusions back** after each task. Because governance keeps the tiers clean and promotes what proves useful, every session leaves the memory richer than it found it.

## See also

[Architecture](architecture.md) · [Modules](modules.md) · [Agents & MCP](agents-mcp.md) · [GCTRL Memory Skill](memory-skill.md)
