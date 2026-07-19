# Benchmarks

This page reports measured GCTRL numbers alongside **published, cited figures** for other systems on the **same public datasets**. The competitor numbers are quoted from the literature (their own papers), on the same benchmark data - they are **not** head-to-head runs we performed. Where we say "published," read it literally.

> **Honesty note:** direct head-to-head runs against other GraphRAG systems - **LightRAG, Microsoft GraphRAG, Graphiti** - are **in progress** and not reported here. The entity-linking comparisons below are GCTRL's measured results placed next to each competitor's *published* result on the same standard dataset, not a contest we ran end-to-end.

---

## Entity Linking - DBLP-ACM

Standard entity-resolution benchmark (bibliographic record matching).

| System | F1 | Training | Source |
|--------|---:|----------|--------|
| **GCTRL** | **0.97** | **None (unsupervised, zero training)**, with blocking | Measured |
| Ditto | ≈ 0.989 | Supervised | Published (cited) |
| DeepMatcher | ≈ 0.985 | Supervised | Published (cited) |

**The point:** GCTRL reaches **~0.97 with no training data at all.** The supervised systems edge slightly higher but require labeled training pairs; GCTRL gets within striking distance of that quality cold, with blocking for efficiency.

---

## Entity Linking - Abt-Buy

Noisy e-commerce product matching - a deliberately hard benchmark (messy titles, inconsistent attributes).

| System | F1 | Training | Source |
|--------|---:|----------|--------|
| **GCTRL** | **0.866** | **None (unsupervised)**, local embeddings | Measured |
| Ditto | ≈ 0.891 | Supervised (SOTA) | Published (cited) |
| DeepMatcher | ≈ 0.628 | Supervised | Published (cited) |
| Classic string baseline | ≈ 0.48 | None | Published (cited) |

**The point:** GCTRL hits **0.866 with zero training and fully local embeddings** - far above the classic string baseline (≈ 0.48) and the published DeepMatcher number (≈ 0.628), and within range of the supervised SOTA Ditto (≈ 0.891). Near-supervised quality, no training, nothing leaves the machine.

---

## Entity Detection (NER)

Detection-recall - did GCTRL find the entity at all, independent of getting its type exactly right - measured against a hand-adjudicated gold set.

| Metric | Value | Setup |
|--------|------:|-------|
| **Detection-recall** | **0.978** | Bilingual (DE/EN) 32-document business-document gold set, zero-shot GLiNER + format pre-pass |
| Typing accuracy | 0.95 | Same gold set, entities the pipeline actually detected |

**Setup:** 32 adjudicated business documents, German and English, scored against GCTRL's faithful NER output (`entity_mentions`) - not the post-fusion canonical graph. Zero-shot: no per-customer or per-domain training. For context, frontier cloud LLMs score **~0.85 recall** on comparable public NER benchmarks (per the GLiNER2 EMNLP 2025 comparison and CrossNER).

**Honest methodology note:** 32 documents is a lean gold set - treat this as a directional result, not a large-sample guarantee. Detection-recall is scored as the primary NER gate because a missed entity can never be recovered downstream (typing and relation extraction only operate on what NER detected); typing accuracy is the secondary metric, scored only on entities that were actually found.

---

## Retrieval Latency (Agent Memory Access)

How fast an agent can read from GCTRL's memory.

| Metric | Value |
|--------|------:|
| **p50 (overall)** | **7-27 ms** |
| **p95 (overall)** | **sub-50 ms** |
| Graph entity-search p50 | ~7 ms |
| Vector source-text search p50 | ~44 ms |

Graph entity lookups are the fast path (~7 ms p50); vector source-text search is the slower path (~44 ms p50). Even so, p95 stays **under 50 ms** end-to-end - fast enough to sit inside an agent's reasoning loop without becoming the bottleneck.

---

## Access-Control Overhead ≈ 0 ms

Enforcing clearance and grants on every query costs effectively nothing.

| Token | p50 latency |
|-------|------------:|
| Full-clearance token | baseline |
| Public (restricted) token | **~0.1 ms** difference |

A full-clearance token and a public token differ by roughly **0.1 ms at p50.** **Compliance is effectively free** - you do not trade latency for the audit trail and clearance enforcement described on the Access Control and Compliance pages.

---

## Matching-Engine Throughput

| Metric | Value |
|--------|------:|
| Scaling | **sub-quadratic, ~O(n^1.5)** |
| Candidate generation | **~2,750 entities/sec** |
| End-to-end ingest | **~220 entities/sec** |

The matching engine scales **sub-quadratically (~O(n^1.5))** and generates candidates at **~2,750 entities/sec.** End-to-end ingest runs at **~220 entities/sec**, and that ceiling is **bound by graph-write speed - not the matching engine.** The matcher is comfortably ahead of the write path.

---

## Vector Store Is Swappable (Qdrant Note)

Vector search is the **slowest retrieval step** - ~44 ms p50 versus ~7 ms for graph entity-search. GCTRL uses **Qdrant** for vector search by default, and **Qdrant is swappable.** Point GCTRL at a faster vector store and you cut the slowest part of query latency directly. The graph path is already fast; the vector path is where there is headroom.

See **FAQ / Troubleshooting** for how to point GCTRL at your own vector store via Settings → Infrastructure.

---

## Summary

| Area | Result | Framing |
|------|--------|---------|
| DBLP-ACM EL | F1 **0.97**, zero training | vs published supervised SOTA ≈ 0.985-0.989 |
| Abt-Buy EL | F1 **0.866**, zero training, local | vs published baseline ≈ 0.48, DeepMatcher ≈ 0.628, Ditto ≈ 0.891 |
| Entity detection (NER) | detection-recall **0.978**, typing 0.95, zero-shot | vs ~0.85 recall for frontier cloud LLMs on comparable public NER benchmarks |
| Retrieval latency | p50 **7-27 ms**, p95 **< 50 ms** | graph ~7 ms, vector ~44 ms |
| Access-control overhead | **~0.1 ms** p50 | compliance is effectively free |
| Matching throughput | **~2,750 entities/sec** candidates | sub-quadratic ~O(n^1.5) |
| Ingest throughput | **~220 entities/sec** | bound by graph-write, not matching |

GraphRAG head-to-heads (LightRAG, Microsoft GraphRAG, Graphiti) are in progress and will be added when complete.

---

## See also

- **Access Control & Multi-Tenancy** - the clearance and grant model whose overhead is ~0 ms.
- **Compliance & Data Sovereignty** - local inference and audit trail behind these local-only numbers.
