#!/usr/bin/env bash
#
# Wrapper for scripts/migrate-rdf-namespace.cypher.
#
# Runs the namespace rewrite inside the running neo4j container using
# cypher-shell with sensible Ground Control defaults. The cypher script
# itself is idempotent — re-runs are safe.
#
# Environment overrides:
#   NEO4J_CONTAINER   container name           (default: neo4j)
#   NEO4J_USER        neo4j username           (default: neo4j)
#   NEO4J_PASSWORD    neo4j password           (default: password)
#   OLD_NS            legacy namespace         (default: http://borghive.dev/entity/)
#   NEW_NS            target namespace         (default: http://gctrl.tech/entity/)
#
# IMPORTANT: take a Neo4j backup before running. To roll back, re-run
# with OLD_NS and NEW_NS swapped.

set -euo pipefail

NEO4J_CONTAINER="${NEO4J_CONTAINER:-neo4j}"
NEO4J_USER="${NEO4J_USER:-neo4j}"
NEO4J_PASSWORD="${NEO4J_PASSWORD:-password}"
OLD_NS="${OLD_NS:-http://borghive.dev/entity/}"
NEW_NS="${NEW_NS:-http://gctrl.tech/entity/}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CYPHER_FILE="${SCRIPT_DIR}/migrate-rdf-namespace.cypher"

if [[ ! -f "${CYPHER_FILE}" ]]; then
  echo "error: cypher file not found: ${CYPHER_FILE}" >&2
  exit 1
fi

echo "[migrate-rdf-namespace] rewriting URIs"
echo "  container : ${NEO4J_CONTAINER}"
echo "  old_ns    : ${OLD_NS}"
echo "  new_ns    : ${NEW_NS}"
echo

# Copy the cypher file into the container then execute via cypher-shell.
# Using `docker cp` keeps the script self-contained and avoids relying on
# a bind mount being present at /scripts.
TMP_PATH="/tmp/migrate-rdf-namespace.cypher"
docker cp "${CYPHER_FILE}" "${NEO4J_CONTAINER}:${TMP_PATH}"

# Inline parameter overrides so the user's OLD_NS / NEW_NS env vars take
# effect even when they differ from the defaults baked into the file.
docker exec -i "${NEO4J_CONTAINER}" cypher-shell \
  -u "${NEO4J_USER}" -p "${NEO4J_PASSWORD}" \
  --param "old_ns => '${OLD_NS}'" \
  --param "new_ns => '${NEW_NS}'" \
  -f "${TMP_PATH}"

echo
echo "[migrate-rdf-namespace] done. verify with:"
echo "  MATCH (n:Entity) WHERE n.uri STARTS WITH '${OLD_NS}' RETURN count(n);"
