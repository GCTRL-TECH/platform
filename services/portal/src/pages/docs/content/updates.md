# Update History

GCTRL gets better with every release - and we ship in the open. Below is the running
record of what's new: fresh capabilities, faster extraction and retrieval, and
continuous hardening. Every change earns its place, proven against our benchmarks and
automated shipping gate before it reaches you.

Transparency is part of the product. A knowledge platform you build on should visibly
keep improving - so here it is, release by release.

<!-- POST-ROUTINE-ANCHOR: the shipping-test post-routine inserts auto-drafted entries as an HTML comment directly below this line; an author turns each draft into a real `## vX` section and deletes the comment. -->
<!-- baseline-sha: d131014 -->

## v0.8.7 - A fresh install works out of the box, and says so when it does not

*16 August 2026 · [GCTRL Team / TortillaJackson](https://github.com/TortillaJackson)*

- **A new installation reached under its own hostname flickered instead of showing the activation dialog.** The screen reloaded several times a second and nothing could be clicked. The activation check runs before anyone signs in, because a machine installed minutes ago has no accounts yet, but it was answered as if a session were required. The rejection sent the browser to the sign-in page, loading that page ran the check again, and the loop never ended. Installing on localhost never showed it, because the activation step is skipped there. The check now answers without a session, and it answers with less: reachability and activation state only, never the licence tier or credit balance of an installation that has not signed anyone in yet.
- **On Linux, extractions produced entities and no relations at all.** If Neo4j, Qdrant or Ollama were already running on the machine, GCTRL was told to reach them under a name that Docker on Linux does not resolve unless the container is explicitly taught it - and of the services that need it, only one had been. So the extraction engine could not reach the model that reads relations, could not reach the one that builds embeddings, and quietly finished with a handful of unconnected entities, most of which were then tidied away as isolated. Every service that can be pointed at a program on your own machine now resolves it, in the published stack and the deployment template alike, and a build check keeps the installer from ever again handing out an address the stack cannot resolve.
- **An extraction that lost half its pipeline no longer reports plain success.** Relations skipped because the language model was unreachable, or embeddings that never came back, left the job marked "completed" with the reason buried in a log file - which is precisely why a broken installation looked healthy. Such a job is now marked as completed but incomplete, carries the reason with it, and shows up that way in the extraction list, the job page, the command line, the n8n trigger and for connected agents. A knowledge graph that is missing half of itself says so.


## v0.8.6 - Deleting a knowledge base now deletes its knowledge

*14 August 2026 · [GCTRL Team / TortillaJackson](https://github.com/TortillaJackson)*

- **Deleting a knowledge base left every entity behind in the graph database.** The knowledge base disappeared from your account, but its nodes and relationships stayed in Neo4j forever, and with the knowledge base gone there was nothing left that could ever find them again. Deleting an extraction had the same result by a different route: it skipped the graph on purpose and deferred to knowledge-base deletion, which did not do it either. Nothing in GCTRL ever removed an entity, so every install has been accumulating the remains of everything its owner deleted. Both paths now clean up after themselves, and a nightly sweep clears what earlier versions left behind.
- **Shared entities survive a deletion that is not theirs.** The same entity often comes from several documents, so removing one of them must not take the entity with it. Every node and relationship now records all the extractions it came from, not just the most recent one, and deletion removes an entity only once the last of them is gone. Existing graphs are upgraded to this record automatically on the first start after the update.
- **A knowledge base shared with a colleague showed them less than it should.** Access for a scoped colleague was decided by which extraction touched an entity *last*, so an entity that also appeared in a knowledge base someone else updated more recently silently vanished from their view - it was in the graph, it was granted to them, and it did not show up. Access is now decided by everything an entity belongs to.
- **Exporting a knowledge base produced an empty file.** Every export - JSON-LD, RDF Turtle and GraphML alike - looked up the graph by a marker that only an internal bookkeeping node carries, so it never found a single entity. Exports now contain what the knowledge base actually holds.

## v0.8.5 - Word documents laid out in text boxes are readable again

*14 August 2026 · [GCTRL Team / TortillaJackson](https://github.com/TortillaJackson)*

- **A .docx whose text sits in text boxes or tables was rejected as empty.** The extractor read only the document's plain paragraphs, which is exactly what a layouted Word file does not use: a booklet, a one-pager or a form puts every line in a text box, and tables were skipped as well. Such a file came back as "DOCX contained no extractable text" although it was full of it - on the document that surfaced this, 3806 characters in 16 text boxes and nothing outside them. Text boxes, tables, headers and footers are now read along with the body, in document order. Word stores a text box twice (a modern and a legacy copy of the same text), and a repeated header is inherited rather than re-written, so both are recognised and counted once instead of turning up as duplicates in your knowledge base.

## v0.8.4 - Updates clean up after themselves

*13 August 2026 · [GCTRL Team / TortillaJackson](https://github.com/TortillaJackson)*

- **Every update used to leave its predecessor on your disk, forever.** GCTRL's images ship under a moving `latest` tag, so each update pulled the new image and quietly abandoned the old one: still on the machine, still several gigabytes, referenced by nothing. Nothing ever collected them, so a machine that had been updated a dozen times was carrying a dozen dead copies of GCTRL. Updates now reclaim them, both before pulling and right after the swap, so an installation stays at the size of the version it is running. The clean-up runs in the in-app updater, the `gctrl.tech/update` script and the pip installer alike, and it reports what it freed instead of doing it behind your back.
- **The clean-up only ever touches GCTRL's own images.** It identifies them by the registry they came from, and skips anything a container still uses, running or stopped. Other software on the same machine is never considered, not even its unused images. If you need the old copies kept anyway, for instance on a machine with no route to the registry, set `GCTRL_KEEP_OLD_IMAGES=1` in your `.env`.
- **Freeing the disk before the download also fixes the update that ran out of space.** The reclaim happens first, so the room the incoming images need is made available before they start arriving rather than after.
- **Rollback works now.** It was recording internal image IDs and then trying to fetch them as if they were addresses, which cannot work, and the failure was swallowed, so rolling back appeared to succeed and changed nothing. It now records proper image addresses, fetches the previous version from the registry and repoints your stack at it. `https://gctrl.tech/rollback` also served the website instead of the script until now, so the command printed at the end of every update was never able to run.

## v0.8.3 - The install command on the homepage works on every machine again

*13 August 2026 · [GCTRL Team / TortillaJackson](https://github.com/TortillaJackson)*

- **The one-line install on the homepage was a dead end on most Linux machines.** It read `pip install gctrl && gctrl install`, and on Arch, Debian 12+, Ubuntu 23.04+, Fedora 38+ and any Mac running Homebrew's Python, pip flatly refuses to write into the system Python: it answers `error: externally-managed-environment` and stops before it has even looked up the package. Nothing was wrong with the package, but the very first command on the site failed for a large share of self-hosters. The homepage shows the shell installer again, `curl -fsSL https://gctrl.tech/install | bash`, which has no such gate.
- **The install docs now say what to run on your system instead of what usually works.** curl is the recommended path on macOS and Linux, pip is the native Windows path, and a new section on externally managed environments gives the four real answers - pipx, uv, an explicit `--break-system-packages`, or a virtualenv - along with the follow-on trap where the freshly installed `gctrl` command is not yet on your `PATH`. The pip package itself is unchanged and still installs the identical stack.

## v0.8.2 - A new knowledge base can be born private

*13 August 2026 · [GCTRL Team / TortillaJackson](https://github.com/TortillaJackson)*

- **An integration creating knowledge bases for you can now set their privacy mode.** Private Memory (`open` / `cloaked` / `local_only`) could only ever be changed from a signed-in session, so anything created on your behalf through an access token - a workspace tool provisioning a graph per project, for instance - was stuck at the open default, and a tool that tried to tighten it got a refusal it could only swallow. The setting is now accepted when the knowledge base is created, and the response says which mode it got. Changing the mode of an existing knowledge base stays a signed-in-session action: at creation there is no earlier choice to overrule, but later there is, and a delegated key must not be able to loosen what you decided.

## v0.8.1 - Folders tell the truth, and new knowledge bases file themselves

*10 August 2026 · [GCTRL Team / TortillaJackson](https://github.com/TortillaJackson)*

- **Every folder showed "0 graphs", however full it was.** The count was worked out in the browser from the knowledge-base list, and that list is the 20 newest unless you ask for more - so any folder whose graphs were older simply counted nothing. It also shrank while you typed in the search box, because it counted the filtered result. The number now comes from the server, covers everything in a folder including its subfolders, and no longer moves when you search.
- **New knowledge bases now land in a folder by themselves.** Placement used to be a separate step after creation, and several paths skipped it: knowledge bases created from a chat, the result of a fusion, and graphs made through the API all ended up loose at the top level. Creating a knowledge base and filing it are now one operation, so personal graphs go to `Users/<name>/` and a project's graph to `Projects/<customer>/` without anyone having to remember.
- **Deleting a folder moves its contents up, as the button always promised.** Until now the graphs and subfolders inside it dropped to the top level instead of moving into the parent folder.
- **Obsidian imports get their own graph under `Global/Obsidian`.** An import that named no target used to be added to your oldest knowledge base, which is how a single graph quietly absorbed years of unrelated material. Choosing a target explicitly still overrides this.
- **Access tokens scoped to specific knowledge bases can no longer reshape your folders.** Such a token could rename, move and delete any folder in the account and relocate graphs it had no access to. Folder changes are now an owner action, and moving a graph into a folder that is not yours is refused instead of silently hiding it.
- **A new account starts in `Users/<name>`.** The old "My Workspace" folder is gone; it was created for everyone and used by nothing.

## v0.8.0 - Cloaked cloud chat is as fast as uncloaked

*7 August 2026 · [GCTRL Team / TortillaJackson](https://github.com/TortillaJackson)*

- **Pseudonymizing a chat request no longer costs you seconds.** Cloaking compares your prompt against the entity dictionary built from your own documents, and it used to test every character of the prompt against every entry of that dictionary. On a long conversation with a large knowledge base that got expensive fast: on our own box a 60,000-character prompt spent about 35 seconds in the cloak step alone, before the model had even seen it. Now only the entities that can actually occur in the text are considered, the matcher runs without re-allocating on every comparison, and the pseudonym registry is read once per request instead of once per message. The same measurement is now about 0.3 seconds, and time-to-first-token with cloaking on is indistinguishable from cloaking off. What the cloud model receives is byte-for-byte what it received before, so nothing about the protection changes, only its cost.

## v0.7.9 - Extraction duration shows real processing time, not queue wait

*5 August 2026 · [GCTRL Team / TortillaJackson](https://github.com/TortillaJackson)*

- **"Your Extractions" now reports the actual processing time.** The per-job duration was measured enqueue-to-completion, which also counted the time a job spent waiting in the queue behind other jobs - so a 4.8-second extraction inside a batch could read as ~481 seconds. The worker now stamps the true processing time (dequeue to result) onto each job and the list shows that. Jobs recorded before this update fall back to the old wall-clock reading.

## v0.7.8 - Reasoning-skip speedup extended to distillation and conflict resolution

*5 August 2026 · [GCTRL Team / TortillaJackson](https://github.com/TortillaJackson)*

- **The `think: false` speedup now covers the rest of the pipeline's background LLM work.** After extraction (v0.7.7), the same reasoning-skip now applies to the FUSE distillers - the auto-maintained knowledge wiki, on-demand dossiers and the user-profile summary - and to the classification-conflict resolver. On a reasoning model like gemma4:31b these skip the chain-of-thought they only discard anyway, for the same multi-x speedup at identical output. User-facing chat and RAG answers are deliberately left untouched, so they keep their reasoning. Per-service overrides to keep reasoning on: `FUSE_THINK=true` and `CONFLICT_RESOLVER_THINK=true`.

## v0.7.7 - Faster structured extraction on reasoning models

*5 August 2026 · [GCTRL Team / TortillaJackson](https://github.com/TortillaJackson)*

- **Extraction skips the reasoning trace on thinking models.** Relation extraction, auto-classification, entity verification and the fact-log distiller now tell Ollama `think: false`, so a reasoning model (gemma3 / gemma4, gpt-oss, qwen3, deepseek-r1) no longer spends most of its output on a chain-of-thought the extraction parsers then throw away. Measured about 3.7x faster on gemma4:31b (44.7s to 12.0s) at identical JSON, and a ~200-character document drops from ~56s to under 20s. Models without a thinking capability (like the default qwen2.5:7b relation model) ignore the field, so nothing changes for them, and chat keeps its reasoning. Set `KEX_THINK=true`, or a per-purpose `RELEX_THINK` / `AUTO_CLASSIFY_THINK` / `ENTITY_VERIFY_THINK` / `FACT_LOG_THINK`, to keep the reasoning.

## v0.7.6 - EU AI Act transparency + the GCTRL blog

*5 August 2026 · [GCTRL Team / TortillaJackson](https://github.com/TortillaJackson)*

- **EU AI Act transparency, shipped in the product.** Since 2 August 2026 the Act's Article 50 obligations apply, and GCTRL now wears them visibly: Talk to Graph states plainly that you are interacting with an AI system, auto-generated wiki pages carry a machine-readable `ai_generated` marking in their frontmatter (it travels with every Obsidian sync and export), public graph embeds declare themselves via meta tags, and graph exports include AI provenance in their JSON-LD. Our full self-assessment - where GCTRL sits under the Act and what deployers get for their own duties - is published on the [Compliance page](/docs/compliance).
- **The GCTRL blog is live at [gctrl.tech/blog](/blog):** engineering notes on self-hosted knowledge graphs, GraphRAG, sovereign AI memory and compliance, starting with four posts. Linked from the site footer.

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
