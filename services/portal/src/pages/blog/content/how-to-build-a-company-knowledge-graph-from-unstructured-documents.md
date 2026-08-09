---
title: How to Build Knowledge Graph from Documents for Your Company
date: 2026-08-09
description: Learn how to build knowledge graph from documents using a four-stage pipeline to improve multi-hop reasoning and entity relationship extraction.
tags: [knowledge-graphs]
---

To build a knowledge graph from documents, run a pipeline with four stages: ingest raw text, extract entities and relationships via NER, merge and deduplicate nodes using primary keys, then query the graph. Use tools like LlamaIndex or CocoIndex for extraction and Neo4j or Memgraph for storage. Balance LLM automation with human disambiguation for production accuracy.

## Why Graphs Beat Vectors for Multi-hop Reasoning

Traditional vector-based RAG approaches struggle with multi-hop reasoning and miss critical context spanning multiple documents. Simple semantic similarity searches often fail to capture nuanced relationships between entities, making structured knowledge graphs a promising solution for complex information. For a deeper comparison, see [GraphRAG vs. Vector RAG: When a Knowledge Graph Beats Top-k](https://gctrl.tech/blog/graphrag-vs-vector-rag).

Legal documents are a compelling use case for knowledge graphs due to their inherent interconnections and complex webs of references. The hierarchical nature of legal info and the need to understand relationships between clauses make structured graphs valuable for retrieval accuracy. In one documented pipeline, [10 pages of contract text served as the input for the LLM classification process](https://neo4j.com/blog/developer/from-legal-documents-to-knowledge-graphs/).

## The Scalability Tipping Point: SQL vs. Graph

A knowledge graph is fundamentally a database where the object of one triple becomes the subject of another, eliminating physical tables. Unlike relational databases that use joins and NULL values, graph databases simply omit relationships when no information is available.

Knowledge graphs scale better than relational databases for highly interconnected data once the number of tables exceeds approximately [thirty tables](https://ontologist.substack.com/p/tips-for-building-knowledge-graphs). Below this threshold, a knowledge graph is likely overkill, but above it, the complexity of managing tables in relational systems becomes a bottleneck.

## Handling Uncertainty: Annotating Triples with Probability

RDF-Star allows annotating a triple with a value indicating the probability that a statement is true. This capability is impossible in relational databases because a column is not implicitly an entity, nor can a triple be treated as an entity.

This distinction matters when building graphs from unstructured documents. LLMs extract facts with varying confidence. Annotating triples with probabilities lets downstream applications filter or weight results, a capability SQL cannot natively replicate.

## Building the Pipeline: Ingest, Extract, Merge, Query

Production-ready pipelines for unstructured data should include [preprocessing, Named Entity Recognition, relationship extraction, and disambiguation](https://memgraph.com/docs/ai-ecosystem/graph-rag/knowledge-graph-creation). This custom approach balances automation with human oversight to ensure the resulting knowledge graph is precise and factually accurate.

Tools like LangChain and LlamaIndex simplify bridging the gap between unstructured data and graph databases like Memgraph. These frameworks assist in transforming text, images, or logs into structured knowledge graphs without requiring a fully custom pipeline from scratch. LlamaCloud provides parsing and extraction capabilities to convert raw documents into structured data for knowledge graphs, working alongside Neo4j as the backbone for graph representation.

Memgraph recommends using [structured data like CSV, JSON, or Cypher as the preferred approach for creating GraphRAG systems](https://memgraph.com/docs/ai-ecosystem/graph-rag/knowledge-graph-creation). Structured data provides the most control over modeling nodes and relationships, eliminating ambiguities found in automated LLM extraction.

The neo4j-labs llm-graph-builder requires [Neo4j Database version 5.23 or later with APOC installed](https://github.com/neo4j-labs/llm-graph-builder). Version 5.23 is mandatory because the backend utilizes Cypher variable-scope subquery syntax unsupported in earlier 5.x releases like 5.20. The application supports input sources including local files, YouTube videos, Wikipedia, AWS S3, and web pages. Local or separate backend deployment requires [Python 3.12](https://github.com/neo4j-labs/llm-graph-builder).

Follow this numbered procedure for a production pipeline:

1. **Ingest**: Connect your data sources and preprocess raw text.
2. **Extract**: Run Named Entity Recognition and relationship extraction.
3. **Merge**: Deduplicate nodes using primary keys like filename or concept name.
4. **Query**: Execute graph traversals for multi-hop reasoning.

For implementation details, consult [the quickstart guide](https://gctrl.tech/docs/quickstart) and [how extraction and fusion work](https://gctrl.tech/docs/modules).

## Incremental Maintenance and Real-time Updates

CocoIndex generates two node labels, Document and Entity, and two relationship types, RELATIONSHIP and MENTION, for its graph schema. The system uses primary keys like filename or concept name to match and deduplicate nodes, ensuring the same concept collapses onto a single node.

The [CocoIndex pipeline runs in two phases](https://cocoindex.io/blogs/knowledge-graph-for-docs/): independent document processing followed by a single pass to declare deduplicated Entity nodes and edges. Because phase 1 runs one component per file, editing a document re-extracts only that specific file, and the graph pass automatically removes unsupported nodes.

This phase-based architecture solves a critical maintenance problem. When source documents change, you avoid reprocessing the entire corpus. Only the modified file triggers re-extraction, and the graph pass cleans up stale nodes automatically.

## Enterprise Governance and Role Management

WRITER's Knowledge Graph feature is supported on Starter and Enterprise plans for [Org admins, IT admins, team admins, and AI Studio builders](https://support.writer.com/articles/6965386512-how-to-create-and-manage-a-knowledge-graph). Team members can use the graphs within agents, while specific admin roles are required to create graphs or upload files.

Users can connect a WRITER Knowledge Graph to [Confluence, Sharepoint, Google Drive, Notion, domains, web pages, or manually uploaded files](https://support.writer.com/articles/6965386512-how-to-create-and-manage-a-knowledge-graph). The system is designed for precision and low latency at enterprise scale, combining intent-driven routing and advanced re-ranking.

Only the creator of a Knowledge Graph in WRITER can add or remove files for data connectors. While other admins can manage graphs generally, this specific permission regarding data connector files is restricted to the original creator.

## Practical Takeaway: Start Structured, Automate Carefully

Structured data provides the most control over modeling nodes and relationships, eliminating ambiguities found in automated LLM extraction. This custom approach balances automation with human oversight to ensure the resulting knowledge graph is precise and factually accurate.

Start with structured inputs where possible. Use LLMs for extraction on unstructured text, but apply human disambiguation before committing triples to the graph. This hybrid approach gives you the scalability of automation without sacrificing factual integrity.

## FAQ

### What is the specific threshold of table complexity where a knowledge graph becomes more efficient than a relational database?

Knowledge graphs scale better than relational databases for highly interconnected data once the number of tables exceeds approximately [thirty tables](https://ontologist.substack.com/p/tips-for-building-knowledge-graphs). Below this threshold, a graph is likely overkill, but above it, relational table management becomes a bottleneck.

### Why is Neo4j version 5.23 specifically required for certain LLM graph builder tools?

The neo4j-labs llm-graph-builder requires [Neo4j version 5.23 or later](https://github.com/neo4j-labs/llm-graph-builder) because the backend uses Cypher variable-scope subquery syntax that is unsupported in earlier 5.x releases like 5.20. APOC must also be installed.

### How do production pipelines for unstructured data differ from simple automated extraction methods?

Production-ready pipelines include [preprocessing, Named Entity Recognition, relationship extraction, and disambiguation](https://memgraph.com/docs/ai-ecosystem/graph-rag/knowledge-graph-creation). This custom approach balances automation with human oversight to ensure the resulting knowledge graph is precise and factually accurate, unlike simple automated extraction.

### What roles and permissions are necessary to create and manage knowledge graphs in an organization?

In WRITER, [Org admins, IT admins, team admins, and AI Studio builders](https://support.writer.com/articles/6965386512-how-to-create-and-manage-a-knowledge-graph) can create graphs. Team members can use graphs within agents. Only the original graph creator can add or remove files for data connectors, while other admins manage graphs generally.

### Can knowledge graphs represent the probability of a statement being true, and how does this compare to SQL?

Yes. RDF-Star allows [annotating a triple with a probability value](https://ontologist.substack.com/p/tips-for-building-knowledge-graphs) indicating the statement is true. This is impossible in relational databases because a column is not implicitly an entity, nor can a triple be treated as an entity.
