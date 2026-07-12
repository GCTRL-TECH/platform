# Update History

GCTRL gets better with every release — and we ship in the open. Below is the running
record of what's new: fresh capabilities, faster extraction and retrieval, and
continuous hardening. Every change earns its place, proven against our benchmarks and
automated shipping gate before it reaches you.

Transparency is part of the product. A knowledge platform you build on should visibly
keep improving — so here it is, release by release.

<!-- POST-ROUTINE-ANCHOR: the shipping-test post-routine inserts auto-drafted entries as an HTML comment directly below this line; an author turns each draft into a real `## vX` section and deletes the comment. -->
<!-- baseline-sha: c9ded03 -->

## v0.6.0 — Observability, GPU extraction & hardened cloaking

*13 July 2026 · [GCTRL Team / TortillaJackson](https://github.com/TortillaJackson)*

- **GPU acceleration for knowledge extraction (NER):** on GPU boxes now up to ~130× faster — a large document extracts in seconds instead of minutes.
- **End-to-end observability across the whole platform** (optional, self-hosted Arize Phoenix): every extraction, retrieval and LLM step is traceable. Off by default.
- **Cloud cloaking hardened and proven end-to-end:** names, companies, amounts and emails are pseudonymized before they reach a cloud model, and the answer is de-cloaked locally. Two edge cases (word boundaries, streaming leak) fixed.
- **MCP server:** GCTRL functions are now machine-accessible over MCP-over-HTTP (usable by Claude and other agents).
- **Shipping-test gate extended:** the automated release gate now also covers cloaking (11 checks) and catches compose drift before it ships.

## v0.5.0 — Extraction & retrieval quality

*12 July 2026 · [GCTRL Team / TortillaJackson](https://github.com/TortillaJackson)*

- **New bi-encoder NER as the default:** the ontology can grow almost without bound without slowing extraction down (label-count independent). Quality-gated — better than before on two benchmarks.
- **Typo- and mishearing-tolerant entity search:** "skan module" finds "ScanModule", casing no longer matters — measurably better retrieval.
- **Knowledge dossiers:** on-demand build decoupled (no longer blocks the answer), Ollama models stay warm (no cold-start stutter), revived dossiers are served again.
- **Large documents ingest reliably** (no more spurious "worker died" on multi-minute extractions).

## v0.4.0 — Reliable, scope-safe retrieval

*11 July 2026 · [GCTRL Team / TortillaJackson](https://github.com/TortillaJackson)*

- **Multi-hop graph neighbourhood fixed:** connected nodes (across several edges) are found reliably — including incoming edges like "person develops module".
- **Scoped colleague tokens:** a restricted user gets exactly the knowledge of their granted knowledge bases — without a colleague's knowledge leaking in (leak-safe by construction).
