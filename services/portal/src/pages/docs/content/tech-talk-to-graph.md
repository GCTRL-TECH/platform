# Talk to Graph - Grounded, GDPR-Compliant RAG

Ask questions in plain language and get cited answers pulled from your own knowledge graph - with sessions that live in the browser and nowhere else.

## What it does

Talk to Graph is GCTRL's retrieval and question-answering layer over everything KEX and FUSE have built. It runs hybrid retrieval - vector (semantic) and lexical (keyword) search over text chunks, combined with graph traversal - so a query gets both structural facts and fuzzy recall in the same pass. Answers cite the chunks and entities they were built from. Two answering modes cover both ends of the difficulty range: a fast single-pass mode for direct questions, and an agentic deep mode that reasons across multiple hops of the graph for questions that need it.

## Why it matters / USP

Two things set this apart from a generic "chat with your documents" tool. First, it's **grounded in a real knowledge graph**, not just a pile of re-ranked chunks - so an answer about how two entities relate draws on FUSE's resolved, deduplicated structure rather than hoping the right passages happened to land next to each other in a vector search. Second, and specifically for regulated use: an **incognito query mode keeps a session in browser memory only** - the conversation and its context are never persisted server-side, and closing the tab erases them completely. That is a DSGVO/GDPR-aligned default for sensitive or ad-hoc questions, not an opt-out you have to configure correctly to get.

Every answer is also filtered by the caller's [classification](tech-classification.md) at retrieval time, so the same question asked by two different clearances can legitimately return two different, correctly-scoped answers - compliance and conversational RAG are not in tension here.

## How it fits

Talk to Graph is the last stage of the pipeline: **KEX → FUSE → Manage KGs → Talk to Graph**. It queries the compilations Manage KGs maintains, retrieves from the same graph and vector stores KEX and FUSE populate, and is one of the ways the [Multi-Agent Fabric](tech-multi-agent-fabric.md) exposes memory to connected agents.

## In practice

An analyst asks, in incognito mode, "what changed in the Q3 vendor contracts compared to Q2?" - the system retrieves the relevant chunks and graph relations, answers with citations back to both contract versions, and when the browser tab closes, no record of the question or the answer remains on the server.

## See also

[Classification & Access Control](tech-classification.md) · [Compliance & Data Sovereignty](compliance.md) · [Modules](modules.md)
