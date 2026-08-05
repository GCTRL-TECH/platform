# Update History

GCTRL gets better with every release - and we ship in the open. Below is the running
record of what's new: fresh capabilities, faster extraction and retrieval, and
continuous hardening. Every change earns its place, proven against our benchmarks and
automated shipping gate before it reaches you.

Transparency is part of the product. A knowledge platform you build on should visibly
keep improving - so here it is, release by release.

<!-- POST-ROUTINE-ANCHOR: the shipping-test post-routine inserts auto-drafted entries as an HTML comment directly below this line; an author turns each draft into a real `## vX` section and deletes the comment. -->
<!-- baseline-sha: f1d1b02 -->

## v0.7.5 - Faster extraction, embeddable node deep-links, cloak-safe tool calls

*5 August 2026 · [GCTRL Team / TortillaJackson](https://github.com/TortillaJackson)*

- **Extraction stops stalling on the wrong model.** Default installs now run relation extraction on their configured relation model (qwen2.5:7b) right away, instead of falling through a 180-second timeout when a mismatched chat model slipped in - so a small document that could take minutes now finishes in seconds. Extra safety net: if you deliberately pick a relation model that is not loaded, the worker fast-fails to the fallback instead of re-paying that timeout on every window of the document.
- **Embeddable graphs can open a specific node.** An embed can now deep-link straight to a node and its Source Text (the underlying chunks), offer free-text node search, and be driven by the hosting page over a strict, origin-checked message channel - all inside the embed's existing read-only, single-graph scope. Nothing new is exposed; it reuses the access the shared embed link already had.
- **Cloud cloaking no longer garbles agent tool calls.** With entity cloaking on for a cloud model, tool results and tool-call arguments now stay byte-exact: machine data handed back to the model is left untouched, and any pseudonym that reaches a tool-call argument is reversed before it leaves the gateway, streaming included - so agentic file and write actions through the cloak gateway are safe again.

## v0.7.4 - Pricing rework: unlimited tokens everywhere, plans buy access & compliance

*5 August 2026 · [GCTRL Team / TortillaJackson](https://github.com/TortillaJackson)*

- **Inference tokens are now unlimited on every plan - including Free.** The 1,000,000-token monthly grant on Free is retired; there is no grant because there is no meter. Extraction, fusion and chat run on your hardware, and plans never touch day-to-day usage.
- **Free is the whole platform for one person:** all four modules, Wiki-LLM, MCP gateway, one full-access token and single-file manual ingest. Non-commercial use.
- **Business (€29 per license / month) is the compliance suite:** 10 scoped colleague tokens per license - stack licenses as the team grows - with KB scoping, clearance enforcement (PUBLIC / INTERNAL / CONFIDENTIAL / RESTRICTED), instant revocation and an audit trail, plus drive connectors and scheduled refresh.
- **Enterprise replaces the former "Individual" tier:** €25,000 / year with 100 seats included and additional seats individually priced - premium support and SLAs, deployment as managed cloud, your cloud, on-prem, air-gapped or sovereign, custom connectors, TISAX & ISO 27001-aware hardening, SSO / SCIM.
- **The pricing page grew a full plan comparison and a definitions section,** so what an inference token, an access token, a license and a seat each mean is spelled out in one place.

## v0.7.3 - pip install, bigger uploads, sharper recall

*29 July 2026 · [GCTRL Team / TortillaJackson](https://github.com/TortillaJackson)*

- **`pip install gctrl`:** a second, first-class way to self-host, alongside the curl script. `pip install gctrl` (or `pipx install gctrl`) then `gctrl install` brings up the same stack - now cross-platform including native Windows, with Docker as the only prerequisite (no curl/openssl/bash needed). The curl one-liner keeps working unchanged.
- **Uploads over 2 MB now ingest:** a hidden framework default capped request bodies at 2 MB, so any document larger than that failed with a "multipart parse" error before the real 25 MB limit ever applied. Lifted - a 3.4 MB PDF ingests end to end.
- **Session fact log:** each ingested document is now distilled into atomic memory facts stored as their own retrievable chunks, so buried one-liners (an updated deadline, a denial, a dated event) surface directly instead of losing the top-k race to bulk prose. A backfill script retrofits already-ingested corpora.

## v0.7.2 - Developer community

*29 July 2026 · [GCTRL Team / TortillaJackson](https://github.com/TortillaJackson)*

- **The GCTRL developer community is live:** join us at [reddit.com/r/GCTRL](https://www.reddit.com/r/GCTRL/) for questions, setups, benchmarks and roadmap discussion. Linked from the site footer next to GitHub.

## v0.7.1 - License activation survives container recreates

*22 July 2026 · [GCTRL Team / TortillaJackson](https://github.com/TortillaJackson)*

Self-hosted operators reported that recreating the app containers (docker compose up -d, same images) could invalidate the license activation and silently stop ingestion. This release removes that whole failure class:

- **Stable instance identity:** activation now binds to a UUID persisted in your config volume, not to ephemeral container properties. Recreates, image updates and compose changes keep the activation - automatically.
- **Self-healing activation:** if the binding ever mismatches, the agent honors your validly signed license in a grace mode and re-attests itself in the background with the stored key. Only an active rejection by the license server (revoked, seat limit) stops enforcement - a temporarily unreachable server never does.
- **No more lost jobs on license hiccups:** ingestion jobs denied by a transient license state are now parked, visibly, and resume automatically the moment the license recovers - instead of failing terminally. Business denials (insufficient credits) still surface immediately.
- **Honest health signals:** the agent's status now reports a machine-readable reason, and a new /health endpoint returns non-200 while the license is unenforceable - so monitoring and the built-in container healthcheck actually catch it.
- **Pin your versions:** set GCTRL_IMAGE_TAG in your .env to pin the whole stack to a release (e.g. v0.1.230) or a commit sha. Every build is published under latest, a version tag and its git sha.
- Also fixed: agent timeouts are treated like an unreachable agent (graceful degradation instead of hard job failures), and retried jobs no longer trip the "queue stalled" watchdog prematurely.

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
