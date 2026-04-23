#!/bin/bash
##############################################################################
# GCTRL Restore Script
#
# Restores from a backup created by backup.sh
#
# Usage:
#   ./infrastructure/restore.sh ./backups/20260325_020000
#
# WARNING: This will overwrite current data!
##############################################################################

set -euo pipefail

BACKUP_PATH="${1:?Usage: restore.sh <backup_directory>}"

if [ ! -d "${BACKUP_PATH}" ]; then
    echo "ERROR: Backup directory not found: ${BACKUP_PATH}"
    exit 1
fi

echo "========================================"
echo "GCTRL Restore from: ${BACKUP_PATH}"
echo "WARNING: This will overwrite current data!"
echo "========================================"
read -p "Continue? (yes/no): " CONFIRM
if [ "${CONFIRM}" != "yes" ]; then
    echo "Aborted."
    exit 0
fi

# ─── PostgreSQL ────────────────────────────────────────────────────────
if [ -f "${BACKUP_PATH}/postgres.dump" ]; then
    echo "[1/4] Restoring PostgreSQL..."
    docker exec -i GCTRL-postgres pg_restore -U GCTRL -d GCTRL --clean --if-exists < "${BACKUP_PATH}/postgres.dump" 2>/dev/null || true
    echo "       Done"
else
    echo "[1/4] PostgreSQL backup not found, skipping"
fi

# ─── Neo4j ─────────────────────────────────────────────────────────────
if [ -f "${BACKUP_PATH}/neo4j-data.tar.gz" ]; then
    echo "[2/4] Restoring Neo4j..."
    docker compose stop neo4j 2>/dev/null
    docker run --rm -v GCTRL-neo4j:/data -v "$(pwd)/${BACKUP_PATH}:/backup" alpine sh -c "rm -rf /data/* && tar xzf /backup/neo4j-data.tar.gz -C /" 2>/dev/null
    docker compose start neo4j 2>/dev/null
    echo "       Done"
else
    echo "[2/4] Neo4j backup not found, skipping"
fi

# ─── Qdrant ────────────────────────────────────────────────────────────
if [ -f "${BACKUP_PATH}/qdrant-data.tar.gz" ]; then
    echo "[3/4] Restoring Qdrant..."
    docker compose stop qdrant 2>/dev/null
    docker run --rm -v GCTRL-qdrant:/qdrant/storage -v "$(pwd)/${BACKUP_PATH}:/backup" alpine sh -c "rm -rf /qdrant/storage/* && tar xzf /backup/qdrant-data.tar.gz -C /" 2>/dev/null
    docker compose start qdrant 2>/dev/null
    echo "       Done"
else
    echo "[3/4] Qdrant backup not found, skipping"
fi

# ─── Redis ─────────────────────────────────────────────────────────────
if [ -f "${BACKUP_PATH}/redis.rdb" ]; then
    echo "[4/4] Restoring Redis..."
    docker compose stop redis 2>/dev/null
    docker cp "${BACKUP_PATH}/redis.rdb" GCTRL-redis:/data/dump.rdb 2>/dev/null
    docker compose start redis 2>/dev/null
    echo "       Done"
else
    echo "[4/4] Redis backup not found, skipping"
fi

echo ""
echo "========================================"
echo "Restore complete. Restart services:"
echo "  docker compose restart"
echo "========================================"

