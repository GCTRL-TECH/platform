#!/usr/bin/env bash
# Ground Control Updater
# Usage: curl -fsSL https://gctrl.tech/update | bash
set -euo pipefail

INSTALL_DIR="${HOME}/gctrl"
GREEN='\033[0;32m'; BLUE='\033[0;34m'; NC='\033[0m'
info()    { echo -e "${BLUE}[GCTRL]${NC} $1"; }
success() { echo -e "${GREEN}[GCTRL]${NC} $1"; }

[ -d "$INSTALL_DIR" ] || { echo "GCTRL not installed at ${INSTALL_DIR}. Run the installer first."; exit 1; }

info "Saving current image digests for rollback..."
docker compose -f "${INSTALL_DIR}/docker-compose.yml" images --quiet > "${INSTALL_DIR}/.previous-images" 2>/dev/null || true

info "Pulling latest GCTRL images..."
docker compose -f "${INSTALL_DIR}/docker-compose.yml" pull

info "Restarting with new images..."
docker compose -f "${INSTALL_DIR}/docker-compose.yml" --env-file "${INSTALL_DIR}/.env" up -d --remove-orphans

success "✅ GCTRL updated successfully"
echo "  Rollback: curl -fsSL https://gctrl.tech/rollback | bash"
