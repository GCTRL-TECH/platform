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

  command -v docker  &>/dev/null || missing+=("docker")
  command -v curl    &>/dev/null || missing+=("curl")
  command -v openssl &>/dev/null || missing+=("openssl")
  docker compose version &>/dev/null || missing+=("docker-compose-plugin")

  if [ ${#missing[@]} -gt 0 ]; then
    error "Missing: ${missing[*]}\nInstall Docker: https://docs.docker.com/engine/install/"
  fi
  success "Prerequisites OK"
}

# ── Hardware Fingerprint ───────────────────────────────────────────────────────
compute_fingerprint() {
  local cpu disk mac
  cpu=$(grep -m1 "model name" /proc/cpuinfo 2>/dev/null | cut -d: -f2 | xargs || \
        sysctl -n machdep.cpu.brand_string 2>/dev/null || echo "unknown-cpu")
  disk=$(lsblk -d -o NAME,SERIAL 2>/dev/null | awk 'NR==2{print $2}' || \
         diskutil info disk0 2>/dev/null | grep "Volume Serial" | awk '{print $NF}' || \
         echo "unknown-disk")
  mac=$(ip link show 2>/dev/null | grep -v "lo" | grep "link/ether" | head -1 | awk '{print $2}' || \
        ifconfig 2>/dev/null | grep "ether" | head -1 | awk '{print $2}' || \
        echo "00:00:00:00:00:00")
  printf '%s' "${cpu}::${disk}::${mac}" | sha256sum | awk '{print $1}'
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

  info "Computing hardware fingerprint..."
  local fingerprint
  fingerprint=$(compute_fingerprint)

  info "Activating license..."
  local response
  response=$(curl -fsSL -X POST "${API_URL}/v1/activate" \
    -H "Content-Type: application/json" \
    -d "{\"license_key\":\"${key}\",\"hardware_fingerprint\":\"${fingerprint}\"}" \
    2>&1) || error "Failed to reach activation server. Check your internet connection."

  # Extract fields with jq if available, else python3
  local registry_token tier balance license_jwt
  if command -v jq &>/dev/null; then
    registry_token=$(echo "$response" | jq -r '.registry_token') || error "Activation failed: $response"
    license_jwt=$(echo "$response"    | jq -r '.license_jwt')
    tier=$(echo "$response"           | jq -r '.tier')
    balance=$(echo "$response"        | jq -r '.credits_balance')
  elif command -v python3 &>/dev/null; then
    registry_token=$(echo "$response" | python3 -c "import sys,json; print(json.load(sys.stdin)['registry_token'])") \
      || error "Activation failed: $response"
    license_jwt=$(echo "$response"    | python3 -c "import sys,json; print(json.load(sys.stdin)['license_jwt'])")
    tier=$(echo "$response"           | python3 -c "import sys,json; print(json.load(sys.stdin)['tier'])")
    balance=$(echo "$response"        | python3 -c "import sys,json; print(json.load(sys.stdin)['credits_balance'])")
  else
    error "jq or python3 required for JSON parsing. Install one and retry."
  fi

  printf '%s' "$registry_token" > /tmp/gctrl_registry_token
  printf '%s' "$license_jwt"    > "${CONFIG_DIR}/license.jwt"
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
  mkdir -p "${INSTALL_DIR}" "${CONFIG_DIR}" "${INSTALL_DIR}/data"

  # Download compose template
  curl -fsSL "https://raw.githubusercontent.com/gctrl/deploy/main/compose-template.yml" \
    -o "${INSTALL_DIR}/docker-compose.yml"

  # Fetch RS256 public key from server
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

  info "Waiting for services to be ready (up to 120s)..."
  local max_wait=120 waited=0
  while ! curl -sf http://localhost:3001/api/health &>/dev/null; do
    sleep 3
    waited=$((waited + 3))
    [ $waited -ge $max_wait ] && error "Timeout. Check: docker compose -f ${INSTALL_DIR}/docker-compose.yml logs"
  done

  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  success "✅ GCTRL is running!"
  echo ""
  echo "  Dashboard : http://localhost:3001"
  echo "  Installed : ${INSTALL_DIR}"
  echo "  To update : curl -fsSL https://gctrl.tech/update | bash"
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
