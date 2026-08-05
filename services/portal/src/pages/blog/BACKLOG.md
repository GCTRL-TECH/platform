# Blog Topic Backlog

Priority-ordered queue for the automated publishing pipeline (see PIPELINE.md).
The pipeline takes the top `queued` topic each run, researches it, writes the post,
marks it `published: <slug>`, and appends fresh researched topics to keep the queue
at 15+ entries. Statuses: `queued` | `published: <slug>` | `dropped: <reason>`.

Format per entry: target keyword(s), the angle that makes it OURS (not generic
content-farm filler), and any internal links it should carry.

## Queue

1. **status:** queued
   **topic:** How to build a company knowledge graph from unstructured documents
   **keywords:** build knowledge graph from documents, knowledge graph extraction
   **angle:** practical end-to-end walkthrough (ingest -> KEX extract -> FUSE merge -> query), honest about extraction error modes; link /docs/quickstart, /docs/modules
2. **status:** queued
   **topic:** AI memory for coding agents: giving Claude Code, Codex and Cursor one shared brain
   **keywords:** claude code memory, mcp memory server, shared agent memory
   **angle:** MCP gateway as the integration surface; what one agent learns the next one knows; link /docs/agents-mcp, /integrations
3. **status:** queued
   **topic:** Entity resolution: why your knowledge base has five copies of every company
   **keywords:** entity resolution, entity matching, knowledge graph deduplication
   **angle:** the Databorg/DataBorg/Databorg-GmbH fragmentation problem everyone has; how FUSE merges without training; link /docs/modules
4. **status:** queued
   **topic:** RAG access control: why per-chunk permissions fail and per-element classification works
   **keywords:** rag access control, secure rag, multi-tenant rag
   **angle:** classification travels with the data; scoped tokens for agents; ~0 ms enforcement (benchmarks); link /docs/access-control, /docs/benchmarks
5. **status:** queued
   **topic:** Cloaking: using frontier cloud models without sending real names to the cloud
   **keywords:** llm pseudonymization, gdpr cloud llm, pii masking llm
   **angle:** how entity cloaking works end to end incl. de-cloaking traps we fixed; link /docs/tech-cloaking
6. **status:** queued
   **topic:** Incognito RAG sessions: GDPR-compliant AI chat that leaves no trace
   **keywords:** gdpr ai chat, privacy rag, ephemeral ai sessions
   **angle:** browser-memory-only sessions, right-to-be-forgotten mechanics; link /docs/compliance
7. **status:** queued
   **topic:** The federated wiki pattern: auto-distilled documentation from a knowledge graph
   **keywords:** auto-generated wiki, knowledge distillation, wiki llm
   **angle:** Wiki-LLM as compounding documentation; AI-generated marking (AI Act tie-in); link /docs/modules, /blog/eu-ai-act-rag-deployments-2026
8. **status:** queued
   **topic:** Air-gapped AI: running a full RAG stack with zero internet
   **keywords:** air gapped ai, offline rag, sovereign ai deployment
   **angle:** what actually breaks offline (model pulls, licenses) and how to plan for it; link /docs/compliance, /pricing (Enterprise)
9. **status:** queued
   **topic:** Ollama in production: lessons from running local inference for extraction at scale
   **keywords:** ollama production, local llm inference, self-hosted llm
   **angle:** real ops lessons (port races, native vs docker, model stores, GPU sizing) from our own deployments
10. **status:** queued
    **topic:** Knowledge graph vs. vector database: a data-model decision, not a vibe
    **keywords:** knowledge graph vs vector database, neo4j vs qdrant rag
    **angle:** why GCTRL uses both (Neo4j + Qdrant + Postgres) and what each is for; link /docs/architecture
11. **status:** queued
    **topic:** Benchmarking RAG honestly: why top-k recall numbers lie
    **keywords:** rag benchmarks, rag evaluation, retrieval evaluation
    **angle:** our shipping-gate approach (no release without benchmark pass); publish real numbers; link /docs/benchmarks
12. **status:** queued
    **topic:** TISAX and AI: what industrial suppliers should demand from AI vendors
    **keywords:** tisax ai, automotive ai compliance, iso 27001 ai tools
    **angle:** posture-vs-certification honesty; the questions procurement should ask; link /docs/compliance
13. **status:** queued
    **topic:** n8n + knowledge graphs: automation workflows that read and write shared memory
    **keywords:** n8n rag integration, n8n knowledge base, workflow automation ai memory
    **angle:** concrete recipes (ingest pipeline, enrichment loop) via MCP/HTTP; link /integrations
14. **status:** queued
    **topic:** From SharePoint chaos to one graph: continuous drive sync without the mess
    **keywords:** sharepoint rag, google drive knowledge base, document sync ai
    **angle:** connectors + scheduled refresh + incremental re-sync; dedupe on merge; link /pricing (Business)
15. **status:** queued
    **topic:** What "agent-first" infrastructure actually means
    **keywords:** agent first infrastructure, ai agent memory architecture
    **angle:** agents as first-class token holders with scoped access, not humans-with-cronjobs; link /docs/agents-mcp, /docs/access-control
16. **status:** queued
    **topic:** The hidden cost of context windows: why bigger context is not memory
    **keywords:** context window vs memory, long context rag
    **angle:** context is working memory, graphs are long-term memory; compaction/selection economics
17. **status:** queued
    **topic:** Migrating off a metered memory API: a practical exit guide
    **keywords:** cognee alternative, self-hosted memory layer, migrate rag platform
    **angle:** export formats, re-ingestion strategy, cost comparison worksheet; link /blog/unlimited-tokens-metered-ai-memory
18. **status:** queued
    **topic:** Conflict detection in knowledge graphs: when your documents disagree
    **keywords:** knowledge conflict detection, contradictory data rag
    **angle:** per-entity conflicts as a quality signal, the /quality page approach; link /docs/modules

## Research notes for future refills

- Watch: EU AI Act guidance documents (new Commission guidance = instant timely post).
- Watch: Ollama/open-weight model releases relevant to extraction quality.
- Mine: r/GCTRL questions, GitHub issues, and support emails for real user problems.
- Mine: Umami search referrer queries (what people searched before landing).
