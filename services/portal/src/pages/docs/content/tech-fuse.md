# FUSE - Knowledge Fusion

FUSE merges many small, siloed extraction jobs into **one governed, deduplicated knowledge graph** - the step that turns a pile of extractions into a single source of truth.

## What it does

Every KEX job produces its own fragment of entities and relations. Run enough imports and you get the same real-world thing represented a dozen different ways: "Müller GmbH," "Mueller," "the vendor from the Q3 contract." FUSE's entity-resolution engine looks across all of it and decides, with high confidence, which mentions refer to the same underlying entity - then collapses them into one canonical node that carries every relationship and provenance link the fragments had individually. Beyond merging, FUSE also compiles authoritative HOT dossiers for important entities, detects communities and central nodes in the graph, and distills curated, human-readable Wiki pages over the result.

## Why it matters / USP

Cross-source entity resolution is the part most "prompt an LLM to build a graph" pipelines quietly skip, because doing it well without labeled training data is genuinely hard. FUSE's resolver reaches **entity-linking F1 around 0.97** on a standard bibliographic benchmark with **zero training data** - no labeled pairs, no per-customer tuning - landing within striking distance of supervised systems that require exactly that. On a deliberately noisy matching benchmark it holds **0.866 F1**, fully unsupervised and running on local embeddings, well clear of classic string-matching baselines. That is what "near-supervised quality, cold start" means in practice: point FUSE at your silos and it does the deduplication that would otherwise need a data-labeling project.

The payoff compounds. Every additional import doesn't add a pile of near-duplicates - it enriches the same canonical entities the graph already has, so the knowledge base gets cleaner and more complete with use rather than noisier.

## How it fits

FUSE sits between KEX and everything downstream: **KEX → FUSE → Manage KGs → Talk-to-Graph**. It reads extraction jobs, writes the unified graph, HOT dossiers, and Wiki pages back to the stores, and is what Manage KGs, Talk-to-Graph, and connected agents all ultimately query against.

## In practice

Sales, support, and a legacy CRM export all mention the same customer under three slightly different names. A single FUSE merge run resolves them to one canonical entity, so a query for that customer returns every fact from every source - not just whichever import happened to use the name you searched for.

## See also

[KEX - Knowledge Extraction](tech-kex.md) · [Classification & Access Control](tech-classification.md) · [Benchmarks](benchmarks.md)
