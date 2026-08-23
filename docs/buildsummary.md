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

## Codebase KB (P1a)

Index a source repository (symbols, imports, call graph, chunks) into GCTRL as a knowledge base,
usable by agents via MCP/CLI first, product connector + UI later. Indexing runs where the code
lives (`gctrl-code-indexer`, TypeScript, first shared TS package); the server only stores.

CODE compilations are filed under `Users/<name>/Code` automatically when created without an
explicit `folderPath`/`folderId`; existing unfiled ones are moved there on boot.

### IndexBatch wire contract

The one contract the indexer, the endpoints and the worker all implement. Also section 10 of
`docs/superpowers/specs/2026-08-22-codebase-kb-design.md` (a local working document, not
checked in - this copy is the durable one).

```jsonc
// POST /api/kex/code  (ApiKey or JWT auth; body <= 40 MB; indexer sends batches of <= 200 files)
{
  "compilationId": "uuid",                      // REQUIRED. Must be a compilation of type CODE the caller may write.
  "repo": { "name": "borghive", "root": "d:/N8N/Projekte/Databorg/borghive", "commit": "a1b2c3d" },  // commit may be null
  "classificationLevelId": "uuid",             // optional, same semantics as /kex/extract
  "files": [
    {
      "path": "services/kex/src/kg_builder.py", // repo-relative, forward slashes
      "sha256": "hex64",
      "lang": "python",                          // python | typescript | tsx | javascript | rust | go | java | csharp | other
      "symbols": [
        // kind: file | module | class | interface | enum | struct | type | function | method
        // name: fully-qualified entity name = "<path>::<qualname>" (file symbol: name == path; module: dotted import target)
        { "kind": "class",    "name": "services/kex/src/kg_builder.py::KGBuilder",            "line_start": 60, "line_end": 560, "signature": "class KGBuilder", "doc": "Writes graphs.", "exported": true },
        { "kind": "method",   "name": "services/kex/src/kg_builder.py::KGBuilder.build_graph","line_start": 89, "line_end": 234, "signature": "def build_graph(self, job_id, user_id, entities, relations, classification=None, origin=None, source_document_id=None, source_modified_at_ms=None)", "doc": "", "exported": true },
        // stubs for cross-file edge targets NOT in this batch are allowed and expected: same shape, `stub: true`
        { "kind": "function", "name": "services/kex/src/embedding.py::build_embedding_client", "stub": true, "file": "services/kex/src/embedding.py" },
        // every UNRESOLVED import target (external package) is an explicit module symbol - the server never guesses
        { "kind": "module",   "name": "neo4j" }
      ],
      "edges": [
        // type: CONTAINS | IMPORTS | CALLS | INHERITS | IMPLEMENTS ; head/tail are symbol names as above
        { "type": "CONTAINS", "head": "services/kex/src/kg_builder.py", "tail": "services/kex/src/kg_builder.py::KGBuilder", "confidence": 1.0, "resolution": "syntax" },
        { "type": "CALLS",    "head": "services/kex/src/kg_builder.py::KGBuilder.build_graph", "tail": "services/kex/src/kg_builder.py::KGBuilder._write_entities", "confidence": 0.6, "resolution": "heuristic" },
        { "type": "IMPORTS",  "head": "services/kex/src/kg_builder.py", "tail": "neo4j", "confidence": 1.0, "resolution": "syntax" }   // unresolved external -> module node named "neo4j"
      ],
      "chunks": [
        { "symbol": "services/kex/src/kg_builder.py::KGBuilder.build_graph", "content": "services/kex/src/kg_builder.py:L89-L234 def build_graph(...)\n<body, capped 2000 chars>" }
      ]
    }
  ],
  "removed": ["services/kex/src/old_module.py"]   // repo-relative paths whose symbols/chunks must be dropped
}
// Response: { "jobId": "uuid", "status": "pending" }

// GET /api/kex/code/manifest?compilationId=uuid
// Response: { "repo": "borghive", "commit": "a1b2c3d" | null, "files": { "services/kex/src/kg_builder.py": "hex64", ... } }
```

Graph mapping (worker): every symbol becomes an `:Entity` via `KGBuilder.build_graph` with `text=name`, `type=kind`, `coarse_type="code"`, `label=kind`, and `props = {_repo, _file, lang, line_start, line_end, signature, doc, exported, sha256(file only)}`. Every edge gets `props = {_repo, _file: <path of the batch file that owns it>, resolution}`. One extra entity per batch: `{text: repo.name, type: "repo", props: {_repo: repo.name, commit, root, indexed_at}}` plus `CONTAINS repo -> file` for each file.

Identity note: a node's `name` is exactly what the wire carries, but its `uri` is derived from
`<repo.name>::<name>` - without the repo scope, two repos of the same user sharing a path
(`src/index.ts`, `main.py`) collapse onto one node. The read tools match by `name` inside a job
scope, so nothing on the wire changes.

### Endpoints
- `POST /api/kex/code` — body `{compilationId, repo:{name,root,commit}, files:[{path,sha256,lang,symbols[],edges[],chunks[]}], removed:[paths]}`, enqueues an async `kex_code` job, returns `{jobId, status}`.
- `GET /api/kex/code/manifest?compilationId=` — `{repo, commit, files:{path: sha256}}` for incremental diffing.
- `DELETE /api/kex/code/files` — body `{compilationId, repoName, paths}`, enqueues a removal-only `kex_code` job (same worker path, no duplicated purge logic).

### Job type and compilation type
Job type `kex_code`, worked by `services/kex/src/code_job.py`. Compilation type `CODE` (new enum
value alongside RAW/WIKI). `GRAPH_KEEP_TYPES` in `services/kex/src/config.py` now includes `code`
so isolated code symbols survive `GRAPH_PRUNE_ISOLATED`.

### Purge semantics
Per run: purge edges owned by the changed/removed files first (`purge_code_file_edges`), write the
new graph (`KGBuilder.build_graph`), then drop stale symbols by URI set-difference
(`purge_code_symbols`, keep-set = symbols the new write actually produced for that file), then
delete stale chunks by `source_document_id` (`delete_chunks_by_source`). Node deletion is by URI
set-difference after the write (not a blanket delete-before-write), so incoming edges from
unchanged files that still call into a changed file are never severed mid-run.

### Agent tools
Read tools in `services/api-rs/src/routes/code_tools.rs`, exposed through the HTTP agent gateway
(so Hermes/Anvil get them without a local index): `code_symbol`, `code_trace`, `code_impact`,
`code_architecture` — same clearance-rank + KB-grant scoping as `get_neighbors`, read-only tokens
allowed, no ad-hoc Cypher accepted from the caller. Indexing itself is local-only: MCP tool
`gctrl_code_index` (stdio, direct mode), CLI `gctrl code index|status`, Anvil sandbox stdio entry
`gctrl-code`. `GCTRL_MCP_TOOLS=code` filters an MCP server instance to just the code tools.

### Token capability `codeAccess`

Codebase access is a per-access-token capability (`api_keys.code_access`, migration 078,
restated in 079 and 080, default `true` so nothing changes for existing tokens). Switching it off in
**Settings -> Access Control** takes everything code-related away from that one token: code
tools, CODE knowledge-base visibility (lists, grants, explicit ids, graph/chunk reads), code
writes and CODE-KB mutations. Concretely:

- **Code tools** - the four `code_*` tools are refused by `agent::execute_tool`, and hidden from
  both discovery surfaces by the shared `agent::visible_tool_schema` (`GET /api/agent/tools` and
  the MCP gateway's `tools/list`).
- **Visibility** - CODE compilations drop out of the token's grant set, out of
  `/kg/compilations` and the agent's `list_graphs` (excluded in SQL, so a page is never
  shortened), and an explicit `GET /kg/compilations/{id}` of a code graph returns **404** - the
  access rank is now computed unconditionally, so a denied graph is indistinguishable from one
  that does not exist.
- **Reads** - every path that returns source TEXT drops CODE-origin material: the agent
  `search_chunks` and `query` tools, the REST `POST /api/rag/query` (filtered right after
  retrieval, so a code passage never even grounds the answer, let alone gets cited), and
  `GET /api/kex/chunks` (excluded in SQL, so the paging `total` stays honest). A chunk counts as
  code when its compilation - or, for the NULL-compilation majority, the job that produced it -
  belongs to a CODE graph (`agent::code_chunk_scope`).
- **Writes** - `POST /api/kex/code` and `DELETE /api/kex/code/files` return 403, and so does
  every other change to a CODE knowledge base: create / update / delete / refresh / distill /
  schedule, ACL (`PUT /kg/compilations/:id/acl`), community detection, wiki sources, privacy
  mode, node and relationship edits (REST `DELETE /api/kg/node` + `/relationship` and their
  agent tool arms - all gated once at `kg::resolve_mutation_scope`), `delete_chunk`, and
  ingesting into one (`POST /api/kex/extract` with an explicit CODE `compilationId` → 403;
  `store` / `ingest_file` refuse, and every other ingest path leaves the job unlinked rather
  than writing into a code graph). All via `kg::enforce_code_capability`.
- **Source-level invariant tests** - `routes::kg::code_capability_source_invariants` reads the
  handler bodies and fails if one of those call sites disappears (a DB-backed test would need a
  live Postgres; this is the cheap guard against a silent regression).

**Full-owner (unscoped) tokens** with the flag off are additionally narrowed to *job-scoped*
reads of their non-code knowledge bases: `kg::api_key_scoped_jobs` returns the source jobs of
the owner's non-CODE compilations, which switches `node_auth_clause` off ownership and onto job
scope, so code nodes vanish from `search_entities` / `get_entity` / `get_neighbors` /
`shortest_path` / `schema`. Because job scope is a positive allow-list, an orphan node (in no
compilation at all) is invisible to such a token too - the conservative direction.

The flag rides on `JwtClaims.code_access` (always `true` for JWT sessions), is set at creation
via `{"codeAccess": false}` and toggled afterwards with `PUT /users/api-keys/:id`. Covered end to
end by the `code_kb` release check, for both KB-scoped and unscoped tokens.

### Measured numbers (dogfood: borghive indexing itself, 2026-08-23)
- 464 files (Python/TypeScript/Rust) → 7134 symbols, 9080 edges, 3726 chunks.
- Incremental re-run, no changes: 0/464 files uploaded.
- Full run wall time: ~2-4 min on the dev box (embeddings dominate).
- Edge precision (gauntlet): CALLS precision 100% on 1119 scored edges, 0 incorrect - 1031/1031
  TS/JS edges against a TypeScript-compiler oracle plus 88 Python/Rust/module-level edges against
  an LLM judge (no compiler oracle wired up for those). By tier: 1114/1114 at `confidence 0.6,
  resolution: heuristic` (resolved within file/module scope, import-aware); 5/5 Python at
  `confidence 0.4, resolution: heuristic` (repo-wide unique bare name, guarded - length,
  stop-list, same language family, external-import and local-shadow blocks; same guarded tier the
  INHERITS/IMPLEMENTS fallback uses).
- Module-level (file-head) CALLS edges are scored only for true top-level calls (65 in borghive);
  25/25 judged correct.
- Token efficiency vs. grep-style exploration over 5 structural questions: 95.6% overall
  (85.8%-99.9% per question).

### CI
`test-code-indexer` (typecheck + unit tests + build for `packages/code-indexer`) and
`typecheck-mcp` (build the indexer, typecheck the MCP server against it) added to
`.github/workflows/ci.yml`.

### Symbol identity
A code node's `uri` is derived from `<repo>::<name>` (`uri_scope` on the entity dict,
applied by `kg_builder._scoped_name`), so two repos of the same user indexed into two CODE
KBs never share a node for a path they have in common. The node's `name` property stays
unscoped - `code_symbol` / `code_trace` match plain names inside their job scope.

### Follow-ups (P1b / P2)
See `tasks/todo.md` under "Codebase KB follow-ups" for the full list (LSP pass, `gctrl_code_changes`,
GitHub/GitLab connector, Brain UI, package publish order). Deferred from the P1a final review, none
of them correctness bugs: relationship property index / file-anchored purge for
`purge_code_file_edges`; a per-compilation long-lived job id (or `_source_jobs` compaction) so the
list stops growing per incremental run; manifest filter by repo; module nodes (unresolved external
imports) are never purged because they carry no `_file`; `list_jobs` has no `kex_code` type filter;
case-folded uris merge `Foo.ts` with `foo.ts`; and the indexer minors (warn on
`tree.rootNode.hasError`, the double file read, object-literal methods, a CLI CI job, `repo.root`
being an absolute host path, self-recursive CALLS edges dropped by the `head !== tail` guard).
