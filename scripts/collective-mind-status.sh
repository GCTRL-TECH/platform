#!/bin/bash
# GCTRL Collective Mind - Status Check
# Shows the current state of all knowledge graphs and their refresh schedules

API_URL="http://localhost:4000"

# Login
TOKEN=$(curl -s "$API_URL/api/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@GCTRL.dev","password":"GCTRL2026!"}' \
  | grep -o '"token":"[^"]*"' | cut -d'"' -f4)

if [ -z "$TOKEN" ]; then
  echo "ERROR: Could not authenticate with GCTRL API"
  exit 1
fi

echo "============================================"
echo "  GCTRL Collective Mind - Status"
echo "  $(date +'%Y-%m-%d %H:%M:%S')"
echo "============================================"
echo ""

# Get all compilations
COMPILATIONS=$(curl -s "$API_URL/api/kg/compilations" \
  -H "Authorization: Bearer $TOKEN")

echo "$COMPILATIONS" | python3 -c "
import json, sys
data = json.load(sys.stdin)
comps = data.get('compilations', [])
for c in comps:
    name = c.get('name', 'Unknown')
    schedule = c.get('cronSchedule', 'none')
    mode = c.get('cronMode', '-')
    nodes = c.get('nodeCount', 0)
    edges = c.get('edgeCount', 0)
    entities = c.get('entityCount', 0)
    last_refresh = c.get('lastRefreshAt', 'never')
    cid = c.get('id', '')[:8]
    print(f'  [{cid}] {name}')
    print(f'    Nodes: {nodes} | Edges: {edges} | Entities: {entities}')
    print(f'    Schedule: {schedule} ({mode}) | Last refresh: {last_refresh}')
    print()
" 2>/dev/null || echo "$COMPILATIONS"

echo "============================================"
echo "  Scheduler running inside GCTRL-api"
echo "  Collective Mind refreshes every minute"
echo "  Agent graphs refresh every 5 minutes"
echo "============================================"

