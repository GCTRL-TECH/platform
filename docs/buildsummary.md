# Ground Control - Build Summary

## What is Ground Control?

Ground Control is a structured data platform for AI. Drop any data, get knowledge graphs. Fuse them into high-quality sources. Talk to them with GDPR-compliant RAG. All no-code, all visual, all enterprise-ready.

**Tagline**: "Drop any data. Get structured knowledge."

## Architecture

```
Frontend (React 18 + TypeScript + Tailwind + shadcn/ui) — port 3001
    ↓
API Server (Node.js + Express + TypeScript) — port 4000
    ↓
┌─────────────────────────────────────────────────┐
│  Access Control Layer (classification-based ACL) │
└─────────────────────────────────────────────────┘
    ↓                    ↓                    ↓
Neo4j (graphs)     PostgreSQL (users)    Redis (queues)
port 7474/7687     port 5433             port 6380
    ↓                                        ↓
Qdrant (vectors)   Ollama (LLM)         KEX Worker (Python)
port 6333          port 11434           port 4010
                                             ↓
                                        FUSE Worker (LIMES)
                                        port 4020
```

## Modules

### 1. KEX - Knowledge Extraction
Upload any document (PDF, DOCX, CSV, JSON, XML, HTML, plain text, URLs) and extract structured knowledge. Pipeline: NER (multilingual BERT) → Relation Extraction (Ollama) → Entity Linking → KG Construction in Neo4j + vector embeddings in Qdrant.

### 2. FUSE - Knowledge Fusion
Merge multiple knowledge graphs into one unified graph. Uses LIMES framework for entity matching, deduplication, and link discovery. Configurable similarity thresholds with human-in-the-loop review.

### 3. Manage KGs
Manage knowledge compilations with versioning, cron-based refresh scheduling, and classification-based access control (PUBLIC, INTERNAL, CONFIDENTIAL, RESTRICTED).

### 4. Talk to Graph (RAG)
Chat with your knowledge graphs. Hybrid RAG combining graph traversal, vector search, and web search. GDPR-compliant: conversations in browser memory only, no server-side persistence. Multi-model: Ollama (local), OpenAI, Anthropic, OpenRouter.

## How to Run

### Prerequisites
- Docker and Docker Compose
- 8GB+ RAM recommended

### Start
```bash
cd borghive
docker compose up -d
```

### Access
- **Frontend**: http://localhost:3001
- **API**: http://localhost:4000
- **Neo4j Browser**: http://localhost:7474 (neo4j/password)

### Default Credentials
- Admin: admin@gctrl.tech / GCTRL_admin_change_me_now (dev only)
- Test user: test@gctrl.test

### Environment Variables (Optional)
```bash
# OAuth Connectors
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
MICROSOFT_CLIENT_ID=...
MICROSOFT_CLIENT_SECRET=...
SLACK_CLIENT_ID=...
SLACK_CLIENT_SECRET=...

# LLM API Keys (set in Settings > Models)
# OpenAI, Anthropic, OpenRouter keys stored in browser localStorage
```

## API Endpoints

### Authentication
- `POST /api/auth/register` — Register
- `POST /api/auth/login` — Login (returns JWT)
- `POST /api/auth/refresh` — Refresh token
- `POST /api/auth/forgot-password` — Password reset

### Knowledge Extraction (KEX)
- `POST /api/kex/extract` — Submit text for extraction
- `POST /api/kex/upload` — Upload file
- `GET /api/kex/jobs` — List jobs
- `GET /api/kex/jobs/:id` — Job status

### Knowledge Fusion (FUSE)
- `POST /api/fuse/merge` — Start merge
- `GET /api/fuse/jobs` — List fusion jobs

### Knowledge Graphs
- `GET /api/kg/compilations` — List graphs
- `POST /api/kg/compilations` — Create
- `POST /api/kg/compilations/:id/refresh` — Refresh
- `PUT /api/kg/compilations/:id/schedule` — Set cron

### RAG (Talk to Graph)
- `POST /api/rag/query` — Ask question

### Connectors
- `GET /api/connectors` — List connected accounts
- `GET /api/connectors/auth/:provider` — Start OAuth
- `POST /api/connectors/google/drive/sync` — Sync Drive files
- `POST /api/connectors/google/gmail/sync` — Sync Gmail
- `POST /api/connectors/google/calendar/sync` — Sync Calendar
- `POST /api/connectors/microsoft/onedrive/sync` — Sync OneDrive
- `POST /api/connectors/microsoft/outlook/sync` — Sync Outlook
- `POST /api/connectors/slack/sync` — Sync Slack

### Billing
- `GET /api/billing/balance` — Token balance
- `GET /api/billing/usage` — Usage history
- `GET /api/billing/usage/summary` — Usage by action/day

### Admin (admin role required)
- `GET /api/admin/stats` — System stats
- `GET /api/admin/users` — User list
- `PUT /api/admin/users/:id/role` — Update role
- `GET /api/admin/audit` — Audit log

### MCP Server
Ground Control exposes an MCP server for AI tool integration. Tools: borghive_extract, borghive_query, borghive_store, borghive_fuse, borghive_search_entities, borghive_list_graphs, borghive_list_ontologies, borghive_list_extractions, borghive_schema.

## n8n Community Node
Package: `n8n-nodes-gctrl` (at borghive/n8n-nodes-gctrl/)
- Ground Control node (all operations)
- Ground Control Trigger (job completion polling)
- Ground Control Memory (AI Agent persistent memory)
- Ground Control Knowledge Tool (AI Agent KG query)

## Tech Stack
| Layer | Technology |
|-------|-----------|
| Frontend | React 18 + TypeScript + Tailwind CSS + shadcn/ui |
| API | Node.js + Express + TypeScript |
| Auth | JWT + bcrypt + refresh tokens |
| Databases | PostgreSQL (users) + Neo4j (graphs) + Redis (queues) + Qdrant (vectors) |
| KEX Engine | Python 3.11 + Transformers + Ollama |
| FUSE Engine | Java 17 + Maven (LIMES) + Python wrapper |
| RAG | Hybrid (graph + vector + web) + Ollama/OpenAI/Anthropic |
| MCP | TypeScript + @modelcontextprotocol/sdk |
| Container | Docker + docker-compose |

## Security
- GDPR/DSGVO: RAG conversations browser-only, no server storage
- ISO 27001: Audit trail, encrypted tokens, RBAC
- TISAX Level 3: Classification-based ACL at node level
- OWASP: JWT, rate limiting, input validation, CORS

## Key Decisions
- Classification-based ACL over traditional RBAC (TISAX requirement)
- Simple Redis LPUSH/BLPOP over BullMQ (cross-language Python/Node.js)
- Base64 file encoding through Redis (Docker cross-container)
- Port offsets from Hasura (5433, 6380, 3001)
- Browser-only RAG sessions (GDPR by design)
