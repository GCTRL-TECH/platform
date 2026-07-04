// Structured data (JSON-LD) shared by the landing page. Kept factual and
// distilled from the docs so both Google rich results and LLM crawlers can
// quote it directly. See src/components/Seo.tsx for how this is rendered.

import { SITE_URL } from '@/components/Seo'

export const organizationJsonLd = {
  '@context': 'https://schema.org',
  '@type': 'Organization',
  name: 'GCTRL',
  alternateName: 'Ground Control',
  url: SITE_URL,
  logo: `${SITE_URL}/gctrl/icon-color.svg`,
  description:
    'GCTRL (Ground Control) is the enterprise memory layer for AI — a self-hosted knowledge graph and governed memory tier that any agent framework can use as durable, access-controlled shared memory.',
}

export const softwareApplicationJsonLd = {
  '@context': 'https://schema.org',
  '@type': 'SoftwareApplication',
  name: 'GCTRL',
  applicationCategory: 'BusinessApplication',
  applicationSubCategory: 'DeveloperApplication',
  operatingSystem: 'Linux, macOS, Windows (Docker)',
  description:
    'Self-hosted knowledge graph and governed memory layer for AI agents. Ingests unstructured data (KEX), fuses it into one clean graph (FUSE), enforces classification-based access control, and serves it to every agent framework over MCP or HTTP — fully on-prem, with local inference and no per-token cost.',
  offers: {
    '@type': 'Offer',
    price: '0',
    priceCurrency: 'USD',
    description: 'Free forever for non-commercial private use.',
  },
  url: SITE_URL,
}

export const faqJsonLd = {
  '@context': 'https://schema.org',
  '@type': 'FAQPage',
  mainEntity: [
    {
      '@type': 'Question',
      name: 'What is an enterprise memory layer?',
      acceptedAnswer: {
        '@type': 'Answer',
        text:
          'An enterprise memory layer is the missing tier between raw organizational data and AI agents: it ingests documents and data once, resolves them into one governed knowledge graph, and serves that graph to every agent and tool as durable, access-controlled memory — instead of each tool rebuilding its own understanding from scratch.',
      },
    },
    {
      '@type': 'Question',
      name: 'Does GCTRL run fully on-prem?',
      acceptedAnswer: {
        '@type': 'Answer',
        text:
          'Yes. Every component — the graph store (Neo4j), vector index (Qdrant), relational store (Postgres), job queue (Redis), and inference itself via local Ollama — runs on infrastructure you control. Nothing is required to touch a third party server, and deployments can go fully air-gapped.',
      },
    },
    {
      '@type': 'Question',
      name: 'Can multiple AI agents share the same memory in GCTRL?',
      acceptedAnswer: {
        '@type': 'Answer',
        text:
          'Yes. GCTRL exposes a Multi-Agent Fabric over MCP and HTTP, so coding agents (Claude Code, Cursor, Codex), agent frameworks (LangChain, LlamaIndex), and automations (n8n) all read and write to the same governed knowledge graph — what one agent learns is already there when the next one asks.',
      },
    },
    {
      '@type': 'Question',
      name: 'Is my data sent to cloud models when I use GCTRL?',
      acceptedAnswer: {
        '@type': 'Answer',
        text:
          'Not by default. With local Ollama inference, prompts, documents, graph content, and answers all stay inside your network — there is no external API in the data path and no per-token cost. Cloud models are opt-in per graph via Cloaking, which lets you use frontier cloud models without exposing real identities.',
      },
    },
    {
      '@type': 'Question',
      name: 'What is the difference between GCTRL and a vector database or RAG script?',
      acceptedAnswer: {
        '@type': 'Answer',
        text:
          'A vector database or one-off RAG script answers a single project. GCTRL ingests at scale (KEX), resolves duplicates and conflicts into one clean graph (FUSE), enforces classification on every read, and keeps that memory compounding across every agent and project — the same way a company runs one shared database instead of every application keeping its own copy of the truth.',
      },
    },
    {
      '@type': 'Question',
      name: 'How does GCTRL handle access control and data classification?',
      acceptedAnswer: {
        '@type': 'Answer',
        text:
          'Classification is enforced at the graph level, not bolted on afterwards. Every entity and relation carries a clearance level, scoped tokens grant agents access to only the knowledge bases they need, and access is checked on every read — built for TISAX and ISO 27001-aware enterprise environments.',
      },
    },
    {
      '@type': 'Question',
      name: 'What does KEX and FUSE mean?',
      acceptedAnswer: {
        '@type': 'Answer',
        text:
          'KEX (Knowledge Extraction) turns unstructured documents into structured entities and relations, locally and fast. FUSE (Knowledge Fusion) merges those extractions and resolves duplicate or conflicting entities into one coherent knowledge graph, with zero training required.',
      },
    },
    {
      '@type': 'Question',
      name: 'Is GCTRL free to use?',
      acceptedAnswer: {
        '@type': 'Answer',
        text:
          'Yes, GCTRL is free forever for non-commercial private use, including all four modules (KEX, FUSE, Knowledge Graphs, Talk-to-Graph) fully self-hosted with local inference. Commercial team and enterprise tiers are available for organizations that need licensed use, team access control, or sovereign/air-gapped deployment.',
      },
    },
  ],
}

export const landingJsonLd = [organizationJsonLd, softwareApplicationJsonLd, faqJsonLd]
