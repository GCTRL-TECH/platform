#!/usr/bin/env bash
# Ground Control Updater
# Usage: curl -fsSL https://gctrl.tech/update | bash
set -euo pipefail

INSTALL_DIR="${HOME}/gctrl"
GREEN='\033[0;32m'; BLUE='\033[0;34m'; NC='\033[0m'
info()    { echo -e "${BLUE}[GCTRL]${NC} $1"; }
success() { echo -e "${GREEN}[GCTRL]${NC} $1"; }

[ -d "$INSTALL_DIR" ] || { echo "GCTRL not installed at ${INSTALL_DIR}. Run the installer first."; exit 1; }

# ── Rollback record ───────────────────────────────────────────────────────────
# Writes what to roll back TO, as PULLABLE references (repo@sha256:...).
#
# This has to be a digest: the older version of this script recorded
# `docker compose images --quiet` output, which is image IDs, and rollback.sh
# then ran `docker pull <id>` - an ID is not a pullable reference, so it failed,
# silently (|| true), and the rollback quietly did nothing. Digests are also what
# lets the cleanup below reclaim old images at all: rollback no longer depends on
# them still being on disk, it re-pulls them.
#
# Containers are listed by NAME rather than through `docker compose ps`: the
# in-app updater recreates containers through the Docker API without copying
# compose's labels, after which compose no longer recognises them as members of
# the project.
record_previous_images() {
  local cids tmp="${INSTALL_DIR}/.previous-images.tmp"

  cids=$(docker ps -aq --filter "name=^gctrl-") || return 0
  [ -n "$cids" ] || return 0

  # shellcheck disable=SC2086  # deliberate word splitting over container ids
  docker inspect -f '{{.Image}}' $cids 2>/dev/null | sort -u \
    | xargs -r docker image inspect -f '{{if .RepoDigests}}{{index .RepoDigests 0}}{{end}}' 2>/dev/null \
    | grep -E '@sha256:' > "$tmp" || true

  # Only replace a usable record with another usable one - never clobber a good
  # rollback target with an empty file.
  if [ -s "$tmp" ]; then
    mv "$tmp" "${INSTALL_DIR}/.previous-images"
  else
    rm -f "$tmp"
  fi
  return 0
}

# ── Superseded-image cleanup ──────────────────────────────────────────────────
# Every GCTRL image ships under a floating :latest tag, so each pull moves the
# tag to the new image and strands the previous one on disk - untagged, unused
# and, until now, forever. On a long-lived install that grew without bound.
#
# Only images belonging to a repo GCTRL publishes are ever considered, and only
# when no container - running OR stopped - still references them. A blanket
# `docker image prune` is deliberately NOT used: this host may run unrelated
# stacks (n8n, Traefik, other compose projects) whose dangling images it would
# collect too, which would be an unrecoverable surprise.
#
# Attribution still works after the tag has moved because the superseded image
# keeps its ghcr.io/gctrl-tech/<svc>@sha256:... digest reference.
#
# Set GCTRL_KEEP_OLD_IMAGES=1 to disable (an air-gapped host can only roll back
# to images it still has locally).
GCTRL_OWNED_REPOS='ghcr\.io/gctrl-tech/(agent|api|web|kex|fuse|fusion-engine)[:@]'

cleanup_superseded_images() {
  if [ "${GCTRL_KEEP_OLD_IMAGES:-0}" = "1" ]; then
    return 0
  fi

  local ids in_use candidates removed=0
  ids=$(docker images -q | sort -u) || return 0
  [ -n "$ids" ] || return 0

  # Images pinned by a container. Stopped ones count: a `docker start` would
  # boot straight back onto that image.
  in_use=$(docker ps -aq | xargs -r docker inspect -f '{{.Image}}' 2>/dev/null | sort -u) || true

  # shellcheck disable=SC2086  # deliberate word splitting: one inspect for all ids
  candidates=$(docker image inspect $ids \
      --format '{{.Id}} {{join .RepoTags ","}} {{join .RepoDigests ","}}' 2>/dev/null \
    | grep -E "$GCTRL_OWNED_REPOS" | awk '{print $1}') || true

  for id in $candidates; do
    if echo "$in_use" | grep -qx "$id"; then
      continue
    fi
    # No -f on purpose: dockerd then refuses to remove an image that is still
    # referenced, or one carrying several repository references (so a locally
    # pinned :v0.1.x tag survives instead of being silently untagged).
    if docker rmi "$id" >/dev/null 2>&1; then
      removed=$((removed + 1))
    fi
  done

  if [ "$removed" -gt 0 ]; then
    info "Removed $removed superseded image(s)."
  fi
  return 0
}

info "Recording current image digests for rollback..."
record_previous_images

# Reclaim what the PREVIOUS update superseded before pulling several GB. Running
# it here rather than only at the end frees the disk at the moment it is about to
# be needed - an update dying halfway through on a full disk is the failure this
# prevents. Everything still in use is skipped, so the running version is never
# at risk.
cleanup_superseded_images

info "Pulling latest GCTRL images..."
docker compose -f "${INSTALL_DIR}/docker-compose.yml" pull

info "Restarting with new images..."
docker compose -f "${INSTALL_DIR}/docker-compose.yml" --env-file "${INSTALL_DIR}/.env" up -d --remove-orphans

# Containers are on their new images now, so the generation just replaced is
# unreferenced and goes immediately instead of lingering until the next update.
cleanup_superseded_images

success "✅ GCTRL updated successfully"
echo "  Rollback: curl -fsSL https://gctrl.tech/rollback | bash"
