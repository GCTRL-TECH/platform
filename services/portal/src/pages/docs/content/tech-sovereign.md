# Sovereign & On-Prem

GCTRL runs entirely on hardware you control - data never leaves by default, cost is deterministic, and the deployment can go fully air-gapped.

## What it does

Every component - the graph store, the vector index, the relational store, the job queue, and inference itself via local Ollama - runs on infrastructure you operate. Nothing about a document, a query, or an answer is required to touch a third party's servers. Because the extraction and fusion pipeline runs locally rather than paying per token to a cloud model, cost per document is **deterministic** - it doesn't scale with an external API's pricing, and it doesn't stop working if a provider changes terms or goes down.

## Why it matters / USP

For regulated industries and any organization that has been told "you can't put that in the cloud," on-prem isn't a nice-to-have, it's the entry requirement. GCTRL is built so that requirement doesn't cost you frontier-model-quality extraction and retrieval: the entity detection and entity-resolution numbers on the [Benchmarks](benchmarks.md) page are measured **running fully locally**, with zero training data and zero cloud dependency. Because nothing is architecturally required to leave the network, the deployment can go as far as **air-gapped** - no outbound connectivity at all - for the environments that demand it, while an organization comfortable with selective cloud use can still opt in per graph via [Cloaking](tech-cloaking.md).

Sovereignty here is also a cost argument, not just a compliance one: a per-token cloud bill scales with usage in a way that's hard to forecast at enterprise volume; a deterministic, on-prem per-document cost doesn't.

## How it fits

Sovereignty is the deployment posture underneath the whole pipeline - KEX, FUSE, Manage KGs, and Talk-to-Graph all run locally by default, and every backing store (graph, vectors, relational, queue) is yours to operate and swap for your own managed equivalent.

## In practice

A defense contractor needs an air-gapped deployment with no outbound network access whatsoever. GCTRL runs the full pipeline - extraction, fusion, retrieval - against local Ollama and local stores with connectivity to nothing outside the perimeter, and the classification and audit trail work exactly the same as they would in a cloud-connected install.

## See also

[Compliance & Data Sovereignty](compliance.md) · [Cloaking](tech-cloaking.md) · [Classification & Access Control](tech-classification.md)
