#!/usr/bin/env bash
# Waits until all GCTRL services are healthy or times out after MAX_WAIT seconds.
# Usage: ./scripts/wait-for-stack.sh [max_wait_seconds]
# Exit 0: all services up
# Exit 1: timeout
set -euo pipefail

MAX_WAIT="${1:-180}"
INTERVAL=5

# ── colour helpers ────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Colour

# ── service map (name → health URL) ──────────────────────────────────────────
declare -A SERVICES=(
  ["API"]="http://localhost:4000/api/health"
  ["KEX"]="http://localhost:4010/health"
  ["Agent"]="http://localhost:7070/status"
  ["Web UI"]="http://localhost:3001"
)

# Ordered list so output is deterministic
SERVICE_NAMES=("API" "KEX" "Agent" "Web UI")

# ── helpers ───────────────────────────────────────────────────────────────────
check_service() {
  local url="$1"
  curl -sf --max-time 3 "$url" > /dev/null 2>&1
}

all_healthy() {
  for name in "${SERVICE_NAMES[@]}"; do
    check_service "${SERVICES[$name]}" || return 1
  done
  return 0
}

# ── main loop ─────────────────────────────────────────────────────────────────
echo -e "${CYAN}Waiting for GCTRL stack (timeout: ${MAX_WAIT}s)...${NC}"
echo ""

elapsed=0
while true; do
  waiting=()
  ready=()

  for name in "${SERVICE_NAMES[@]}"; do
    if check_service "${SERVICES[$name]}"; then
      ready+=("$name")
    else
      waiting+=("$name")
    fi
  done

  if [ ${#waiting[@]} -eq 0 ]; then
    echo -e "${GREEN}All services ready.${NC}"
    echo ""
    for name in "${SERVICE_NAMES[@]}"; do
      echo -e "  ${GREEN}[READY]${NC} ${name} → ${SERVICES[$name]}"
    done
    echo ""
    exit 0
  fi

  # Print waiting status
  printf "\r\033[K"
  echo -ne "${YELLOW}[${elapsed}s/${MAX_WAIT}s]${NC} Waiting for:"
  for name in "${waiting[@]}"; do
    echo -ne " ${name}"
  done

  if [ ${#ready[@]} -gt 0 ]; then
    echo -ne "  |  ${GREEN}Ready:${NC}"
    for name in "${ready[@]}"; do
      echo -ne " ${name}"
    done
  fi
  echo -ne "\r"

  if [ "$elapsed" -ge "$MAX_WAIT" ]; then
    echo ""
    echo -e "${RED}Timeout after ${MAX_WAIT}s. The following services did not respond:${NC}"
    for name in "${waiting[@]}"; do
      echo -e "  ${RED}[TIMEOUT]${NC} ${name} → ${SERVICES[$name]}"
    done
    exit 1
  fi

  sleep "$INTERVAL"
  elapsed=$(( elapsed + INTERVAL ))
done
