---
title: The Real Cost of Metered AI Memory (and Why We Refuse to Count Tokens)
date: 2026-08-03
description: Cloud memory platforms charge around $2.50 per million tokens after a small free grant. The arithmetic looks harmless - until you run a real team's workload through it.
tags: [pricing, tokens, self-hosted]
---

Cloud memory platforms have converged on a pricing pattern: a small free grant (a million tokens is typical), then a flat rate around $2.50 per million tokens processed. It sounds almost too cheap to think about. Let's think about it anyway.

## What a token actually is (in a memory workload)

A token is roughly four characters. A single-page document is ~600 tokens; a 50-page contract is ~30,000; a typical corporate wiki export lands in the tens of millions. And memory platforms do not read a document once. A real pipeline:

- **ingests** the document (every token, at least once, often 2-3x for chunking and enrichment),
- **extracts** entities and relations (the document plus generated structure),
- **embeds** the chunks,
- **answers questions** over it (the question, the retrieved context - often thousands of tokens per query - and the answer).

The billable surface is not "your documents". It is your documents multiplied by every stage of the pipeline, plus every question anyone ever asks, forever.

## The arithmetic for one ordinary team

Take a 15-person team with an unremarkable knowledge base:

| Workload | Tokens |
|---|---|
| Initial corpus (5 GB of documents, ~1.2B chars) | ~300M ingested |
| Pipeline multiplier (chunk + extract + enrich, conservative 2.5x) | ~750M processed |
| Ongoing ingestion (new docs, ~2%/month) | ~15M/month |
| Queries (15 people x 20/day x ~4k context tokens) | ~26M/month |

At $2.50 per million: roughly **$1,900 to onboard the corpus**, then **$100+ every month, growing with adoption**. Double the team or wire agents into the memory - agents are voracious readers - and the monthly number scales right along.

None of these numbers is scandalous. The problem is the incentive, not the invoice.

## Metering punishes the behavior you want

The value of a memory layer compounds with use: more documents in, more questions asked, more agents connected. Metered pricing taxes every one of those actions. In practice, teams under token billing do exactly what you would predict:

- they ingest selectively ("do we really need the old projects in there?"),
- they discourage exploratory questions,
- they think twice before connecting an agent that might read a lot.

Each decision is individually rational and collectively fatal: a memory layer that people ration is a memory layer that never becomes the shared brain it was bought to be.

## The alternative: make usage structurally free

There is only one honest way to make "unlimited tokens" true rather than a marketing asterisk: run inference on hardware the customer already controls. When extraction, fusion, and chat execute locally, there is nothing for the vendor to meter - the marginal cost of one more question is a few seconds of GPU time you already own.

That is GCTRL's model, and it is why our [pricing](/pricing) has no token line on any tier, including Free. Plans differ in **access tokens** (seats) and the [compliance suite](/docs/access-control) - scoped colleague tokens, clearance enforcement, audit trail - never in how much you may use your own machine. The full reasoning, including what a "token" even means on our pricing page, lives in the [definitions section](/pricing).

## "But cloud models are better"

Sometimes they are, and metering is not the only way to reach them. GCTRL treats cloud models as an opt-in per graph, with [cloaking](/docs/tech-cloaking): entities are pseudonymized locally before anything leaves your network, and de-cloaked locally on the way back. You pay your model provider for the frontier tokens you choose to use - and your memory layer still refuses to meter you.

## The test to run on any memory vendor

Ask one question: **"If my team uses this ten times more next quarter, what happens to my bill?"**

If the answer is "it grows tenfold", you are not buying a memory layer. You are renting one, by the token, with an incentive structure that quietly works against adoption. If the answer is "nothing, it runs on your hardware" - now you can let every document, every question, and every agent in.

*Run the comparison yourself: [self-hosted RAG in 2026](/blog/self-hosted-rag-on-prem-guide) covers the sovereignty and compliance sides of the same decision.*
