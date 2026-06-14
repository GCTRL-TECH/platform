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
Ground Control exposes an MCP server for AI tool integration.

Tools: `gctrl_extract`, `gctrl_query`, `gctrl_store`, `gctrl_fuse`, `gctrl_search_entities`, `gctrl_list_graphs`, `gctrl_list_ontologies`, `gctrl_list_extractions`, `gctrl_schema`.

> **Deprecated names (alias, removal in v2):** the legacy `borghive_*` names
> (e.g. `borghive_extract`) are still accepted by the server for backwards
> compatibility with existing `.mcp.json` configs, but invocations log a
> warning and will be removed in v2.0. Migrate to the `gctrl_*` names.

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

---

## Enterprise Feature Push (June 2026)

### New Source Connectors
- **Microsoft SharePoint** (multi-tenant): OAuth via Azure AD client_credentials, site/library/file picker UI
- **Obsidian Vault**: REST API integration with loopback-only SSRF guard, note picker with wikilink stripping
- `sharepoint_handler.py`, `obsidian_handler.py` added to KEX worker

### Real-Time Token Balance
- Billing endpoint now subtracts unsynced `token_usage` rows (not yet heartbeat-synced) from balance inline
- Balance is accurate within milliseconds, not 60s heartbeat intervals

### ISO 27001 Data Classification
- `classification_levels` table replaces hardcoded enum — system levels + user-custom levels
- 4 system levels: PUBLIC(0), INTERNAL(100), CONFIDENTIAL(200), STRICTLY_CONFIDENTIAL(300)
- All compilation/entity queries clearance-filtered: `WHERE cl.rank <= user_clearance_rank`
- Auto-classifier via Ollama suggests classification when not specified

### API Keys with Clearance Scoping
- `ApiKey <raw>` auth path alongside JWT Bearer
- `max_clearance_rank` on each key — physically caps data visibility at middleware
- Use case: give untrusted automation a `max_clearance_rank=0` key, it can ONLY see PUBLIC data

### PII Detection
- `presidio-analyzer` scans extracted text pre-NER
- Detects: PERSON, EMAIL, PHONE, IBAN, NRP (German ID), LOCATION
- Only type+count in DB (no actual values — GDPR)
- PII shield badge on job detail page with one-click re-ingest with redaction

### Pi Console Agent
- Floating SSE-streaming agent panel (bottom-right FAB)
- `POST /api/agent/chat` — Ollama, streamed tokens via Server-Sent Events
- GCTRL tools: list_graphs, search_entities, check_balance, list_sources
- Also accessible as `gctrl agent` interactive REPL in CLI

### Data Lineage
- `GET /api/kg/compilations/:id/lineage` — SVG DAG of jobs → compilation
- `GET /api/graph/entity/:name/lineage` — entity → compilations provenance
- `LineagePage.tsx` with inline SVG renderer (no third-party graph lib dependency)

### Retention Policies
- `retention_policies` table with per-classification-level rules
- PL/pgSQL trigger auto-sets `expires_at` on compilation classification assignment
- Nightly background task: deletes expired Neo4j nodes + Postgres records, writes audit log
- Admin can set user-specific overrides per level via `PUT /api/classification/levels/:id/retention`

### Enterprise SSO / SCIM
- OIDC: authorize + callback endpoints for Okta, Azure AD, Keycloak, Google Workspace
- SCIM v2: full `GET/POST/PUT/PATCH/DELETE /api/scim/v2/Users` for automated provisioning
- `sso_configs` table + `scim_tokens` table with SHA-256 hashed bearer tokens

### Webhooks
- CRUD: `GET/POST/PUT/DELETE /api/webhooks`
- HMAC-SHA256 signed delivery (`X-GCTRL-Signature: sha256=...`)
- Auto-disable after 3 consecutive delivery failures
- Fires on: `job.completed` (more events can be added)
- Delivery history: `GET /api/webhooks/:id/deliveries`

### KG Export Standards
- `GET /api/kg/compilations/:id/export?format=jsonld` — JSON-LD
- `?format=rdf-turtle` — Turtle/RDF
- `?format=graphml` — GraphML
- Clearance-gated: can only export compilations you have clearance for

### CLI — `gctrl`
```bash
gctrl auth login|status|logout
gctrl kex extract --file|--url|--text [--classification INTERNAL] [--wait]
gctrl kex jobs
gctrl graph list|get
gctrl source list
gctrl classify levels|set
gctrl agent         # interactive REPL
```
Authentication: `ApiKey` header, key stored in `~/.gctrl/config.json`

### Migrations Added
`021` — job type constraint expansion  
`022` — SharePoint multi-tenant config  
`023` — Obsidian vault connections  
`024` — classification levels table (replaces enum)  
`025` — enhanced audit log  
`026` — API key clearance scoping  
`027` — PII findings table  
`028` — retention policies + auto-expiry trigger  
`029` — SSO configs + SCIM tokens  
`030` — webhooks + webhook deliveries
