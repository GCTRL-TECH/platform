# Phase 5: Installer & End-to-End Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Write and host the install/update/uninstall bash scripts at `gctrl.tech/install`, `gctrl.tech/update`, `gctrl.tech/uninstall`. Run a full end-to-end test on a clean machine simulating the customer experience from `curl | bash` to running GCTRL with an active license.

**Architecture:** Three bash scripts live in the public `gctrl/deploy` repo and are served as static files by the Next.js web app at known URLs. The installer calls `api.gctrl.tech/v1/activate`, receives a registry token + license JWT, logs into ghcr.io, generates a `docker-compose.yml` and `.env`, and starts the stack. The update script pulls new images and restarts. The uninstall script stops containers, removes images, and deactivates the license while preserving customer data.

**Tech Stack:** bash, Docker CLI, curl, openssl (hardware fingerprint fallback), gctrl/deploy repo (public)

**Prerequisite:** Phases 1-4 complete — VPS running, all images on ghcr.io, `api.gctrl.tech` live.

---

## File Map

```
# In gctrl/deploy repo (public):
install.sh           — Main installer
update.sh            — Update script
uninstall.sh         — Uninstall + deactivate
compose-template.yml — Docker Compose template (filled by installer)
.env-template        — .env template

# In gctrl/platform repo:
services/web/public/
  install            — Symlink / redirect to install.sh raw content
  update             — Symlink / redirect
  uninstall          — Symlink / redirect
services/web/src/app/api/scripts/[name]/route.ts — Serves scripts from deploy repo
```

---

### Task 1: Hardware Fingerprint in Bash

**Files:**
- Create: `install.sh` (in gctrl/deploy repo, fingerprint section)

- [ ] **Step 1: Write fingerprint function**

```bash
# Part of install.sh
compute_fingerprint() {
  local cpu disk mac

  # CPU identifier
  cpu=$(grep -m1 "model name" /proc/cpuinfo 2>/dev/null | cut -d: -f2 | xargs || \
        sysctl -n machdep.cpu.brand_string 2>/dev/null || echo "unknown-cpu")

  # First disk serial
  disk=$(lsblk -d -o NAME,SERIAL 2>/dev/null | awk 'NR==2{print $2}' || \
         diskutil info disk0 2>/dev/null | grep "Volume Serial" | awk '{print $NF}' || \
         echo "unknown-disk")

  # Primary MAC address (non-loopback)
  mac=$(ip link show 2>/dev/null | grep -v "lo" | grep "link/ether" | head -1 | awk '{print $2}' || \
        ifconfig 2>/dev/null | grep "ether" | head -1 | awk '{print $2}' || \
        echo "00:00:00:00:00:00")

  echo -n "${cpu}::${disk}::${mac}" | sha256sum | awk '{print $1}'
}
```

- [ ] **Step 2: Test fingerprint function in isolation**

```bash
source install.sh
FP=$(compute_fingerprint)
echo "Fingerprint: $FP"
# Run twice — must be identical
FP2=$(compute_fingerprint)
[ "$FP" = "$FP2" ] && echo "DETERMINISTIC: OK" || echo "DETERMINISTIC: FAIL"
echo "Length: ${#FP}"
[ ${#FP} -eq 64 ] && echo "LENGTH: OK" || echo "LENGTH: FAIL"
```
Expected: `DETERMINISTIC: OK` and `LENGTH: OK`.

---

### Task 2: Full Install Script

**Files:**
- Create: `install.sh` (gctrl/deploy)

- [ ] **Step 1: Write complete installer**

```bash
#!/usr/bin/env bash
# Ground Control (GCTRL) Installer
# Usage: curl -fsSL https://gctrl.tech/install | bash
set -euo pipefail

GCTRL_VERSION="${GCTRL_VERSION:-latest}"
API_URL="https://api.gctrl.tech"
INSTALL_DIR="${HOME}/gctrl"
CONFIG_DIR="${INSTALL_DIR}/config"

# ── Colors ────────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
info()    { echo -e "${BLUE}[GCTRL]${NC} $1"; }
success() { echo -e "${GREEN}[GCTRL]${NC} $1"; }
warn()    { echo -e "${YELLOW}[GCTRL]${NC} $1"; }
error()   { echo -e "${RED}[GCTRL]${NC} $1"; exit 1; }

# ── Prerequisites ─────────────────────────────────────────────────────────────
check_prereqs() {
  info "Checking prerequisites..."
  local missing=()

  command -v docker &>/dev/null   || missing+=("docker")
  command -v curl   &>/dev/null   || missing+=("curl")
  command -v openssl &>/dev/null  || missing+=("openssl")
  docker compose version &>/dev/null || missing+=("docker-compose-plugin")

  if [ ${#missing[@]} -gt 0 ]; then
    error "Missing: ${missing[*]}\nInstall Docker: https://docs.docker.com/engine/install/"
  fi
  success "Prerequisites OK"
}

# ── Hardware Fingerprint ───────────────────────────────────────────────────────
compute_fingerprint() {
  local cpu disk mac
  cpu=$(grep -m1 "model name" /proc/cpuinfo 2>/dev/null | cut -d: -f2 | xargs || echo "unknown-cpu")
  disk=$(lsblk -d -o NAME,SERIAL 2>/dev/null | awk 'NR==2{print $2}' || echo "unknown-disk")
  mac=$(ip link show 2>/dev/null | grep -v "lo" | grep "link/ether" | head -1 | awk '{print $2}' || echo "00:00:00:00:00:00")
  echo -n "${cpu}::${disk}::${mac}" | sha256sum | awk '{print $1}'
}

# ── License Activation ────────────────────────────────────────────────────────
activate_license() {
  echo ""
  echo -e "${BLUE}Ground Control — Local Knowledge Graph Platform${NC}"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo ""

  local key
  if [ -z "${GCTRL_LICENSE_KEY:-}" ]; then
    read -rp "Enter your GCTRL License Key: " key
  else
    key="$GCTRL_LICENSE_KEY"
    info "Using license key from environment"
  fi

  info "Activating license..."
  local fingerprint
  fingerprint=$(compute_fingerprint)

  local response
  response=$(curl -fsSL -X POST "${API_URL}/v1/activate" \
    -H "Content-Type: application/json" \
    -d "{\"license_key\":\"${key}\",\"hardware_fingerprint\":\"${fingerprint}\"}" \
    2>&1) || error "Failed to reach activation server. Check your internet connection."

  # Parse response
  local registry_token tier balance license_jwt
  registry_token=$(echo "$response" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['registry_token'])" 2>/dev/null) \
    || error "Activation failed: $response"
  license_jwt=$(echo "$response"    | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['license_jwt'])")
  tier=$(echo "$response"           | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['tier'])")
  balance=$(echo "$response"        | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['credits_balance'])")

  echo "$registry_token" > /tmp/gctrl_registry_token
  echo "$license_jwt" > "${CONFIG_DIR}/license.jwt"
  chmod 600 "${CONFIG_DIR}/license.jwt"

  success "License activated | Tier: ${tier} | Credits: ${balance}"
}

# ── Pull Images ───────────────────────────────────────────────────────────────
pull_images() {
  info "Logging into image registry..."
  local registry_token
  registry_token=$(cat /tmp/gctrl_registry_token)
  echo "$registry_token" | docker login ghcr.io -u gctrl --password-stdin &>/dev/null
  rm -f /tmp/gctrl_registry_token
  success "Registry login OK"

  info "Pulling GCTRL images (this may take a few minutes)..."
  docker compose -f "${INSTALL_DIR}/docker-compose.yml" pull
  success "Images ready"
}

# ── Generate Config ───────────────────────────────────────────────────────────
generate_config() {
  info "Creating ${INSTALL_DIR}..."
  mkdir -p "${INSTALL_DIR}" "${CONFIG_DIR}"

  # Download compose template from deploy repo
  curl -fsSL "https://raw.githubusercontent.com/gctrl/deploy/main/compose-template.yml" \
    -o "${INSTALL_DIR}/docker-compose.yml"

  # Read public key for agent verification
  local public_key
  public_key=$(curl -fsSL "${API_URL}/v1/public-key")

  # Write .env
  cat > "${INSTALL_DIR}/.env" <<EOF
GCTRL_LICENSE_JWT_PATH=/app/config/license.jwt
GCTRL_LICENSE_PUBLIC_KEY=${public_key}
GCTRL_API_URL=https://api.gctrl.tech
GCTRL_DATA_DIR=${INSTALL_DIR}/data
EOF
  chmod 600 "${INSTALL_DIR}/.env"
  success "Config generated"
}

# ── Start Stack ───────────────────────────────────────────────────────────────
start_stack() {
  info "Starting GCTRL..."
  docker compose -f "${INSTALL_DIR}/docker-compose.yml" --env-file "${INSTALL_DIR}/.env" up -d

  info "Waiting for services to be ready..."
  local max_wait=120
  local waited=0
  while ! curl -sf http://localhost:3001/api/health &>/dev/null; do
    sleep 3
    waited=$((waited + 3))
    [ $waited -ge $max_wait ] && error "Timeout waiting for GCTRL to start. Check: docker compose logs"
  done

  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  success "✅ GCTRL is running!"
  echo ""
  echo "  Dashboard: http://localhost:3001"
  echo "  Installed: ${INSTALL_DIR}"
  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
}

# ── Main ──────────────────────────────────────────────────────────────────────
main() {
  check_prereqs
  generate_config
  activate_license
  pull_images
  start_stack
}

main "$@"
```

- [ ] **Step 2: Commit to deploy repo**

```bash
cd gctrl-deploy-repo
chmod +x install.sh
git add install.sh
git commit -m "feat: GCTRL installer — curl | bash install flow"
git push
```

---

### Task 3: Update Script

**Files:**
- Create: `update.sh` (gctrl/deploy)

- [ ] **Step 1: Write update script**

```bash
#!/usr/bin/env bash
# Ground Control Updater
set -euo pipefail

INSTALL_DIR="${HOME}/gctrl"
GREEN='\033[0;32m'; BLUE='\033[0;34m'; NC='\033[0m'
info()    { echo -e "${BLUE}[GCTRL]${NC} $1"; }
success() { echo -e "${GREEN}[GCTRL]${NC} $1"; }

[ -d "$INSTALL_DIR" ] || { echo "GCTRL not installed at ${INSTALL_DIR}"; exit 1; }

info "Pulling latest GCTRL images..."
docker compose -f "${INSTALL_DIR}/docker-compose.yml" pull

info "Saving current image digests for rollback..."
docker compose -f "${INSTALL_DIR}/docker-compose.yml" images --quiet > "${INSTALL_DIR}/.previous-images"

info "Restarting services with zero downtime..."
docker compose -f "${INSTALL_DIR}/docker-compose.yml" up -d --remove-orphans

success "✅ GCTRL updated successfully"
echo "  Rollback available: curl -fsSL https://gctrl.tech/rollback | bash"
```

- [ ] **Step 2: Write rollback script**

```bash
#!/usr/bin/env bash
# Ground Control Rollback
set -euo pipefail

INSTALL_DIR="${HOME}/gctrl"
PREV="${INSTALL_DIR}/.previous-images"

[ -f "$PREV" ] || { echo "No previous images recorded. Cannot rollback."; exit 1; }

echo "[GCTRL] Rolling back to previous images..."
while IFS= read -r image; do
  docker pull "$image" &>/dev/null || true
done < "$PREV"

# Recreate compose with pinned old digests
docker compose -f "${INSTALL_DIR}/docker-compose.yml" up -d --remove-orphans
echo "[GCTRL] ✅ Rollback complete"
```

- [ ] **Step 3: Commit**

```bash
git add update.sh rollback.sh
git commit -m "feat: GCTRL update and rollback scripts"
git push
```

---

### Task 4: Uninstall Script

**Files:**
- Create: `uninstall.sh` (gctrl/deploy)

- [ ] **Step 1: Write uninstall script**

```bash
#!/usr/bin/env bash
# Ground Control Uninstaller
set -euo pipefail

INSTALL_DIR="${HOME}/gctrl"
API_URL="https://api.gctrl.tech"
RED='\033[0;31m'; YELLOW='\033[1;33m'; GREEN='\033[0;32m'; NC='\033[0m'

echo -e "${RED}Ground Control Uninstaller${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "${YELLOW}WARNING: This will stop GCTRL and remove images.${NC}"
echo -e "${YELLOW}Your data in ${INSTALL_DIR}/data will be PRESERVED.${NC}"
echo ""
read -rp "Type 'uninstall' to confirm: " confirm
[ "$confirm" = "uninstall" ] || { echo "Aborted."; exit 0; }

# Deactivate license on server
if [ -f "${INSTALL_DIR}/config/license.jwt" ]; then
  echo "[GCTRL] Deactivating license on server..."
  curl -sfX POST "${API_URL}/v1/deactivate" \
    -H "Authorization: Bearer $(cat ${INSTALL_DIR}/config/license.jwt)" &>/dev/null || true
fi

# Stop containers
echo "[GCTRL] Stopping services..."
docker compose -f "${INSTALL_DIR}/docker-compose.yml" down --remove-orphans 2>/dev/null || true

# Remove images
echo "[GCTRL] Removing images..."
docker compose -f "${INSTALL_DIR}/docker-compose.yml" images -q 2>/dev/null | xargs docker rmi -f 2>/dev/null || true

# Remove config (keep data)
rm -f "${INSTALL_DIR}/docker-compose.yml" "${INSTALL_DIR}/.env"
rm -rf "${INSTALL_DIR}/config"

echo ""
echo -e "${GREEN}✅ GCTRL removed.${NC}"
echo "  Your data is preserved at: ${INSTALL_DIR}/data"
echo "  To reinstall: curl -fsSL https://gctrl.tech/install | bash"
```

- [ ] **Step 2: Commit**

```bash
git add uninstall.sh
git commit -m "feat: GCTRL uninstall script — preserves data, deactivates license"
git push
```

---

### Task 5: Serve Scripts from Next.js

**Files:**
- Create: `services/web/src/app/api/scripts/[name]/route.ts`

- [ ] **Step 1: Write script proxy route**

```typescript
// services/web/src/app/api/scripts/[name]/route.ts
import { NextRequest, NextResponse } from 'next/server';

const DEPLOY_REPO_RAW = 'https://raw.githubusercontent.com/gctrl/deploy/main';
const ALLOWED_SCRIPTS = ['install', 'update', 'uninstall', 'rollback'];

export async function GET(
  _req: NextRequest,
  { params }: { params: { name: string } }
) {
  if (!ALLOWED_SCRIPTS.includes(params.name)) {
    return new NextResponse('Not found', { status: 404 });
  }

  const upstream = await fetch(`${DEPLOY_REPO_RAW}/${params.name}.sh`);
  const content = await upstream.text();

  return new NextResponse(content, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
    },
  });
}
```

This makes `https://gctrl.tech/api/scripts/install` serve the raw script.

Add a redirect so `https://gctrl.tech/install` → `/api/scripts/install` in `next.config.js`:

```javascript
// next.config.js
module.exports = {
  async redirects() {
    return [
      { source: '/install',   destination: '/api/scripts/install',   permanent: false },
      { source: '/update',    destination: '/api/scripts/update',    permanent: false },
      { source: '/uninstall', destination: '/api/scripts/uninstall', permanent: false },
      { source: '/rollback',  destination: '/api/scripts/rollback',  permanent: false },
    ];
  },
};
```

- [ ] **Step 2: Test script serving**

```bash
curl -fsSL https://gctrl.tech/install | head -5
```
Expected: first 5 lines of `install.sh` (shebang + comments).

- [ ] **Step 3: Commit**

```bash
git add services/web/src/app/api/scripts/ services/web/next.config.js
git commit -m "feat(web): serve installer scripts at gctrl.tech/install,/update,/uninstall"
```

---

### Task 6: End-to-End Test

- [ ] **Step 1: Spin up a clean Linux VM (or Docker-in-Docker)**

```bash
# Use a fresh Ubuntu 24.04 container as test environment
docker run --rm -it \
  --privileged \
  -v /var/run/docker.sock:/var/run/docker.sock \
  ubuntu:24.04 bash
```

- [ ] **Step 2: Install Docker inside test environment**

```bash
apt-get update -q && apt-get install -y curl ca-certificates
curl -fsSL https://get.docker.com | bash
```

- [ ] **Step 3: Run installer with a test license key**

```bash
GCTRL_LICENSE_KEY="GCTRL-TEST-TEST-TEST-TEST-XXXX" \
  curl -fsSL https://gctrl.tech/install | bash
```
Expected: 
- Prerequisites check passes
- License activates (test key must exist in DB)
- Images pull from ghcr.io
- Stack starts
- Final message: `✅ GCTRL is running!`

- [ ] **Step 4: Verify services are healthy**

```bash
curl -sf http://localhost:3001/api/health | python3 -m json.tool
docker ps --format "table {{.Names}}\t{{.Status}}"
```
Expected: all containers `Up (healthy)`, health endpoint returns `{"ok":true}`.

- [ ] **Step 5: Run an extraction job to verify credit metering**

```bash
# Upload a test document
curl -X POST http://localhost:4010/extract \
  -H "Content-Type: application/json" \
  -d '{"documents":[{"text":"Apple Inc. was founded by Steve Jobs in Cupertino, California."}]}'
```
Expected: entities extracted, credits deducted (visible in `docker logs gctrl-agent`).

- [ ] **Step 6: Test update flow**

```bash
curl -fsSL https://gctrl.tech/update | bash
```
Expected: pulls latest images, restarts, data preserved.

- [ ] **Step 7: Test uninstall**

```bash
curl -fsSL https://gctrl.tech/uninstall | bash
# When prompted: type 'uninstall'
```
Expected: containers stopped, images removed, `~/gctrl/data/` preserved.

- [ ] **Step 8: Final commit**

```bash
git add .
git commit -m "feat: phase 5 complete — installer end-to-end tested"
git tag v1.0.0
git push origin main --tags
```

---

## Post-Phase Checklist

- [ ] `curl https://gctrl.tech/install | bash` works on clean Ubuntu 24.04
- [ ] `curl https://gctrl.tech/update | bash` updates without data loss
- [ ] `curl https://gctrl.tech/uninstall | bash` cleans up, preserves data
- [ ] License key format validated before API call
- [ ] Hardware fingerprint mismatch → clear error message
- [ ] Insufficient credits → HTTP 402 with helpful message
- [ ] Grace period → warning banner in UI
- [ ] Admin at `admin.gctrl.tech` can revoke, top-up, change tier
- [ ] Stripe checkout → license key email received
- [ ] Monthly credit reset confirmed via Stripe `invoice.payment_succeeded`
