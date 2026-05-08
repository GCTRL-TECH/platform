#!/usr/bin/env bash
# Resets the local GCTRL Docker stack to a clean state.
# WARNING: This wipes all volumes — database data will be lost.
# Usage: ./scripts/dev-reset.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

echo ""
echo -e "${BOLD}${CYAN}GCTRL Stack Reset${NC}"
echo -e "============================================"
echo -e "${YELLOW}WARNING: This will destroy all local data (volumes will be removed).${NC}"
echo ""

# ── confirm unless CI/non-interactive ────────────────────────────────────────
if [ -t 0 ] && [ "${CI:-}" != "true" ]; then
  read -r -p "Proceed? [y/N] " CONFIRM
  if [[ ! "$CONFIRM" =~ ^[Yy]$ ]]; then
    echo "Aborted."
    exit 0
  fi
fi

# ── step 1: tear down ─────────────────────────────────────────────────────────
echo ""
echo -e "${CYAN}[1/3] Tearing down stack (removing volumes)...${NC}"
cd "$PROJECT_ROOT"
docker compose down -v
echo -e "${GREEN}Stack stopped and volumes removed.${NC}"

# ── step 2: bring up fresh ────────────────────────────────────────────────────
echo ""
echo -e "${CYAN}[2/3] Starting fresh stack...${NC}"
docker compose up -d
echo -e "${GREEN}Stack started.${NC}"

# ── step 3: wait for health ───────────────────────────────────────────────────
echo ""
echo -e "${CYAN}[3/3] Waiting for all services to become healthy...${NC}"
"${SCRIPT_DIR}/wait-for-stack.sh" "${1:-180}"

echo ""
echo -e "${GREEN}${BOLD}Stack reset complete. Ready for development.${NC}"
echo ""
