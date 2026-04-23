#!/usr/bin/env bash
# Ground Control Uninstaller
# Usage: curl -fsSL https://gctrl.tech/uninstall | bash
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

# Deactivate license on server (best-effort)
if [ -f "${INSTALL_DIR}/config/license.jwt" ]; then
  echo "[GCTRL] Deactivating license on server..."
  curl -sfX POST "${API_URL}/v1/deactivate" \
    -H "Authorization: Bearer $(cat "${INSTALL_DIR}/config/license.jwt")" &>/dev/null || true
fi

# Stop containers
echo "[GCTRL] Stopping services..."
docker compose -f "${INSTALL_DIR}/docker-compose.yml" down --remove-orphans 2>/dev/null || true

# Remove images
echo "[GCTRL] Removing images..."
docker compose -f "${INSTALL_DIR}/docker-compose.yml" images -q 2>/dev/null \
  | xargs docker rmi -f 2>/dev/null || true

# Remove config (preserve data)
rm -f  "${INSTALL_DIR}/docker-compose.yml" "${INSTALL_DIR}/.env" "${INSTALL_DIR}/.previous-images"
rm -rf "${INSTALL_DIR}/config"

echo ""
echo -e "${GREEN}✅ GCTRL removed.${NC}"
echo "  Your data is preserved at: ${INSTALL_DIR}/data"
echo "  To reinstall: curl -fsSL https://gctrl.tech/install | bash"
