# Phase 1: Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename GCTRL → GCTRL, fix DNS, and deploy the VPS control-plane infrastructure (Traefik + PostgreSQL + Redis) so Phases 2-5 have a running target to deploy to.

**Architecture:** The VPS already runs Ubuntu 24.04 with Docker + Traefik pre-installed. We configure Traefik labels for three subdomains, fix the broken root DNS A record, and deploy the data services (PostgreSQL, Redis) that the License Server will use in Phase 2. The local codebase is renamed from GCTRL → GCTRL via automated find-replace following the prepared RENAME-PLAN.md.

**Tech Stack:** Docker Compose, Traefik v2, PostgreSQL 16, Redis 7, bash (rename scripts), Hostinger DNS API (via MCP)

---

## File Map

**New files (VPS):**
- `/opt/gctrl/docker-compose.yml` — control-plane services
- `/opt/gctrl/.env` — secrets (DB passwords, JWT keys)
- `/opt/gctrl/traefik/traefik.yml` — Traefik static config
- `/opt/gctrl/traefik/dynamic/` — Traefik dynamic routing rules

**Modified (local codebase — 58 files per RENAME-PLAN.md):**
- All files containing `GCTRL`, `GCTRL`, `GCTRL`, `GCTRLApi`, `n8n-nodes-GCTRL`

---

### Task 1: Fix DNS Records via Hostinger API

**Files:** None (DNS only)

- [ ] **Step 1: Update root A record to VPS IP**

Using Hostinger MCP tool `DNS_updateDNSRecordsV1` for domain `gctrl.tech`:
```json
{
  "overwrite": true,
  "zone": [
    { "name": "@", "records": [{ "content": "72.61.189.78" }], "ttl": 300, "type": "A" },
    { "name": "api", "records": [{ "content": "72.61.189.78" }], "ttl": 300, "type": "A" },
    { "name": "admin", "records": [{ "content": "72.61.189.78" }], "ttl": 300, "type": "A" },
    { "name": "www", "records": [{ "content": "gctrl.tech." }], "ttl": 300, "type": "CNAME" }
  ]
}
```

- [ ] **Step 2: Verify DNS propagation**

```bash
dig +short @8.8.8.8 gctrl.tech
dig +short @8.8.8.8 api.gctrl.tech
dig +short @8.8.8.8 admin.gctrl.tech
```
Expected: all three return `72.61.189.78`

- [ ] **Step 3: Commit DNS change note**

```bash
git add docs/
git commit -m "chore: document DNS records updated for gctrl.tech"
```

---

### Task 2: Verify Traefik on VPS

**Files:** `/opt/gctrl/traefik/traefik.yml`

- [ ] **Step 1: SSH into VPS and check Traefik**

```bash
ssh root@72.61.189.78
docker ps | grep traefik
docker inspect traefik | grep -A5 "Mounts"
```
Expected: Traefik container running, note mount paths.

- [ ] **Step 2: Check existing Traefik config**

```bash
find / -name "traefik.yml" 2>/dev/null
cat /path/to/traefik.yml
```
Note the Let's Encrypt email and entrypoints configured.

- [ ] **Step 3: Create /opt/gctrl directory structure on VPS**

```bash
mkdir -p /opt/gctrl/traefik/dynamic
mkdir -p /opt/gctrl/data/postgres
mkdir -p /opt/gctrl/data/redis
```

- [ ] **Step 4: Write Traefik dynamic routing config**

Create `/opt/gctrl/traefik/dynamic/gctrl.yml`:
```yaml
http:
  routers:
    gctrl-web:
      rule: "Host(`gctrl.tech`) || Host(`www.gctrl.tech`)"
      entryPoints: ["websecure"]
      service: gctrl-web
      tls:
        certResolver: letsencrypt

    gctrl-api:
      rule: "Host(`api.gctrl.tech`)"
      entryPoints: ["websecure"]
      service: gctrl-api
      tls:
        certResolver: letsencrypt

    gctrl-admin:
      rule: "Host(`admin.gctrl.tech`)"
      entryPoints: ["websecure"]
      service: gctrl-web
      tls:
        certResolver: letsencrypt

  services:
    gctrl-web:
      loadBalancer:
        servers:
          - url: "http://gctrl-web:3000"

    gctrl-api:
      loadBalancer:
        servers:
          - url: "http://gctrl-api:4000"
```

- [ ] **Step 5: Add Traefik dynamic config directory to Traefik's file provider**

Edit existing Traefik config to include `/opt/gctrl/traefik/dynamic/` as a file provider directory. Restart Traefik:
```bash
docker restart traefik
docker logs traefik --tail 20
```
Expected: No errors, Traefik loaded new config.

---

### Task 3: Deploy PostgreSQL + Redis on VPS

**Files:** `/opt/gctrl/docker-compose.yml`, `/opt/gctrl/.env`

- [ ] **Step 1: Generate secrets**

```bash
ssh root@72.61.189.78
openssl rand -hex 32  # → DB_PASSWORD
openssl rand -hex 32  # → REDIS_PASSWORD
openssl genrsa -out /opt/gctrl/keys/license_private.pem 4096
openssl rsa -in /opt/gctrl/keys/license_private.pem -pubout -out /opt/gctrl/keys/license_public.pem
mkdir -p /opt/gctrl/keys
chmod 600 /opt/gctrl/keys/license_private.pem
```

- [ ] **Step 2: Write /opt/gctrl/.env**

```bash
cat > /opt/gctrl/.env << 'EOF'
POSTGRES_USER=gctrl
POSTGRES_PASSWORD=<generated above>
POSTGRES_DB=gctrl
REDIS_PASSWORD=<generated above>
EOF
chmod 600 /opt/gctrl/.env
```

- [ ] **Step 3: Write /opt/gctrl/docker-compose.yml**

```yaml
version: "3.9"

networks:
  gctrl:
    driver: bridge

volumes:
  gctrl-pgdata:
  gctrl-redisdata:

services:
  gctrl-db:
    image: postgres:16-alpine
    container_name: gctrl-db
    restart: unless-stopped
    environment:
      POSTGRES_USER: ${POSTGRES_USER}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: ${POSTGRES_DB}
    volumes:
      - gctrl-pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${POSTGRES_USER}"]
      interval: 5s
      timeout: 5s
      retries: 5
    networks:
      - gctrl

  gctrl-redis:
    image: redis:7-alpine
    container_name: gctrl-redis
    restart: unless-stopped
    command: redis-server --requirepass ${REDIS_PASSWORD}
    volumes:
      - gctrl-redisdata:/data
    healthcheck:
      test: ["CMD", "redis-cli", "-a", "${REDIS_PASSWORD}", "ping"]
      interval: 5s
      timeout: 5s
      retries: 5
    networks:
      - gctrl
```

- [ ] **Step 4: Start services**

```bash
cd /opt/gctrl
docker compose up -d gctrl-db gctrl-redis
docker compose ps
```
Expected: both containers `Up (healthy)`

- [ ] **Step 5: Verify connectivity**

```bash
docker exec gctrl-db pg_isready -U gctrl
docker exec gctrl-redis redis-cli -a <REDIS_PASSWORD> ping
```
Expected: `gctrl:5432 - accepting connections` and `PONG`

---

### Task 4: Rename GCTRL → GCTRL in Local Codebase

**Files:** 58 files per `d:/N8N/Projekte/Databorg/GCTRL/RENAME-PLAN.md`

- [ ] **Step 1: Create a git branch for the rename**

```bash
cd d:/N8N/Projekte/Databorg/GCTRL
git init  # if not already a git repo
git checkout -b feat/rename-to-gctrl
```

- [ ] **Step 2: Run automated rename — identifiers and env vars**

```bash
# Windows PowerShell — run from d:/N8N/Projekte/Databorg/GCTRL
$files = Get-ChildItem -Recurse -Include "*.ts","*.tsx","*.js","*.jsx","*.py","*.json","*.yml","*.yaml","*.md","*.env*","*.sh" |
  Where-Object { $_.FullName -notmatch "node_modules|\.git|dist|build|__pycache__|\.next" }

foreach ($file in $files) {
  $content = Get-Content $file.FullName -Raw -Encoding UTF8
  $updated = $content `
    -replace 'GCTRL', 'GCTRL' `
    -replace 'GCTRL-api', 'gctrl-api' `
    -replace 'GCTRL-web', 'gctrl-web' `
    -replace 'GCTRL-kex', 'gctrl-kex' `
    -replace 'GCTRL-fuse', 'gctrl-fuse' `
    -replace 'GCTRL-postgres', 'gctrl-postgres' `
    -replace 'GCTRL-redis', 'gctrl-redis' `
    -replace 'GCTRL-limes', 'gctrl-limes' `
    -replace 'GCTRL-maildev', 'gctrl-maildev' `
    -replace 'GCTRL_', 'gctrl_' `
    -replace 'GCTRLApi', 'gctrlApi' `
    -replace 'n8n-nodes-GCTRL', 'n8n-nodes-gctrl' `
    -replace '\bGCTRL\b', 'gctrl' `
    -replace 'GCTRL', 'Ground Control'
  if ($updated -ne $content) {
    Set-Content $file.FullName $updated -Encoding UTF8
    Write-Host "Updated: $($file.FullName)"
  }
}
```

- [ ] **Step 3: Rename package.json name fields**

```bash
# Verify package.json files updated correctly
grep -r '"name"' --include="package.json" . | grep -v node_modules
```
Expected: no remaining `GCTRL` in name fields.

- [ ] **Step 4: Rename docker-compose container_name values — verify**

```bash
grep -r "container_name" --include="*.yml" . | grep -v node_modules
```
Expected: all container names use `gctrl-*` prefix.

- [ ] **Step 5: Update MCP tool references in Claude settings**

Edit `d:/N8N/Projekte/n8n-builder/.claude/settings.json` — update any `mcp__GCTRL__*` permissions to `mcp__gctrl__*`.

Also update `d:/N8N/Projekte/Databorg/GCTRL/CLAUDE-GCTRL.md` references.

- [ ] **Step 6: Handle Docker volume migration note**

Create `docs/VOLUME-MIGRATION.md`:
```markdown
# Docker Volume Migration: GCTRL → GCTRL

When upgrading an existing GCTRL installation:

1. Stop old containers: `docker compose down`
2. Rename volumes:
   ```bash
   docker volume create gctrl-pgdata
   docker run --rm -v GCTRL-pgdata:/from -v gctrl-pgdata:/to alpine sh -c "cp -av /from/. /to/"
   docker volume rm GCTRL-pgdata
   ```
3. Start new containers: `docker compose up -d`

For fresh installs this is not needed.
```

- [ ] **Step 7: Rebuild to verify no TypeScript errors**

```bash
cd services/api && npm run build 2>&1 | tail -5
cd ../kex  # Python — check imports
python3 -c "import src.config; print('OK')"
```
Expected: builds clean, no import errors.

- [ ] **Step 8: Commit rename**

```bash
git add -A
git commit -m "feat: rename GCTRL → Ground Control (GCTRL)

- All identifiers: GCTRL → gctrl
- All env vars: GCTRL → GCTRL
- UI strings: GCTRL → Ground Control
- Container names: GCTRL-* → gctrl-*
- npm package: n8n-nodes-GCTRL → n8n-nodes-gctrl
- Docker volume migration guide added"
```

---

### Task 5: Add LIMES License Notice

**Files:** `docs/LICENSES.md`

- [ ] **Step 1: Create license notice file**

Create `d:/N8N/Projekte/Databorg/GCTRL/docs/LICENSES.md`:
```markdown
# Third-Party License Notices

## LIMES — Link Discovery Framework for Metric Spaces

- **License:** GNU Affero General Public License v3.0 (AGPL-3.0)
- **Source:** https://github.com/dice-group/LIMES
- **Usage:** LIMES runs as an independent Docker container. Ground Control
  communicates with it exclusively via HTTP REST. LIMES source code is
  not modified and is not incorporated into Ground Control's codebase.
- **Compliance:** As an unmodified, separately-running service accessed
  only via network, LIMES is not a derivative work of Ground Control.
  Users who require LIMES source code may obtain it at the URL above.
```

- [ ] **Step 2: Commit**

```bash
git add docs/LICENSES.md
git commit -m "docs: add LIMES AGPL-3.0 license notice"
```

---

### Task 6: Smoke Test

- [ ] **Step 1: Start local GCTRL stack**

```bash
cd d:/N8N/Projekte/Databorg/GCTRL
docker compose up -d
docker compose ps
```
Expected: all containers up, no name collisions with old GCTRL-* containers.

- [ ] **Step 2: Verify web UI loads**

Open `http://localhost:3001` in browser.
Expected: Ground Control UI loads (not GCTRL).

- [ ] **Step 3: Verify VPS services**

```bash
curl -f https://gctrl.tech  # should reach Traefik (may 502 until Phase 2 web deployed)
curl -f https://api.gctrl.tech/health  # 502 until Phase 2
```
Expected: Traefik responds (even if 502 — means SSL + routing works).

- [ ] **Step 4: Final commit**

```bash
git add -A
git commit -m "chore: phase 1 complete — foundation ready for Phase 2"
```

