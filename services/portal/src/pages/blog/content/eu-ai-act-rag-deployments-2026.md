---
title: EU AI Act for RAG Deployments: What Actually Applies Since August 2026
date: 2026-08-05
description: Article 50 transparency is enforceable since 2 August 2026, while high-risk duties moved to 2027. A practical checklist for teams running RAG and AI memory in the EU.
tags: [eu-ai-act, compliance, transparency]
---

The EU AI Act's timeline confused everyone this year, so let's start with what is actually true as of August 2026 - and then get practical about what a team running RAG, chat, or an AI memory layer has to do about it.

## The timeline, untangled

- **In force since 1 August 2024**; prohibited practices and AI-literacy duties (Article 4) apply since February 2025.
- **The 2026 digital omnibus** (in force since 27 July 2026) postponed the high-risk obligations: stand-alone Annex III systems now to **December 2027**, AI embedded in regulated products to **August 2028**.
- **What did NOT move: Article 50.** Since **2 August 2026**, transparency obligations are enforceable - people must be told when they interact with an AI system, and AI-generated content needs machine-readable marking.

Translation for most RAG teams: the scary high-risk paperwork got pushed out, but the transparency duties are live right now, and they touch exactly the features you run - chat interfaces and generated content.

## Is your RAG system "high-risk"? Probably not - check anyway

Knowledge management, retrieval, and question answering over your own documents are not Annex III categories. A RAG assistant for internal knowledge is, by intended purpose, not high-risk. It becomes a different conversation when you embed the same system in an Annex III context - employment decisions, credit scoring, essential services. If that is your use case, the deferred deadlines are your planning horizon, and the duties sit with you as the deployer.

We published GCTRL's own classification openly on our [compliance page](/docs/compliance): not high-risk by intended purpose, no prohibited practices, and no GPAI-provider role (we integrate open-weight models you run yourself; the model providers carry the GPAI obligations).

## The Article 50 checklist for RAG teams

Here is the practical list we applied to GCTRL itself - usable for any deployment:

**1. Tell people they are talking to an AI.**
Obvious in context is a defense, an explicit notice is a better one. GCTRL's chat states it plainly in the interface: you are interacting with an AI system, answers are AI-generated, verify via the cited sources.

**2. Mark AI-generated content machine-readably.**
Anything your system generates and publishes beyond the person asking - auto-generated wiki pages, summaries, public embeds, exports - should carry a machine-readable marking. GCTRL stamps `ai_generated: true` into generated wiki markdown, adds meta markings on public graph embeds, and includes provenance in graph exports.

**3. Make answers verifiable, not just plausible.**
The Act's spirit is that humans can oversee AI output. Source-traced answers are the mechanism: every claim links to the chunks it came from. If your RAG stack cannot cite its evidence, transparency is a label without a lever. (This is also just good retrieval engineering - see [GraphRAG vs. Vector RAG](/blog/graphrag-vs-vector-rag).)

**4. Cover Article 4 (AI literacy) with a one-pager.**
Providers and deployers must ensure staff dealing with AI systems have adequate literacy. For a small team this is genuinely a short internal document: who operates the system, what its failure modes are (hallucination, retrieval misses), and how to verify output. Write it, date it, review it yearly.

**5. As a deployer, collect what your duties will need.**
Even with high-risk duties deferred, procurement and works councils are asking now. The artifacts that answer them: an audit trail (who accessed what, including denials), access control with defined [clearance levels](/docs/access-control), a data-governance story (where does the data physically go), and vendor documentation you can hand over. Self-hosted deployments make several of these structural - the [sovereignty argument](/blog/self-hosted-rag-on-prem-guide) and the compliance argument are the same argument.

## What to ask your AI memory vendor

1. Where is your AI Act self-assessment published?
2. How do your chat surfaces disclose AI interaction?
3. How is generated content marked, machine-readably, in every export path?
4. Can I get the audit evidence my own deployer duties will require?
5. Does any of this depend on your cloud - or does it work air-gapped?

Vendors who answer in writing are vendors who did the work. We keep GCTRL's answers on the [compliance page](/docs/compliance), and the transparency features ship in the product itself, on every plan - see [pricing](/pricing).

*This post is engineering guidance, not legal advice. For your specific obligations, especially anywhere near Annex III, involve counsel.*
