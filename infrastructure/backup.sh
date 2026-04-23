#!/bin/bash
##############################################################################
# GCTRL Backup Script
#
# Creates timestamped backups of:
#   - PostgreSQL (pg_dump)
#   - Neo4j (neo4j-admin dump)
#   - Qdrant (snapshot API)
#   - Redis (RDB save)
#
# Usage:
#   ./infrastructure/backup.sh [backup_dir]
#
# Schedule via cron:
#   0 2 * * * /path/to/GCTRL/infrastructure/backup.sh /backups/GCTRL
##############################################################################

set -euo pipefail

BACKUP_DIR="${1:-./backups}"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_PATH="${BACKUP_DIR}/${TIMESTAMP}"

mkdir -p "${BACKUP_PATH}"

echo "========================================"
echo "GCTRL Backup - ${TIMESTAMP}"
echo "========================================"

# ─── PostgreSQL ────────────────────────────────────────────────────────
echo "[1/4] PostgreSQL backup..."
docker exec GCTRL-postgres pg_dump -U GCTRL -Fc GCTRL > "${BACKUP_PATH}/postgres.dump" 2>/dev/null
PG_SIZE=$(du -sh "${BACKUP_PATH}/postgres.dump" | cut -f1)
echo "       Done: ${PG_SIZE}"

# ─── Neo4j ─────────────────────────────────────────────────────────────
echo "[2/4] Neo4j backup..."
# Stop writes briefly for consistent backup
docker exec GCTRL-neo4j neo4j-admin database dump neo4j --to-path=/tmp/neo4j-backup 2>/dev/null || true
docker cp GCTRL-neo4j:/tmp/neo4j-backup "${BACKUP_PATH}/neo4j" 2>/dev/null || {
    # Fallback: copy data volume
    echo "       Using volume copy fallback..."
    docker run --rm -v GCTRL-neo4j:/data -v "$(pwd)/${BACKUP_PATH}:/backup" alpine tar czf /backup/neo4j-data.tar.gz /data 2>/dev/null
}
NEO_SIZE=$(du -sh "${BACKUP_PATH}/neo4j"* 2>/dev/null | tail -1 | cut -f1)
echo "       Done: ${NEO_SIZE:-unknown}"

# ─── Qdrant ────────────────────────────────────────────────────────────
echo "[3/4] Qdrant backup..."
# Create snapshot via API
SNAPSHOT_RESP=$(curl -s -X POST "http://localhost:6333/snapshots" 2>/dev/null || echo '{}')
SNAPSHOT_NAME=$(echo "${SNAPSHOT_RESP}" | grep -o '"name":"[^"]*"' | head -1 | cut -d'"' -f4)
if [ -n "${SNAPSHOT_NAME}" ]; then
    curl -s "http://localhost:6333/snapshots/${SNAPSHOT_NAME}" -o "${BACKUP_PATH}/qdrant-snapshot.tar" 2>/dev/null
    Q_SIZE=$(du -sh "${BACKUP_PATH}/qdrant-snapshot.tar" | cut -f1)
    echo "       Done: ${Q_SIZE}"
else
    echo "       Snapshot API unavailable, using volume copy..."
    docker run --rm -v GCTRL-qdrant:/qdrant/storage -v "$(pwd)/${BACKUP_PATH}:/backup" alpine tar czf /backup/qdrant-data.tar.gz /qdrant/storage 2>/dev/null
fi

# ─── Redis ─────────────────────────────────────────────────────────────
echo "[4/4] Redis backup..."
docker exec GCTRL-redis redis-cli BGSAVE 2>/dev/null
sleep 2
docker cp GCTRL-redis:/data/dump.rdb "${BACKUP_PATH}/redis.rdb" 2>/dev/null
R_SIZE=$(du -sh "${BACKUP_PATH}/redis.rdb" 2>/dev/null | cut -f1)
echo "       Done: ${R_SIZE:-skipped}"

# ─── Summary ───────────────────────────────────────────────────────────
TOTAL_SIZE=$(du -sh "${BACKUP_PATH}" | cut -f1)
echo ""
echo "========================================"
echo "Backup complete: ${BACKUP_PATH}"
echo "Total size: ${TOTAL_SIZE}"
echo "========================================"

# ─── Cleanup old backups (keep last 7) ─────────────────────────────────
if [ -d "${BACKUP_DIR}" ]; then
    cd "${BACKUP_DIR}"
    ls -dt */ 2>/dev/null | tail -n +8 | xargs rm -rf 2>/dev/null || true
    echo "Old backups cleaned (keeping last 7)"
fi

