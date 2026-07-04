# KEX — Knowledge Extraction

KEX turns unstructured documents into a structured knowledge graph — locally, fast, and at a deterministic per-document cost.

## What it does

Point KEX at PDFs, DOCX, plain text, a Google Drive folder, an Obsidian vault, or a code repository, and it extracts **entities and the relationships between them**, chunks and embeds the source text for retrieval, and tags every item with its classification and a pointer back to the exact place it came from. The output is graph-ready: nodes and edges FUSE can merge, and passages Talk-to-Graph can cite.

## Why it matters / USP

Most "AI knowledge graph" pipelines wire a document loader to a cloud LLM and prompt it to emit triples — accurate enough, but priced per token and dependent on a round trip to someone else's servers for every page. KEX runs the extraction step **on your own hardware**, so cost is deterministic per document instead of scaling with an API bill, and nothing about the document's content has to leave the building to get structured.

On raw detection quality, KEX's entity detector reaches **0.978 recall** on a bilingual (German/English) business-document benchmark — zero-shot, with no per-customer training — which is frontier-LLM territory on comparable public NER benchmarks, achieved without a cloud round trip. Every extracted item also carries **char-exact provenance** back to its source: not "this came from the file," but exactly which passage and offset. That provenance is what lets an agent cite a fact instead of merely asserting it, and what lets a human correct a wrong extraction with confidence about what it will affect.

## How it fits

KEX is the front door of the pipeline: **Sources → KEX → FUSE → Manage KGs → Talk-to-Graph**. It runs as an asynchronous job queue, so a large corpus — thousands of documents, a full Drive folder, an entire repo — processes in the background while extraction jobs remain individually queryable. FUSE then merges KEX's output across many jobs into one unified graph.

## In practice

A legal team drops three years of contract PDFs into a KEX import. Within the job queue's normal runtime, every contract's parties, dates, and obligations are extracted as entities and relations, tagged with the classification of the source folder, and chunked for search — ready for FUSE to collapse duplicate counterparties into single canonical entities.

## See also

[FUSE — Knowledge Fusion](tech-fuse.md) · [Sovereign & On-Prem](tech-sovereign.md) · [Quick Start](quickstart.md)
