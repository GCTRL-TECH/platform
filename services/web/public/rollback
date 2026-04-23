#!/usr/bin/env bash
# Ground Control Rollback
# Usage: curl -fsSL https://gctrl.tech/rollback | bash
set -euo pipefail

INSTALL_DIR="${HOME}/gctrl"
PREV="${INSTALL_DIR}/.previous-images"

[ -f "$PREV" ] || { echo "[GCTRL] No previous images recorded. Cannot rollback."; exit 1; }

echo "[GCTRL] Rolling back to previous images..."
while IFS= read -r image; do
  [ -n "$image" ] && docker pull "$image" &>/dev/null || true
done < "$PREV"

docker compose -f "${INSTALL_DIR}/docker-compose.yml" --env-file "${INSTALL_DIR}/.env" up -d --remove-orphans

echo "[GCTRL] ✅ Rollback complete"
