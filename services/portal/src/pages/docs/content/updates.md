# Update History

GCTRL gets better with every release - and we ship in the open. Below is the running
record of what's new: fresh capabilities, faster extraction and retrieval, and
continuous hardening. Every change earns its place, proven against our benchmarks and
automated shipping gate before it reaches you.

Transparency is part of the product. A knowledge platform you build on should visibly
keep improving - so here it is, release by release.

<!-- POST-ROUTINE-ANCHOR: the shipping-test post-routine inserts auto-drafted entries as an HTML comment directly below this line; an author turns each draft into a real `## vX` section and deletes the comment. -->
<!-- baseline-sha: 51c0d8a -->

## v0.7.0 - Plans that scale, unlimited tokens & a big reliability sweep

*22 July 2026 · [GCTRL Team / TortillaJackson](https://github.com/TortillaJackson)*

- **New plan model - Free, Business, Enterprise.** Free now includes 1,000,000 tokens every month at no cost. Business and Enterprise run on unlimited tokens. Plans gate features and seats, never your day-to-day usage.
- **Scoped colleague tokens by seat:** Business includes 10 scoped tokens per license (stack licenses for more seats); Enterprise is unlimited. Embedding your own graph never counts against that.
- **Your balance and plan now read correctly in the client:** the free monthly grant is visible instead of a stale figure, and unlimited plans show as "Unlimited" rather than a meaningless number. The License tab was cleaned up into a single, clear view.
- **Imports reliably land in the graph you chose:** connector and vault ingests (Obsidian, folder sync, uploads) that completed but left their nodes invisible now appear in the target graph as expected.
- **Retry failed extractions without re-uploading:** re-run a single failed job or all failed jobs at once; connector jobs re-fetch straight from the source.
- **Cloud cloaking hardened further:** hosted "-cloud" models served through a local Ollama are now cloaked too, and the reasoning traces of reasoning models are de-cloaked - so a pseudonym never surfaces to you, and plaintext never leaves for the cloud.
- **Model picker follows your active runtime:** switch to a native GPU Ollama and the installed/selected state reflects that instance; missing recommended models re-appear for one-click download.
- **Cleaner, tidier housekeeping:** deleting an extraction now works and removes its chunks and vectors; auto-generated iframe embed keys no longer clutter your Access Tokens list (only the tokens you deliberately created show, and expired embed keys are pruned nightly); a background loop that could pile up maintenance jobs was fixed.
- **Hardware panel detects Apple Silicon and NVIDIA GPUs** for host GPU reporting.
- **Security hardening:** license activation is more robust, and access-token creation never trusts client-supplied plan or credit values.

## v0.6.0 - Observability, GPU extraction & hardened cloaking

*13 July 2026 · [GCTRL Team / TortillaJackson](https://github.com/TortillaJackson)*

- **GPU acceleration for knowledge extraction (NER):** on GPU boxes now up to ~130× faster - a large document extracts in seconds instead of minutes.
- **End-to-end observability across the whole platform** (optional, self-hosted Arize Phoenix): every extraction, retrieval and LLM step is traceable. Off by default.
- **Cloud cloaking hardened and proven end-to-end:** names, companies, amounts and emails are pseudonymized before they reach a cloud model, and the answer is de-cloaked locally. Two edge cases (word boundaries, streaming leak) fixed.
- **MCP server:** GCTRL functions are now machine-accessible over MCP-over-HTTP (usable by Claude and other agents).
- **Shipping-test gate extended:** the automated release gate now also covers cloaking (11 checks) and catches compose drift before it ships.

## v0.5.0 - Extraction & retrieval quality

*12 July 2026 · [GCTRL Team / TortillaJackson](https://github.com/TortillaJackson)*

- **New bi-encoder NER as the default:** the ontology can grow almost without bound without slowing extraction down (label-count independent). Quality-gated - better than before on two benchmarks.
- **Typo- and mishearing-tolerant entity search:** "skan module" finds "ScanModule", casing no longer matters - measurably better retrieval.
- **Knowledge dossiers:** on-demand build decoupled (no longer blocks the answer), Ollama models stay warm (no cold-start stutter), revived dossiers are served again.
- **Large documents ingest reliably** (no more spurious "worker died" on multi-minute extractions).

## v0.4.0 - Reliable, scope-safe retrieval

*11 July 2026 · [GCTRL Team / TortillaJackson](https://github.com/TortillaJackson)*

- **Multi-hop graph neighbourhood fixed:** connected nodes (across several edges) are found reliably - including incoming edges like "person develops module".
- **Scoped colleague tokens:** a restricted user gets exactly the knowledge of their granted knowledge bases - without a colleague's knowledge leaking in (leak-safe by construction).
