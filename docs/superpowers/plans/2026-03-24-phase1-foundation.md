# GCTRL Phase 1: Foundation (KEX + Auth) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the GCTRL platform foundation - Docker infrastructure, Express API with JWT auth, KEX extraction service with Neo4j persistence, and React frontend with auth pages and KEX upload UI.

**Architecture:** Microservice architecture with 5 Docker services: Express API (gateway + auth + routing), Python KEX worker (NER + RelEx + KG builder), React SPA frontend, PostgreSQL (users/jobs/tokens), Neo4j (knowledge graphs). Redis for job queues. Services communicate via internal Docker network. Frontend talks to API only. API dispatches async jobs to KEX worker via Redis queue.

**Tech Stack:** Node.js 20 + Express + TypeScript (API), Python 3.11 + FastAPI (KEX), React 18 + TypeScript + Vite + Tailwind + shadcn/ui (Frontend), PostgreSQL 16, Neo4j 2026.02, Redis 7, Docker Compose

---

## File Structure

```
GCTRL/
  docker-compose.yml              # All services
  .env.example                    # Environment template
  .env                            # Local environment (gitignored)
  services/
    api/                          # Express REST API
      Dockerfile
      package.json
      tsconfig.json
      src/
        index.ts                  # Entry point, Express app setup
        config.ts                 # Environment config loader
        routes/
          auth.ts                 # Register, login, refresh, forgot/reset password
          kex.ts                  # KEX job submission and status
          users.ts                # User profile, list users (admin)
          keys.ts                 # API key CRUD
        middleware/
          auth.ts                 # JWT verification middleware
          acl.ts                  # Classification-based access filter
          validate.ts             # Zod-based input validation
          rateLimit.ts            # Express rate limiting
          tokenMeter.ts           # Token deduction middleware
        models/
          db.ts                   # PostgreSQL connection (pg + Drizzle ORM)
          schema.ts               # Drizzle schema definitions (all tables)
        services/
          neo4j.ts                # Neo4j driver + query helpers
          queue.ts                # BullMQ Redis job queue
          mail.ts                 # Nodemailer for MailDev
    web/                          # React Frontend
      Dockerfile
      package.json
      tsconfig.json
      vite.config.ts
      tailwind.config.ts
      postcss.config.js
      index.html
      src/
        main.tsx                  # React entry
        App.tsx                   # Router + layout
        components/
          ui/                     # shadcn/ui components (button, input, card, etc.)
          layout/
            Sidebar.tsx           # App sidebar navigation
            Header.tsx            # Top bar with user menu
            AppShell.tsx          # Main layout wrapper
        pages/
          auth/
            LoginPage.tsx
            RegisterPage.tsx
            ForgotPasswordPage.tsx
            ResetPasswordPage.tsx
          kex/
            KexPage.tsx           # Upload zone + job list
            KexJobDetail.tsx      # Job status + results viewer
          DashboardPage.tsx       # Landing page after login
        hooks/
          useAuth.ts              # Auth state management
          useApi.ts               # API client hook
        lib/
          api.ts                  # Axios-based API client
          auth.ts                 # JWT storage, refresh logic
        styles/
          globals.css             # Tailwind base + custom vars
    kex/                          # Python KEX Worker
      Dockerfile
      requirements.txt
      src/
        main.py                   # FastAPI + BullMQ consumer
        ner.py                    # NER pipeline (BERT multilingual)
        relex.py                  # Relation extraction (Ollama)
        kg_builder.py             # Neo4j graph writer
        sources/
          file_handler.py         # PDF, DOCX, CSV, JSON, XML, TXT extraction
          url_handler.py          # URL scraping (trafilatura)
        config.py                 # Environment config
  shared/
    db/
      migrations/
        001_users.sql             # Users table
        002_api_keys.sql          # API keys table
        003_jobs.sql              # Extraction jobs table
        004_token_usage.sql       # Token usage tracking
        005_audit_log.sql         # Audit trail
    neo4j/
      init/
        constraints.cypher        # Neo4j uniqueness constraints + indexes
  tests/
    report.md                     # Test results placeholder
```

---

## Task 1: Docker Infrastructure

**Files:**
- Create: `GCTRL/docker-compose.yml`
- Create: `GCTRL/.env.example`
- Create: `GCTRL/.env`
- Create: `GCTRL/.gitignore`

- [ ] **Step 1: Create docker-compose.yml with all Phase 1 services**

```yaml
version: "3.8"

services:
  api:
    build: ./services/api
    container_name: GCTRL-api
    ports:
      - "4000:4000"
    environment:
      - NODE_ENV=development
      - PORT=4000
      - DATABASE_URL=postgresql://GCTRL:GCTRL@postgres:5432/GCTRL
      - REDIS_URL=redis://redis:6379
      - NEO4J_URI=bolt://neo4j:7687
      - NEO4J_USER=neo4j
      - NEO4J_PASSWORD=password
      - JWT_SECRET=${JWT_SECRET}
      - JWT_REFRESH_SECRET=${JWT_REFRESH_SECRET}
      - MAIL_HOST=maildev
      - MAIL_PORT=1025
      - FRONTEND_URL=http://localhost:3000
      - KEX_WORKER_URL=http://kex:4010
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_started
    networks:
      - GCTRL
      - ollama-net
    restart: unless-stopped

  web:
    build: ./services/web
    container_name: GCTRL-web
    ports:
      - "3000:80"
    depends_on:
      - api
    networks:
      - GCTRL
    restart: unless-stopped

  kex:
    build: ./services/kex
    container_name: GCTRL-kex
    ports:
      - "4010:4010"
    environment:
      - OLLAMA_BASE=http://ollama:11434
      - NEO4J_URI=bolt://neo4j:7687
      - NEO4J_USER=neo4j
      - NEO4J_PASSWORD=password
      - REDIS_URL=redis://redis:6379
      - PORT=4010
    volumes:
      - kex-models:/app/models
    depends_on:
      redis:
        condition: service_started
    networks:
      - GCTRL
      - ollama-net
    restart: unless-stopped

  postgres:
    image: postgres:16-alpine
    container_name: GCTRL-postgres
    ports:
      - "5433:5432"
    environment:
      - POSTGRES_USER=GCTRL
      - POSTGRES_PASSWORD=GCTRL
      - POSTGRES_DB=GCTRL
    volumes:
      - GCTRL-pgdata:/var/lib/postgresql/data
      - ./shared/db/migrations:/docker-entrypoint-initdb.d
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U GCTRL"]
      interval: 5s
      timeout: 5s
      retries: 5
    networks:
      - GCTRL
    restart: unless-stopped

  redis:
    image: redis:7-alpine
    container_name: GCTRL-redis
    ports:
      - "6380:6379"
    networks:
      - GCTRL
    restart: unless-stopped

  maildev:
    image: maildev/maildev
    container_name: GCTRL-maildev
    ports:
      - "1081:1080"
      - "1026:1025"
    networks:
      - GCTRL
    restart: unless-stopped

volumes:
  GCTRL-pgdata:
  kex-models:

networks:
  GCTRL:
    driver: bridge
  ollama-net:
    external: true
    name: self-hosted-ai-starter-kit_demo
```

Note: Uses port 5433/6380/1081/1026 to avoid conflicts with existing Hasura services on 5432/6379/1080/1025. Neo4j and Ollama are external (already running).

- [ ] **Step 2: Create .env.example and .env**

```env
JWT_SECRET=GCTRL-dev-jwt-secret-change-in-production
JWT_REFRESH_SECRET=GCTRL-dev-refresh-secret-change-in-production
```

- [ ] **Step 3: Create .gitignore**

```
node_modules/
.env
dist/
__pycache__/
*.pyc
.venv/
```

- [ ] **Step 4: Verify docker-compose config parses**

Run: `cd d:/N8N/Projekte/Databorg/GCTRL && docker compose config --quiet`
Expected: No errors

---

## Task 2: PostgreSQL Migrations

**Files:**
- Create: `GCTRL/shared/db/migrations/001_users.sql`
- Create: `GCTRL/shared/db/migrations/002_api_keys.sql`
- Create: `GCTRL/shared/db/migrations/003_jobs.sql`
- Create: `GCTRL/shared/db/migrations/004_token_usage.sql`
- Create: `GCTRL/shared/db/migrations/005_audit_log.sql`

- [ ] **Step 1: Create users migration**

```sql
-- 001_users.sql
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TYPE user_role AS ENUM ('viewer', 'analyst', 'editor', 'admin');
CREATE TYPE user_clearance AS ENUM ('PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED');

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  name VARCHAR(255) NOT NULL,
  role user_role NOT NULL DEFAULT 'viewer',
  clearance user_clearance NOT NULL DEFAULT 'PUBLIC',
  email_verified BOOLEAN NOT NULL DEFAULT false,
  verification_token VARCHAR(255),
  reset_token VARCHAR(255),
  reset_token_expires TIMESTAMPTZ,
  tokens_balance INTEGER NOT NULL DEFAULT 50,
  tier VARCHAR(50) NOT NULL DEFAULT 'free',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_users_email ON users(email);
```

- [ ] **Step 2: Create api_keys migration**

```sql
-- 002_api_keys.sql
CREATE TABLE api_keys (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key_hash VARCHAR(255) NOT NULL,
  name VARCHAR(255) NOT NULL DEFAULT 'Default',
  scopes TEXT[] DEFAULT '{}',
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_api_keys_user ON api_keys(user_id);
CREATE INDEX idx_api_keys_hash ON api_keys(key_hash);
```

- [ ] **Step 3: Create jobs migration**

```sql
-- 003_jobs.sql
CREATE TYPE job_type AS ENUM ('kex_extract', 'kex_upload', 'fuse_merge');
CREATE TYPE job_status AS ENUM ('pending', 'processing', 'completed', 'failed');

CREATE TABLE jobs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type job_type NOT NULL,
  status job_status NOT NULL DEFAULT 'pending',
  input JSONB NOT NULL DEFAULT '{}',
  result JSONB,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX idx_jobs_user ON jobs(user_id);
CREATE INDEX idx_jobs_status ON jobs(status);
```

- [ ] **Step 4: Create token_usage migration**

```sql
-- 004_token_usage.sql
CREATE TABLE token_usage (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action VARCHAR(100) NOT NULL,
  tokens_spent INTEGER NOT NULL,
  job_id UUID REFERENCES jobs(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_token_usage_user ON token_usage(user_id);
CREATE INDEX idx_token_usage_created ON token_usage(created_at);
```

- [ ] **Step 5: Create audit_log migration**

```sql
-- 005_audit_log.sql
CREATE TABLE audit_log (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id),
  action VARCHAR(100) NOT NULL,
  resource_type VARCHAR(100),
  resource_id VARCHAR(255),
  details JSONB DEFAULT '{}',
  ip_address INET,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_audit_user ON audit_log(user_id);
CREATE INDEX idx_audit_created ON audit_log(created_at);
CREATE INDEX idx_audit_resource ON audit_log(resource_type, resource_id);
```

---

## Task 3: Neo4j Constraints

**Files:**
- Create: `GCTRL/shared/neo4j/init/constraints.cypher`

- [ ] **Step 1: Create Neo4j constraints and indexes**

```cypher
// Entity uniqueness constraint
CREATE CONSTRAINT entity_uri IF NOT EXISTS FOR (e:Entity) REQUIRE e.uri IS UNIQUE;

// Entity indexes for common queries
CREATE INDEX entity_name IF NOT EXISTS FOR (e:Entity) ON (e.name);
CREATE INDEX entity_type IF NOT EXISTS FOR (e:Entity) ON (e.type);
CREATE INDEX entity_classification IF NOT EXISTS FOR (e:Entity) ON (e._classification);
CREATE INDEX entity_owner IF NOT EXISTS FOR (e:Entity) ON (e._owner);
CREATE INDEX entity_source_job IF NOT EXISTS FOR (e:Entity) ON (e._source_job);

// Compilation node
CREATE CONSTRAINT compilation_id IF NOT EXISTS FOR (c:Compilation) REQUIRE c.compilation_id IS UNIQUE;
```

- [ ] **Step 2: Apply constraints to running Neo4j**

Run: `cat GCTRL/shared/neo4j/init/constraints.cypher | docker exec -i neo4j cypher-shell -u neo4j -p password`
Expected: Constraints created (or already exist)

---

## Task 4: Express API Service

**Files:**
- Create: `GCTRL/services/api/Dockerfile`
- Create: `GCTRL/services/api/package.json`
- Create: `GCTRL/services/api/tsconfig.json`
- Create: `GCTRL/services/api/src/index.ts`
- Create: `GCTRL/services/api/src/config.ts`
- Create: `GCTRL/services/api/src/models/db.ts`
- Create: `GCTRL/services/api/src/models/schema.ts`
- Create: `GCTRL/services/api/src/middleware/auth.ts`
- Create: `GCTRL/services/api/src/middleware/validate.ts`
- Create: `GCTRL/services/api/src/middleware/rateLimit.ts`
- Create: `GCTRL/services/api/src/middleware/tokenMeter.ts`
- Create: `GCTRL/services/api/src/middleware/acl.ts`
- Create: `GCTRL/services/api/src/services/neo4j.ts`
- Create: `GCTRL/services/api/src/services/queue.ts`
- Create: `GCTRL/services/api/src/services/mail.ts`
- Create: `GCTRL/services/api/src/routes/auth.ts`
- Create: `GCTRL/services/api/src/routes/kex.ts`
- Create: `GCTRL/services/api/src/routes/users.ts`
- Create: `GCTRL/services/api/src/routes/keys.ts`

### Sub-tasks:

- [ ] **4.1: Create Dockerfile**

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build
EXPOSE 4000
CMD ["node", "dist/index.js"]
```

- [ ] **4.2: Create package.json with dependencies**

Key deps: express, cors, helmet, jsonwebtoken, bcryptjs, pg, drizzle-orm, bullmq, nodemailer, zod, express-rate-limit, uuid, dotenv
Dev deps: typescript, @types/*, tsx, drizzle-kit

- [ ] **4.3: Create tsconfig.json**

Target: ES2022, Module: Node16, outDir: dist, strict: true

- [ ] **4.4: Create config.ts - centralized env config**

Load all env vars with defaults, export typed config object.

- [ ] **4.5: Create models/schema.ts - Drizzle ORM schema**

Define all tables matching the SQL migrations: users, api_keys, jobs, token_usage, audit_log.

- [ ] **4.6: Create models/db.ts - PostgreSQL connection**

Use `pg` Pool + `drizzle-orm/node-postgres`. Export db instance.

- [ ] **4.7: Create services/neo4j.ts - Neo4j driver**

Use `neo4j-driver`. Export driver, runQuery helper, close helper.

- [ ] **4.8: Create services/queue.ts - BullMQ job queue**

Create `kexQueue` for dispatching extraction jobs. Export queue + helpers.

- [ ] **4.9: Create services/mail.ts - Nodemailer**

SMTP to MailDev. Export `sendVerificationEmail`, `sendPasswordResetEmail`.

- [ ] **4.10: Create middleware/auth.ts - JWT verification**

Extract Bearer token, verify with jsonwebtoken, attach `req.user`. Export `requireAuth` and `requireRole(role)`.

- [ ] **4.11: Create middleware/validate.ts - Zod validation**

Generic middleware factory: `validate(schema)` that validates req.body against Zod schema.

- [ ] **4.12: Create middleware/rateLimit.ts**

Express-rate-limit: 100 req/min general, 10 req/min for auth endpoints.

- [ ] **4.13: Create middleware/tokenMeter.ts**

Middleware that checks user token balance before action, deducts on completion. Token costs from CLAUDE-GCTRL.md spec.

- [ ] **4.14: Create middleware/acl.ts**

Classification-based access filter. Reads user clearance from JWT, filters Neo4j query results to only include nodes at or below clearance level.

- [ ] **4.15: Create routes/auth.ts**

Endpoints: POST /register, /login, /refresh, /forgot-password, /reset-password, /verify-email. Full implementation with bcrypt, JWT, email sending.

- [ ] **4.16: Create routes/kex.ts**

Endpoints: POST /extract (submit text), POST /upload (file upload), GET /jobs/:id, GET /jobs/:id/result. Dispatches to BullMQ, returns job status.

- [ ] **4.17: Create routes/users.ts**

Endpoints: GET /me (profile), GET / (admin list), PUT /:id/role (admin).

- [ ] **4.18: Create routes/keys.ts**

Endpoints: POST / (generate API key), GET / (list keys), DELETE /:id (revoke).

- [ ] **4.19: Create index.ts - Express app entry point**

Wire up all middleware (cors, helmet, json, rateLimit), mount routes under /api/*, start server on PORT.

- [ ] **4.20: Build and test API container**

Run: `cd GCTRL && docker compose build api`
Expected: Build succeeds

---

## Task 5: KEX Worker Service

**Files:**
- Create: `GCTRL/services/kex/Dockerfile`
- Create: `GCTRL/services/kex/requirements.txt`
- Create: `GCTRL/services/kex/src/config.py`
- Create: `GCTRL/services/kex/src/main.py`
- Create: `GCTRL/services/kex/src/ner.py`
- Create: `GCTRL/services/kex/src/relex.py`
- Create: `GCTRL/services/kex/src/kg_builder.py`
- Create: `GCTRL/services/kex/src/sources/file_handler.py`
- Create: `GCTRL/services/kex/src/sources/url_handler.py`

### Sub-tasks:

- [ ] **5.1: Create Dockerfile**

Python 3.11-slim, install gcc/g++ for torch, copy requirements, pip install, copy src, expose 4010, run uvicorn.

- [ ] **5.2: Create requirements.txt**

fastapi, uvicorn, transformers, torch, neo4j, redis, requests, trafilatura, python-multipart, python-docx, PyPDF2, openpyxl

- [ ] **5.3: Create config.py**

Load env vars: OLLAMA_BASE, NEO4J_URI/USER/PASSWORD, REDIS_URL, PORT.

- [ ] **5.4: Port and upgrade ner.py from existing ner-api**

Reuse existing NER pipeline from `ner-api/server.py`. Keep dslim/bert-base-NER for now (multilingual upgrade in Phase 2). Add batch processing support.

- [ ] **5.5: Port and upgrade relex.py from existing ner-api**

Reuse Ollama relation extraction. Make model configurable. Improve JSON parsing robustness.

- [ ] **5.6: Create kg_builder.py - Neo4j graph writer**

Take NER entities + RelEx relations → create Neo4j nodes and relationships. Add _classification (default PUBLIC), _owner, _source_job properties to every node/edge.

- [ ] **5.7: Create sources/file_handler.py**

Extract text from: PDF (PyPDF2), DOCX (python-docx), CSV, JSON, XML, TXT. Return plain text.

- [ ] **5.8: Create sources/url_handler.py**

Port URL scraping from webqa-api/server.py. Use trafilatura for extraction.

- [ ] **5.9: Create main.py - FastAPI server + job consumer**

FastAPI with:
- POST /extract (direct text extraction)
- POST /upload (file upload extraction)
- GET /health
- Background task: consume BullMQ jobs from Redis, run pipeline, update job status

Pipeline: Source → Text → NER → RelEx → KG Builder → Neo4j

- [ ] **5.10: Build and test KEX container**

Run: `cd GCTRL && docker compose build kex`
Expected: Build succeeds

---

## Task 6: React Frontend

**Files:**
- Create: `GCTRL/services/web/Dockerfile`
- Create: `GCTRL/services/web/package.json`
- Create: `GCTRL/services/web/tsconfig.json`
- Create: `GCTRL/services/web/vite.config.ts`
- Create: `GCTRL/services/web/tailwind.config.ts`
- Create: `GCTRL/services/web/postcss.config.js`
- Create: `GCTRL/services/web/index.html`
- Create: `GCTRL/services/web/src/main.tsx`
- Create: `GCTRL/services/web/src/App.tsx`
- Create: `GCTRL/services/web/src/styles/globals.css`
- Create: `GCTRL/services/web/src/lib/api.ts`
- Create: `GCTRL/services/web/src/lib/auth.ts`
- Create: `GCTRL/services/web/src/hooks/useAuth.ts`
- Create: `GCTRL/services/web/src/hooks/useApi.ts`
- Create: `GCTRL/services/web/src/components/layout/AppShell.tsx`
- Create: `GCTRL/services/web/src/components/layout/Sidebar.tsx`
- Create: `GCTRL/services/web/src/components/layout/Header.tsx`
- Create: `GCTRL/services/web/src/pages/auth/LoginPage.tsx`
- Create: `GCTRL/services/web/src/pages/auth/RegisterPage.tsx`
- Create: `GCTRL/services/web/src/pages/auth/ForgotPasswordPage.tsx`
- Create: `GCTRL/services/web/src/pages/DashboardPage.tsx`
- Create: `GCTRL/services/web/src/pages/kex/KexPage.tsx`
- Create: `GCTRL/services/web/src/pages/kex/KexJobDetail.tsx`

### Sub-tasks:

- [ ] **6.1: Create Dockerfile (multi-stage: build + nginx)**

```dockerfile
FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
```

- [ ] **6.2: Create package.json with Vite + React + Tailwind + shadcn deps**

react, react-dom, react-router-dom, @tanstack/react-query, axios, tailwindcss, @radix-ui/*, lucide-react, class-variance-authority, clsx, tailwind-merge

- [ ] **6.3: Create Vite + Tailwind + PostCSS config files**

Standard Vite React-TS setup with Tailwind. API proxy to localhost:4000.

- [ ] **6.4: Create index.html + main.tsx + globals.css**

Root HTML, React mount point, Tailwind base styles with CSS variables for dark/light theme.

- [ ] **6.5: Create lib/api.ts - Axios API client**

Base URL: /api (proxied to GCTRL-api:4000). Auto-attach JWT from localStorage. Auto-refresh on 401.

- [ ] **6.6: Create lib/auth.ts - Auth helpers**

Store/retrieve JWT + refresh token in localStorage. Decode JWT for user info. Check expiry.

- [ ] **6.7: Create hooks/useAuth.ts - Auth context + hook**

React context providing: user, login(), logout(), register(), isAuthenticated. Wraps API calls.

- [ ] **6.8: Create hooks/useApi.ts - API query hook**

Thin wrapper around @tanstack/react-query + api.ts for data fetching.

- [ ] **6.9: Create layout components (AppShell, Sidebar, Header)**

Professional sidebar layout. Sidebar: KEX, FUSE (disabled), KG (disabled), Chat (disabled), Admin (role-gated). Header: user menu, dark/light toggle.

- [ ] **6.10: Create App.tsx - Router setup**

React Router v6 with routes: /login, /register, /forgot-password, /dashboard, /kex, /kex/:id. Protected routes require auth.

- [ ] **6.11: Create auth pages (Login, Register, ForgotPassword)**

Clean forms using shadcn/ui components. Form validation. Error display. Success redirects.

- [ ] **6.12: Create DashboardPage**

Welcome page showing: user name, token balance, quick actions (Upload to KEX, View Graphs), recent jobs list.

- [ ] **6.13: Create KexPage - Upload zone + job list**

Drag-and-drop file upload zone (react-dropzone), URL input field, text paste area. Below: list of user's KEX jobs with status badges.

- [ ] **6.14: Create KexJobDetail - Job status + results viewer**

Show job status (pending/processing/completed/failed). On completion: show extracted entities count, relations count, link to view in Neo4j browser.

- [ ] **6.15: Create nginx.conf for SPA routing**

Route all paths to index.html, proxy /api to GCTRL-api.

- [ ] **6.16: Build and test frontend container**

Run: `cd GCTRL && docker compose build web`
Expected: Build succeeds

---

## Task 7: Integration & Smoke Test

- [ ] **7.1: Start all services**

Run: `cd GCTRL && docker compose up -d`
Expected: All containers start (api, web, kex, postgres, redis, maildev)

- [ ] **7.2: Verify PostgreSQL migrations ran**

Run: `docker exec GCTRL-postgres psql -U GCTRL -d GCTRL -c "\dt"`
Expected: See users, api_keys, jobs, token_usage, audit_log tables

- [ ] **7.3: Test auth flow**

```bash
# Register
curl -X POST http://localhost:4000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"test@test.com","password":"Test1234!","name":"Test User"}'

# Login
curl -X POST http://localhost:4000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"test@test.com","password":"Test1234!"}'
# Expected: JWT token in response
```

- [ ] **7.4: Test KEX extraction**

```bash
# Submit extraction (with JWT from login)
curl -X POST http://localhost:4000/api/kex/extract \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -d '{"text":"Apple Inc. was founded by Steve Jobs in Cupertino, California."}'
# Expected: Job ID returned

# Check status
curl http://localhost:4000/api/kex/jobs/<job-id> \
  -H "Authorization: Bearer <token>"
# Expected: Job status (pending -> processing -> completed)
```

- [ ] **7.5: Verify Neo4j graph was created**

```bash
docker exec neo4j cypher-shell -u neo4j -p password \
  "MATCH (n:Entity) RETURN n.name, n.type, n._classification LIMIT 10"
# Expected: Entities from extraction (Apple Inc., Steve Jobs, Cupertino, California)
```

- [ ] **7.6: Test frontend loads**

Open http://localhost:3000 in browser
Expected: Login page renders, can navigate to register, can login after auth flow

- [ ] **7.7: Update tasks/todo.md with Phase 1 completion status**

---

## Dependencies Between Tasks

```
Task 1 (Docker) ──→ Task 2 (PostgreSQL) ──→ Task 4 (API)
                ──→ Task 3 (Neo4j)      ──→ Task 5 (KEX)
                                         ──→ Task 6 (Frontend)
                                              ↓
                                         Task 7 (Integration)
```

Tasks 4, 5, 6 can run in parallel once Tasks 1-3 are done.
Task 7 requires all prior tasks.

