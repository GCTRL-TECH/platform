# Phase 4: Code Protection & CI/CD Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Obfuscate Python services with PyArmor and Node/TS services with javascript-obfuscator, set up a private GitHub Container Registry, and automate the full build-obfuscate-push-deploy pipeline via GitHub Actions. After this phase, source code never leaves the private repo — customers receive only compiled, obfuscated Docker images.

**Architecture:** GitHub Actions builds all services in sequence. Python services run through PyArmor before being copied into their Docker images. Node/TS services are compiled then run through javascript-obfuscator. All images are pushed to `ghcr.io/gctrl/` (private). The VPS is updated via SSH after a successful push. Installer scripts in the public `gctrl/deploy` repo are updated automatically.

**Tech Stack:** GitHub Actions, PyArmor 8, javascript-obfuscator, Docker buildx, ghcr.io, SSH deploy

**Prerequisite:** Phase 3 complete — all services buildable locally. Two GitHub repos created: `gctrl/platform` (private) and `gctrl/deploy` (public).

---

## File Map

```
.github/
  workflows/
    build-push.yml          — Main CI/CD pipeline (triggers on push to main)
    build-kex.yml           — Reusable: build + obfuscate + push KEX image
    build-fuse.yml          — Reusable: build + obfuscate + push FUSE image
    build-api.yml           — Reusable: build + obfuscate + push license-api image
    build-agent.yml         — Reusable: build + obfuscate + push agent image
    build-web.yml           — Reusable: build + push web image

services/
  kex/
    build/
      obfuscate.sh          — PyArmor obfuscation script
      Dockerfile.prod       — Production Dockerfile (uses obfuscated artifacts)
  fuse/
    build/
      obfuscate.sh
      Dockerfile.prod
  license-api/
    build/
      obfuscate.sh          — javascript-obfuscator script
      Dockerfile.prod
  agent/
    build/
      obfuscate.sh
      Dockerfile.prod
  web/
    Dockerfile.prod
```

---

### Task 1: Set Up GitHub Repos + Secrets

**Files:** None (GitHub configuration)

- [ ] **Step 1: Create repos**

```bash
# Requires gh CLI authenticated
gh repo create gctrl/platform --private --description "Ground Control platform source"
gh repo create gctrl/deploy --public --description "Ground Control deployment scripts"
```

- [ ] **Step 2: Add GitHub Actions secrets to gctrl/platform**

```bash
# VPS SSH key (generate a deploy key)
ssh-keygen -t ed25519 -f ~/.ssh/gctrl_deploy -N "" -C "github-actions-deploy"
# Add public key to VPS: cat ~/.ssh/gctrl_deploy.pub >> root@72.61.189.78:~/.ssh/authorized_keys

gh secret set VPS_SSH_KEY < ~/.ssh/gctrl_deploy
gh secret set VPS_HOST --body "72.61.189.78"
gh secret set VPS_USER --body "root"

# GHCR — use GitHub token with packages:write
gh secret set GHCR_TOKEN --body "$GITHUB_TOKEN"

# Stripe + Resend (for VPS .env)
gh secret set STRIPE_SECRET_KEY --body "sk_live_..."
gh secret set STRIPE_WEBHOOK_SECRET --body "whsec_..."
gh secret set STRIPE_PRICE_STARTER --body "price_..."
gh secret set STRIPE_PRICE_PRO --body "price_..."
gh secret set RESEND_API_KEY --body "re_..."
gh secret set LICENSE_HMAC_SECRET --body "$(openssl rand -hex 32)"
```

- [ ] **Step 3: Commit setup notes**

```bash
git add .github/
git commit -m "chore: GitHub Actions setup documentation"
```

---

### Task 2: PyArmor Obfuscation for KEX

**Files:**
- Create: `services/kex/build/obfuscate.sh`
- Create: `services/kex/build/Dockerfile.prod`

- [ ] **Step 1: Write obfuscation script**

```bash
#!/bin/bash
# services/kex/build/obfuscate.sh
set -e

echo "=== PyArmor: obfuscating KEX ==="
pip install pyarmor==8.5.11 --quiet

# Obfuscate all Python source files
pyarmor gen \
  --output dist/obfuscated \
  --recursive \
  --platform linux.x86_64 \
  src/

echo "=== Obfuscation complete ==="
ls -la dist/obfuscated/
```

- [ ] **Step 2: Write production Dockerfile**

```dockerfile
# services/kex/build/Dockerfile.prod
# Stage 1: Obfuscate
FROM python:3.11-slim AS obfuscator
WORKDIR /build
COPY requirements.txt ./
RUN pip install pyarmor==8.5.11
COPY src/ ./src/
RUN pyarmor gen --output dist/obfuscated --recursive --platform linux.x86_64 src/

# Stage 2: Runtime (no source, only obfuscated artifacts)
FROM python:3.11-slim
WORKDIR /app

# Install runtime dependencies only
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt && \
    pip install pyarmor.cli.runtime==5.x.x --quiet

# Copy ONLY obfuscated code (no source)
COPY --from=obfuscator /build/dist/obfuscated ./src

# Verify no .py source files leaked
RUN find /app -name "*.py" | grep -v "pyarmor" | head -5 && \
    echo "Source check passed"

EXPOSE 4010
CMD ["python", "-m", "uvicorn", "src.main:app", "--host", "0.0.0.0", "--port", "4010"]
```

- [ ] **Step 3: Test locally**

```bash
cd services/kex
bash build/obfuscate.sh
docker build -f build/Dockerfile.prod -t gctrl-kex-test .
docker run --rm gctrl-kex-test python -c "from src.config import OLLAMA_BASE; print('OK')"
```
Expected: `OK` printed, no ImportError.

- [ ] **Step 4: Commit**

```bash
git add services/kex/build/
git commit -m "feat(kex): PyArmor obfuscation build pipeline"
```

---

### Task 3: PyArmor Obfuscation for FUSE

**Files:**
- Create: `services/fuse/build/obfuscate.sh`
- Create: `services/fuse/build/Dockerfile.prod`

- [ ] **Step 1: Write obfuscation script (same pattern as KEX)**

```bash
#!/bin/bash
# services/fuse/build/obfuscate.sh
set -e
pip install pyarmor==8.5.11 --quiet
pyarmor gen --output dist/obfuscated --recursive --platform linux.x86_64 src/
echo "FUSE obfuscation complete"
```

- [ ] **Step 2: Write production Dockerfile (same pattern as KEX)**

```dockerfile
# services/fuse/build/Dockerfile.prod
FROM python:3.11-slim AS obfuscator
WORKDIR /build
COPY requirements.txt ./
RUN pip install pyarmor==8.5.11
COPY src/ ./src/
RUN pyarmor gen --output dist/obfuscated --recursive --platform linux.x86_64 src/

FROM python:3.11-slim
WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY --from=obfuscator /build/dist/obfuscated ./src
EXPOSE 4020
CMD ["python", "-m", "uvicorn", "src.main:app", "--host", "0.0.0.0", "--port", "4020"]
```

- [ ] **Step 3: Commit**

```bash
git add services/fuse/build/
git commit -m "feat(fuse): PyArmor obfuscation build pipeline"
```

---

### Task 4: javascript-obfuscator for License API + Agent

**Files:**
- Create: `services/license-api/build/obfuscate.sh`
- Create: `services/license-api/build/Dockerfile.prod`
- Create: `services/agent/build/obfuscate.sh`
- Create: `services/agent/build/Dockerfile.prod`

- [ ] **Step 1: Write license-api obfuscation script**

```bash
#!/bin/bash
# services/license-api/build/obfuscate.sh
set -e

npm run build  # TypeScript → dist/

npm install -g javascript-obfuscator --quiet

echo "=== Obfuscating license-api ==="
javascript-obfuscator dist/ \
  --output dist-obfuscated/ \
  --compact true \
  --control-flow-flattening true \
  --control-flow-flattening-threshold 0.5 \
  --string-array true \
  --string-array-encoding rc4 \
  --string-array-threshold 0.75 \
  --rotate-string-array true \
  --dead-code-injection false \
  --source-map false

echo "=== Obfuscation complete ==="
```

- [ ] **Step 2: Write license-api production Dockerfile**

```dockerfile
# services/license-api/build/Dockerfile.prod
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build
RUN npm install -g javascript-obfuscator && \
    javascript-obfuscator dist/ --output dist-obfuscated/ \
      --compact true --control-flow-flattening true \
      --string-array true --string-array-encoding rc4 \
      --source-map false

FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist-obfuscated ./dist
EXPOSE 4000
CMD ["node", "dist/index.js"]
```

- [ ] **Step 3: Write agent production Dockerfile (with pkg binary)**

```dockerfile
# services/agent/build/Dockerfile.prod
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json src/ ./
RUN npm run build && \
    npm install -g javascript-obfuscator && \
    javascript-obfuscator dist/ --output dist-obfuscated/ \
      --compact true --control-flow-flattening true \
      --string-array true --string-array-encoding rc4 \
      --source-map false && \
    npx pkg dist-obfuscated/index.js \
      --target node20-linux-x64 \
      --output gctrl-agent

FROM alpine:3.19
RUN apk add --no-cache ca-certificates
WORKDIR /app
COPY --from=builder /app/gctrl-agent ./gctrl-agent
VOLUME /app/config
EXPOSE 7070
CMD ["./gctrl-agent"]
```

- [ ] **Step 4: Verify agent binary works**

```bash
cd services/agent
docker build -f build/Dockerfile.prod -t gctrl-agent-test .
docker run --rm -e GCTRL_LICENSE_PUBLIC_KEY="test" gctrl-agent-test ./gctrl-agent --help 2>&1 | head -5
```
Expected: binary runs (exits with error about missing JWT — that's fine, binary works).

- [ ] **Step 5: Commit**

```bash
git add services/license-api/build/ services/agent/build/
git commit -m "feat(license-api,agent): javascript-obfuscator + pkg binary build pipeline"
```

---

### Task 5: GitHub Actions CI/CD Pipeline

**Files:**
- Create: `.github/workflows/build-push.yml`

- [ ] **Step 1: Write main pipeline**

```yaml
# .github/workflows/build-push.yml
name: Build, Obfuscate, Push, Deploy

on:
  push:
    branches: [main]
  workflow_dispatch:

env:
  REGISTRY: ghcr.io
  ORG: gctrl

jobs:
  build-kex:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GHCR_TOKEN }}
      - uses: docker/build-push-action@v5
        with:
          context: services/kex
          file: services/kex/build/Dockerfile.prod
          push: true
          tags: ghcr.io/gctrl/kex:latest,ghcr.io/gctrl/kex:${{ github.sha }}

  build-fuse:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: docker/login-action@v3
        with: { registry: ghcr.io, username: ${{ github.actor }}, password: ${{ secrets.GHCR_TOKEN }} }
      - uses: docker/build-push-action@v5
        with:
          context: services/fuse
          file: services/fuse/build/Dockerfile.prod
          push: true
          tags: ghcr.io/gctrl/fuse:latest,ghcr.io/gctrl/fuse:${{ github.sha }}

  build-api:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: docker/login-action@v3
        with: { registry: ghcr.io, username: ${{ github.actor }}, password: ${{ secrets.GHCR_TOKEN }} }
      - uses: docker/build-push-action@v5
        with:
          context: services/license-api
          file: services/license-api/build/Dockerfile.prod
          push: true
          tags: ghcr.io/gctrl/license-api:latest,ghcr.io/gctrl/license-api:${{ github.sha }}

  build-agent:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: docker/login-action@v3
        with: { registry: ghcr.io, username: ${{ github.actor }}, password: ${{ secrets.GHCR_TOKEN }} }
      - uses: docker/build-push-action@v5
        with:
          context: services/agent
          file: services/agent/build/Dockerfile.prod
          push: true
          tags: ghcr.io/gctrl/agent:latest,ghcr.io/gctrl/agent:${{ github.sha }}

  build-web:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: docker/login-action@v3
        with: { registry: ghcr.io, username: ${{ github.actor }}, password: ${{ secrets.GHCR_TOKEN }} }
      - uses: docker/build-push-action@v5
        with:
          context: services/web
          push: true
          tags: ghcr.io/gctrl/web:latest,ghcr.io/gctrl/web:${{ github.sha }}

  deploy-vps:
    needs: [build-kex, build-fuse, build-api, build-agent, build-web]
    runs-on: ubuntu-latest
    steps:
      - name: Deploy to VPS
        uses: appleboy/ssh-action@v1
        with:
          host: ${{ secrets.VPS_HOST }}
          username: ${{ secrets.VPS_USER }}
          key: ${{ secrets.VPS_SSH_KEY }}
          script: |
            cd /opt/gctrl
            echo ${{ secrets.GHCR_TOKEN }} | docker login ghcr.io -u gctrl --password-stdin
            docker compose pull gctrl-api gctrl-web
            docker compose up -d gctrl-api gctrl-web
            docker compose ps

  update-deploy-repo:
    needs: deploy-vps
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          repository: gctrl/deploy
          token: ${{ secrets.GHCR_TOKEN }}
          path: deploy-repo
      - name: Update version tag in installer
        run: |
          cd deploy-repo
          sed -i "s/GCTRL_VERSION=.*/GCTRL_VERSION=${{ github.sha }}/" install.sh
          git config user.name "GitHub Actions"
          git config user.email "actions@github.com"
          git commit -am "chore: update to ${{ github.sha }}" || echo "No changes"
          git push
```

- [ ] **Step 2: Push and verify pipeline runs**

```bash
git add .github/workflows/
git commit -m "ci: GitHub Actions build-obfuscate-push-deploy pipeline"
git push origin main
```

Watch: `gh run watch`
Expected: all 6 jobs green, images visible at `ghcr.io/gctrl/`.

- [ ] **Step 3: Verify images are private**

```bash
# Without auth — should fail:
docker pull ghcr.io/gctrl/kex:latest
# Expected: unauthorized error
```

- [ ] **Step 4: Verify VPS updated**

```bash
curl https://api.gctrl.tech/health
```
Expected: `{"ok":true,"service":"gctrl-api"}` with new build.
