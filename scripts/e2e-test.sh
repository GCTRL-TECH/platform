#!/usr/bin/env bash
# Full end-to-end functional test for the GCTRL stack.
# Verifies every user-facing flow before declaring the platform working.
#
# Usage: ./scripts/e2e-test.sh
#
# Exit 0 on full pass. Exit non-zero with a summary on any FAIL.
# Use jq if available for fast JSON parsing; falls back to python3.

set -uo pipefail

API_BASE="${API_BASE:-http://localhost:4000/api}"
KEX_BASE="${KEX_BASE:-http://localhost:4010}"
WEB_BASE="${WEB_BASE:-http://localhost:3001}"

# Colors
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;36m'; NC='\033[0m'; BOLD='\033[1m'

# JSON tool
if command -v jq >/dev/null 2>&1; then JSON_TOOL=jq
elif command -v python3 >/dev/null 2>&1 && python3 --version >/dev/null 2>&1; then JSON_TOOL=python3
else echo -e "${RED}Need jq or python3 on PATH${NC}" >&2; exit 1; fi

jget() {
  if [ "$JSON_TOOL" = "jq" ]; then
    printf '%s' "$1" | jq -r ".$2 // empty" 2>/dev/null
  else
    python3 -c "
import sys, json
try:
    d = json.loads(sys.argv[1])
    for k in sys.argv[2].split('.'): d = d[k]
    print(d if not isinstance(d, (dict, list)) else json.dumps(d))
except Exception: print('')
" "$1" "$2"
  fi
}

jhas() {
  if [ "$JSON_TOOL" = "jq" ]; then
    printf '%s' "$1" | jq -e ".$2 != null" >/dev/null 2>&1
  else
    python3 -c "
import sys, json
try:
    d = json.loads(sys.argv[1])
    for k in sys.argv[2].split('.'): d = d[k]
    sys.exit(0 if d is not None else 1)
except Exception: sys.exit(1)
" "$1" "$2"
  fi
}

jlen() {
  if [ "$JSON_TOOL" = "jq" ]; then
    printf '%s' "$1" | jq -r ".$2 | length" 2>/dev/null || echo 0
  else
    python3 -c "
import sys, json
try:
    d = json.loads(sys.argv[1])
    for k in sys.argv[2].split('.'): d = d[k]
    print(len(d))
except Exception: print(0)
" "$1" "$2"
  fi
}

# Test counters
TOTAL=0; PASSED=0; FAILED=0
FAIL_LOG=()

pass() { echo -e "  ${GREEN}✓${NC} $1"; PASSED=$((PASSED+1)); TOTAL=$((TOTAL+1)); }
fail() { echo -e "  ${RED}✗${NC} $1"; FAILED=$((FAILED+1)); TOTAL=$((TOTAL+1)); FAIL_LOG+=("$1"); }
section() { echo ""; echo -e "${BOLD}${BLUE}━━━ $1 ━━━${NC}"; }

# Generate unique test user (rerun-friendly)
TIMESTAMP=$(date +%s%N | head -c 13)
TEST_EMAIL="e2e-${TIMESTAMP}@gctrl.test"
TEST_PASS="E2E_Test_123!"
TEST_NAME="E2E Tester"

# State carried across tests
JWT=""
USER_ID=""
DEFAULT_ONT_ID=""
DEFAULT_COMP_ID=""
DEFAULT_FOLDER_ID=""
NEW_ONT_ID=""
NEW_COMP_ID=""
JOB_ID=""

echo -e "${BOLD}${BLUE}╔══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${BOLD}${BLUE}║       GCTRL Platform — Full Functional E2E Test            ║${NC}"
echo -e "${BOLD}${BLUE}╚══════════════════════════════════════════════════════════════╝${NC}"

# ─── 1. Health checks ─────────────────────────────────────────────────
section "1. Service health"

RESP=$(curl -sf --max-time 5 "$API_BASE/health" 2>/dev/null || echo "")
if [ "$(jget "$RESP" status)" = "ok" ]; then pass "API /health → ok"; else fail "API /health unreachable or not ok"; fi

RESP=$(curl -sf --max-time 5 "$KEX_BASE/health" 2>/dev/null || echo "")
if [ "$(jget "$RESP" status)" = "ok" ]; then pass "KEX /health → ok"; else fail "KEX /health unreachable or not ok"; fi

if curl -sf --max-time 5 "$WEB_BASE" -o /dev/null 2>/dev/null; then pass "Web UI 200 OK"; else fail "Web UI not responsive"; fi

# ─── 2. Auth flow ─────────────────────────────────────────────────────
section "2. Authentication"

REG_BODY=$(printf '{"email":"%s","password":"%s","name":"%s"}' "$TEST_EMAIL" "$TEST_PASS" "$TEST_NAME")
RESP=$(curl -sf --max-time 10 -X POST "$API_BASE/auth/register" -H "Content-Type: application/json" -d "$REG_BODY" 2>/dev/null || echo "")

JWT=$(jget "$RESP" "token")
USER_ID=$(jget "$RESP" "user.id")
if [ -n "$JWT" ] && [ -n "$USER_ID" ]; then
  pass "Register returns JWT + user (auto-login works)"
else
  fail "Register did not return JWT + user — frontend would force re-login"
fi

# Token allocation — must be 3000 to match license-api default
INITIAL_TOKENS=$(jget "$RESP" "user.tokensBalance")
if [ "$INITIAL_TOKENS" = "3000" ]; then
  pass "New user receives 3000 free tokens (matches license-api default)"
else
  fail "New user got $INITIAL_TOKENS tokens (expected 3000 to match license-api)"
fi

if [ -z "$JWT" ]; then
  fail "Cannot continue without JWT — aborting remaining tests"
  echo ""
  echo -e "${BOLD}Results: ${PASSED}/${TOTAL} passed${NC}"
  exit 1
fi

# Verify /users/me returns { user: {...} } (the shape the frontend expects)
RESP=$(curl -sf --max-time 5 -H "Authorization: Bearer $JWT" "$API_BASE/users/me" 2>/dev/null || echo "")
if jhas "$RESP" "user.id"; then
  pass "/users/me wraps response as { user: ... } (login persists across refresh)"
else
  fail "/users/me does not have .user wrapper — frontend will lose session on refresh"
fi

# Login should also work
LOGIN_BODY=$(printf '{"email":"%s","password":"%s"}' "$TEST_EMAIL" "$TEST_PASS")
RESP=$(curl -sf --max-time 5 -X POST "$API_BASE/auth/login" -H "Content-Type: application/json" -d "$LOGIN_BODY" 2>/dev/null || echo "")
if [ -n "$(jget "$RESP" token)" ]; then pass "Login with same credentials"; else fail "Login failed"; fi

# Refresh token works
RT=$(jget "$RESP" "refreshToken")
if [ -n "$RT" ]; then
  REFRESH_BODY=$(printf '{"refreshToken":"%s"}' "$RT")
  RESP=$(curl -sf --max-time 5 -X POST "$API_BASE/auth/refresh" -H "Content-Type: application/json" -d "$REFRESH_BODY" 2>/dev/null || echo "")
  if [ -n "$(jget "$RESP" token)" ]; then pass "Refresh token endpoint works"; else fail "Refresh token endpoint broken"; fi
fi

# ─── 3. Default workspace seeded on registration ─────────────────────
section "3. Default workspace (seeded at registration)"

RESP=$(curl -sf --max-time 5 -H "Authorization: Bearer $JWT" "$API_BASE/users/me" 2>/dev/null || echo "")
DEFAULT_ONT_ID=$(jget "$RESP" "user.defaultOntologyId")
if [ -n "$DEFAULT_ONT_ID" ] && [ "$DEFAULT_ONT_ID" != "null" ]; then
  pass "User has default_ontology_id set ($DEFAULT_ONT_ID)"
else
  fail "User has no default ontology — KEX won't know what to extract"
fi

RESP=$(curl -sf --max-time 5 -H "Authorization: Bearer $JWT" "$API_BASE/ontologies" 2>/dev/null || echo "")
ONT_COUNT=$(jlen "$RESP" "ontologies")
if [ "$ONT_COUNT" -ge 1 ]; then
  pass "/ontologies returns >=1 (count=$ONT_COUNT) — default ontology exists"
else
  fail "/ontologies returns 0 — default ontology not seeded"
fi

RESP=$(curl -sf --max-time 5 -H "Authorization: Bearer $JWT" "$API_BASE/kg/compilations" 2>/dev/null || echo "")
COMP_COUNT=$(jlen "$RESP" "compilations")
if [ "$COMP_COUNT" -ge 1 ]; then
  DEFAULT_COMP_ID=$(jget "$RESP" "compilations.0.id")
  pass "/kg/compilations returns >=1 (count=$COMP_COUNT) — default compilation exists"
else
  fail "No default compilation — KEX results have nowhere to land"
fi

RESP=$(curl -sf --max-time 5 -H "Authorization: Bearer $JWT" "$API_BASE/kg/folders" 2>/dev/null || echo "")
if jhas "$RESP" "folders"; then
  FOLDER_COUNT=$(jlen "$RESP" "folders")
  if [ "$FOLDER_COUNT" -ge 1 ]; then
    DEFAULT_FOLDER_ID=$(jget "$RESP" "folders.0.id")
    pass "/kg/folders returns >=1 (count=$FOLDER_COUNT) — KGListPage will not crash"
  else
    fail "/kg/folders returns 0 folders — default workspace folder missing"
  fi
else
  fail "/kg/folders endpoint missing or returns wrong shape (KGListPage will crash)"
fi

# ─── 4. Ontology CRUD ─────────────────────────────────────────────────
section "4. Ontology operations"

RESP=$(curl -sf --max-time 5 -H "Authorization: Bearer $JWT" "$API_BASE/ontologies/templates" 2>/dev/null || echo "")
TPL_COUNT=$(jlen "$RESP" "templates")
if [ "$TPL_COUNT" -ge 5 ]; then pass "Templates endpoint returns $TPL_COUNT templates"; else fail "Templates endpoint missing or empty"; fi

CREATE_ONT=$(printf '{"name":"E2E Custom Ontology","description":"Created by smoke","scope":"private"}')
RESP=$(curl -sf --max-time 5 -X POST -H "Authorization: Bearer $JWT" -H "Content-Type: application/json" -d "$CREATE_ONT" "$API_BASE/ontologies" 2>/dev/null || echo "")
NEW_ONT_ID=$(jget "$RESP" "id")
if [ -n "$NEW_ONT_ID" ]; then pass "POST /ontologies creates new ontology"; else fail "Cannot create new ontology"; fi

if [ -n "$NEW_ONT_ID" ]; then
  ADD_TYPE=$(printf '{"name":"Spaceship","qid":"Q40218","aliases":["spacecraft","starship"],"color":"#9333ea","confidenceThreshold":0.4}')
  RESP=$(curl -sf --max-time 5 -X POST -H "Authorization: Bearer $JWT" -H "Content-Type: application/json" -d "$ADD_TYPE" "$API_BASE/ontologies/$NEW_ONT_ID/entity-types" 2>/dev/null || echo "")
  ET_ID=$(jget "$RESP" "entityType.id")
  [ -z "$ET_ID" ] && ET_ID=$(jget "$RESP" "id")
  if [ -n "$ET_ID" ]; then pass "Add entity-type to ontology"; else fail "Cannot add entity-type"; fi

  RESP=$(curl -sf --max-time 5 -H "Authorization: Bearer $JWT" "$API_BASE/ontologies/$NEW_ONT_ID" 2>/dev/null || echo "")
  ET_LEN=$(jlen "$RESP" "ontology.entityTypes")
  [ "$ET_LEN" = "0" ] && ET_LEN=$(jlen "$RESP" "entityTypes")
  if [ "$ET_LEN" -ge 1 ]; then pass "GET ontology shows added entity types ($ET_LEN)"; else fail "Entity types not visible after add"; fi
fi

# ─── 5. Compilation + Folder operations ──────────────────────────────
section "5. Compilations & folders"

# Create a folder
CREATE_FOLDER=$(printf '{"name":"E2E Test Folder"}')
RESP=$(curl -sf --max-time 5 -X POST -H "Authorization: Bearer $JWT" -H "Content-Type: application/json" -d "$CREATE_FOLDER" "$API_BASE/kg/folders" 2>/dev/null || echo "")
NEW_FOLDER_ID=$(jget "$RESP" "id")
if [ -n "$NEW_FOLDER_ID" ]; then pass "POST /kg/folders creates folder"; else fail "Cannot create folder"; fi

# Create compilation
CREATE_COMP=$(printf '{"name":"E2E Test Compilation","description":"smoke test","classification":"INTERNAL"}')
RESP=$(curl -sf --max-time 5 -X POST -H "Authorization: Bearer $JWT" -H "Content-Type: application/json" -d "$CREATE_COMP" "$API_BASE/kg/compilations" 2>/dev/null || echo "")
NEW_COMP_ID=$(jget "$RESP" "id")
if [ -n "$NEW_COMP_ID" ]; then pass "POST /kg/compilations creates compilation"; else fail "Cannot create compilation"; fi

# Move compilation to the new folder
if [ -n "$NEW_COMP_ID" ] && [ -n "$NEW_FOLDER_ID" ]; then
  MOVE_BODY=$(printf '{"folderId":"%s"}' "$NEW_FOLDER_ID")
  if curl -sf --max-time 5 -X PUT -H "Authorization: Bearer $JWT" -H "Content-Type: application/json" -d "$MOVE_BODY" "$API_BASE/kg/folders/move/$NEW_COMP_ID" -o /dev/null 2>/dev/null; then
    pass "PUT /kg/folders/move/:id moves compilation"
  else
    fail "Cannot move compilation to folder"
  fi
fi

# Graph endpoint (covers GraphExplorer)
if [ -n "$NEW_COMP_ID" ]; then
  RESP=$(curl -sf --max-time 5 -H "Authorization: Bearer $JWT" "$API_BASE/kg/compilations/$NEW_COMP_ID/graph" 2>/dev/null || echo "")
  if jhas "$RESP" "nodes" && jhas "$RESP" "edges"; then
    pass "GET /kg/compilations/:id/graph returns nodes+edges (Explorer renders)"
  else
    fail "Graph endpoint missing nodes/edges keys"
  fi
fi

# ─── 6. KEX text extraction → status writeback ───────────────────────
section "6. KEX text extraction (full pipeline)"

EXTRACT_BODY='{"text":"Anthropic, founded by Dario Amodei in San Francisco, develops Claude. The company partnered with Google in 2023."}'
RESP=$(curl -sf --max-time 10 -X POST -H "Authorization: Bearer $JWT" -H "Content-Type: application/json" -d "$EXTRACT_BODY" "$API_BASE/kex/extract" 2>/dev/null || echo "")
JOB_ID=$(jget "$RESP" "jobId")
if [ -n "$JOB_ID" ]; then pass "POST /kex/extract returns jobId ($JOB_ID)"; else fail "kex/extract did not return jobId"; fi

if [ -n "$JOB_ID" ]; then
  echo -n "  ⏳ Waiting up to 180s for job to leave 'pending'/'processing'..."
  WAIT=0; STATUS="pending"
  while [ $WAIT -lt 180 ]; do
    RESP=$(curl -sf --max-time 3 -H "Authorization: Bearer $JWT" "$API_BASE/kex/jobs/$JOB_ID" 2>/dev/null || echo "")
    STATUS=$(jget "$RESP" "job.status")
    if [ "$STATUS" = "completed" ] || [ "$STATUS" = "failed" ]; then break; fi
    sleep 3; WAIT=$((WAIT+3)); echo -n "."
  done
  echo ""

  if [ "$STATUS" = "completed" ]; then
    pass "Job moved to 'completed' (postgres status writeback works!)"
  elif [ "$STATUS" = "failed" ]; then
    fail "Job failed: $(jget "$RESP" job.error)"
  else
    fail "Job stuck in '$STATUS' after 180s (status writeback broken)"
  fi
fi

# Job result has entities
if [ "$STATUS" = "completed" ] && [ -n "$JOB_ID" ]; then
  RESP=$(curl -sf --max-time 5 -H "Authorization: Bearer $JWT" "$API_BASE/kex/jobs/$JOB_ID/result" 2>/dev/null || echo "")
  # /result now wraps as { jobId, status, completedAt, result: { entities, ... } }
  E_LEN=$(jlen "$RESP" "result.entities")
  if [ "$E_LEN" -ge 2 ]; then
    pass "Job result has $E_LEN entities extracted"
  else
    fail "Job result has $E_LEN entities (expected ≥2 — Anthropic, Dario Amodei, San Francisco, Google)"
  fi
fi

# Verify input field is in jobs list (for filename display)
RESP=$(curl -sf --max-time 5 -H "Authorization: Bearer $JWT" "$API_BASE/kex/jobs" 2>/dev/null || echo "")
if [ "$JSON_TOOL" = "jq" ]; then
  HAS_INPUT=$(printf '%s' "$RESP" | jq -e '.jobs[0].input != null' >/dev/null 2>&1 && echo "yes" || echo "no")
else
  HAS_INPUT=$(python3 -c "
import sys, json
try:
    d = json.loads(sys.argv[1])
    print('yes' if d['jobs'][0].get('input') is not None else 'no')
except Exception: print('no')
" "$RESP")
fi
if [ "$HAS_INPUT" = "yes" ]; then
  pass "GET /kex/jobs returns 'input' field (filenames will display in UI)"
else
  fail "GET /kex/jobs missing 'input' — UI will show '—' instead of filenames"
fi

# ─── 6b. KEX large-text extraction (chunker stress test) ─────────────
section "6b. KEX large-text extraction (regression: chunker hangs on long sentences)"

# Synthesize a 9k-char payload with many repeated long sentences. Pre-fix this would hang
# the chunker forever; post-fix it must complete inside the 240s budget.
SENT="Anthropic is an AI safety company founded by Dario Amodei and Daniela Amodei in San Francisco that develops Claude. "
LONG_TEXT=""
for k in $(seq 1 80); do LONG_TEXT="$LONG_TEXT$SENT"; done

# Use a temp file for the JSON body to avoid bash arg-length / escaping issues.
LARGE_BODY_FILE=$(mktemp 2>/dev/null || echo "/tmp/e2e_large_body.json")
printf '{"text":"%s"}' "$LONG_TEXT" > "$LARGE_BODY_FILE"

if [ ${#LONG_TEXT} -gt 5000 ]; then
  RESP=$(curl -sf --max-time 10 -X POST -H "Authorization: Bearer $JWT" -H "Content-Type: application/json" --data-binary @"$LARGE_BODY_FILE" "$API_BASE/kex/extract" 2>/dev/null || echo "")
  LARGE_JOB_ID=$(jget "$RESP" "jobId")
  if [ -n "$LARGE_JOB_ID" ]; then
    echo -n "  ⏳ Waiting up to 240s for large-text job to finish..."
    WAIT=0; LSTATUS="pending"
    while [ $WAIT -lt 240 ]; do
      RESP=$(curl -sf --max-time 3 -H "Authorization: Bearer $JWT" "$API_BASE/kex/jobs/$LARGE_JOB_ID" 2>/dev/null || echo "")
      LSTATUS=$(jget "$RESP" "job.status")
      if [ "$LSTATUS" = "completed" ] || [ "$LSTATUS" = "failed" ]; then break; fi
      sleep 5; WAIT=$((WAIT+5)); echo -n "."
    done
    echo ""
    if [ "$LSTATUS" = "completed" ]; then
      pass "Large-text job (${#LONG_TEXT} chars) completed without hanging"
    elif [ "$LSTATUS" = "failed" ]; then
      fail "Large-text job failed: $(jget "$RESP" job.error)"
    else
      fail "Large-text job stuck in '$LSTATUS' after 240s — chunker likely hung"
    fi
  else
    fail "Could not submit large-text job"
  fi
else
  echo "  (skipping — could not synthesize test payload)"
fi
rm -f "$LARGE_BODY_FILE" 2>/dev/null

# ─── 6c. FUSE merge create (regression: Vec<Uuid> binding to UUID[]) ─
section "6c. FUSE merge — graph creation from source extractions"

if [ -n "$JOB_ID" ]; then
  MERGE_BODY=$(printf '{"name":"E2E Merge Test","sourceJobIds":["%s"]}' "$JOB_ID")
  RESP=$(curl -sf --max-time 10 -X POST -H "Authorization: Bearer $JWT" -H "Content-Type: application/json" -d "$MERGE_BODY" "$API_BASE/fuse/merge" 2>/dev/null || echo "")
  MERGE_JOB_ID=$(jget "$RESP" "jobId")
  MERGE_COMP_ID=$(jget "$RESP" "compilationId")
  if [ -n "$MERGE_JOB_ID" ] && [ -n "$MERGE_COMP_ID" ]; then
    pass "POST /fuse/merge accepts sourceJobIds and creates compilation"
  else
    fail "FUSE merge failed (Database error): response=$RESP"
  fi

  # Verify the created compilation actually has source_job_ids stored as UUID[]
  if [ -n "$MERGE_COMP_ID" ]; then
    RESP=$(curl -sf --max-time 5 -H "Authorization: Bearer $JWT" "$API_BASE/kg/compilations/$MERGE_COMP_ID" 2>/dev/null || echo "")
    SRC_LEN=$(jlen "$RESP" "compilation.sourceJobIds")
    [ "$SRC_LEN" = "0" ] && SRC_LEN=$(jlen "$RESP" "sourceJobIds")
    if [ "$SRC_LEN" -ge 1 ]; then
      pass "Merged compilation persists sourceJobIds (count=$SRC_LEN)"
    else
      fail "Merged compilation has empty sourceJobIds (UUID[] binding broken)"
    fi
  fi

  # Verify GET /fuse/jobs/:id returns wrapped { job: ... } shape (FuseJobDetail expects this)
  if [ -n "$MERGE_JOB_ID" ]; then
    RESP=$(curl -sf --max-time 5 -H "Authorization: Bearer $JWT" "$API_BASE/fuse/jobs/$MERGE_JOB_ID" 2>/dev/null || echo "")
    if jhas "$RESP" "job.id"; then
      pass "GET /fuse/jobs/:id returns { job: ... } wrapper (FuseJobDetail will not crash)"
    else
      fail "GET /fuse/jobs/:id missing { job: ... } wrapper — UI shows 'Job not found'"
    fi
    if jhas "$RESP" "job.input"; then
      pass "GET /fuse/jobs/:id includes 'input' field (source extractions visible)"
    else
      fail "GET /fuse/jobs/:id missing 'input' — UI cannot show source extractions"
    fi
  fi
fi

# ─── 6d. Live node-count writeback (regression: stale postgres counters) ─
section "6d. Live counters — KEX writes flow through to compilation cards"

# Reproduces the bug: KEX writes N entities to Neo4j, but the compilation row
# in postgres keeps node_count=0. The /kg/compilations endpoint must compute
# live counts from Neo4j and override the stale postgres values.

LIVE_EXTRACT_BODY='{"text":"Microsoft, headquartered in Redmond, was founded by Bill Gates and Paul Allen. The company acquired GitHub in 2018 and later invested in OpenAI."}'
RESP=$(curl -sf --max-time 10 -X POST -H "Authorization: Bearer $JWT" -H "Content-Type: application/json" -d "$LIVE_EXTRACT_BODY" "$API_BASE/kex/extract" 2>/dev/null || echo "")
LIVE_JOB_ID=$(jget "$RESP" "jobId")
if [ -n "$LIVE_JOB_ID" ]; then
  echo -n "  ⏳ Waiting up to 180s for live-counter extraction job..."
  WAIT=0; LIVE_STATUS="pending"
  while [ $WAIT -lt 180 ]; do
    RESP=$(curl -sf --max-time 3 -H "Authorization: Bearer $JWT" "$API_BASE/kex/jobs/$LIVE_JOB_ID" 2>/dev/null || echo "")
    LIVE_STATUS=$(jget "$RESP" "job.status")
    if [ "$LIVE_STATUS" = "completed" ] || [ "$LIVE_STATUS" = "failed" ]; then break; fi
    sleep 3; WAIT=$((WAIT+3)); echo -n "."
  done
  echo ""

  if [ "$LIVE_STATUS" = "completed" ]; then
    pass "Live-counter extraction job completed"

    # Find the *default* compilation (the one seeded at registration).
    # Its source_job_ids is empty, so live_counts() falls back to
    # "all of the user's nodes" — which must include the entities just
    # written by KEX.
    RESP=$(curl -sf --max-time 5 -H "Authorization: Bearer $JWT" "$API_BASE/kg/compilations" 2>/dev/null || echo "")
    if [ "$JSON_TOOL" = "jq" ]; then
      LIVE_COMP_ID=$(printf '%s' "$RESP" | jq -r '.compilations[] | select(.name == "My First Knowledge Base") | .id' | head -1)
      LIVE_NC=$(printf '%s' "$RESP" | jq -r '.compilations[] | select(.name == "My First Knowledge Base") | .nodeCount' | head -1)
    else
      LIVE_COMP_ID=$(python3 -c "
import sys, json
d = json.loads(sys.argv[1])
for c in d.get('compilations', []):
    if c.get('name') == 'My First Knowledge Base':
        print(c['id']); break
" "$RESP")
      LIVE_NC=$(python3 -c "
import sys, json
d = json.loads(sys.argv[1])
for c in d.get('compilations', []):
    if c.get('name') == 'My First Knowledge Base':
        print(c.get('nodeCount', 0)); break
" "$RESP")
    fi
    if [ -n "$LIVE_NC" ] && [ "$LIVE_NC" -ge 4 ] 2>/dev/null; then
      pass "Default compilation reports live nodeCount=$LIVE_NC (>=4 — counter override works)"
    else
      fail "Default compilation reports nodeCount=$LIVE_NC (expected >=4 — live counter broken, /graphs would show 0)"
    fi

    # Same check on the detail endpoint
    if [ -n "$LIVE_COMP_ID" ]; then
      RESP=$(curl -sf --max-time 5 -H "Authorization: Bearer $JWT" "$API_BASE/kg/compilations/$LIVE_COMP_ID" 2>/dev/null || echo "")
      # /kg/compilations/:id now wraps as { compilation: { ... } }
      DETAIL_NC=$(jget "$RESP" "compilation.nodeCount")
      [ -z "$DETAIL_NC" ] && DETAIL_NC=$(jget "$RESP" "nodeCount")
      if [ -n "$DETAIL_NC" ] && [ "$DETAIL_NC" -ge 4 ] 2>/dev/null; then
        pass "GET /kg/compilations/:id also reports live nodeCount=$DETAIL_NC"
      else
        fail "GET /kg/compilations/:id reports nodeCount=$DETAIL_NC (expected >=4)"
      fi

      # Critical: the /graph endpoint must actually return nodes for the
      # default compilation (the user's GraphExplorer renders these).
      RESP=$(curl -sf --max-time 5 -H "Authorization: Bearer $JWT" "$API_BASE/kg/compilations/$LIVE_COMP_ID/graph?limit=200" 2>/dev/null || echo "")
      GRAPH_NODES=$(jlen "$RESP" "nodes")
      if [ "$GRAPH_NODES" -ge 4 ]; then
        pass "GET /kg/compilations/:id/graph returns $GRAPH_NODES nodes (Explorer will render entities)"
      else
        fail "GET /kg/compilations/:id/graph returned $GRAPH_NODES nodes (Explorer would show empty/grey)"
      fi
    fi
  elif [ "$LIVE_STATUS" = "failed" ]; then
    fail "Live-counter extraction job failed: $(jget "$RESP" job.error)"
  else
    fail "Live-counter extraction job stuck in '$LIVE_STATUS' after 180s"
  fi
else
  fail "Could not submit live-counter extraction job"
fi

# ─── 7. KEX semantic search (post-extraction) ────────────────────────
section "7. KEX semantic search"

SEARCH_BODY='{"query":"Who founded Anthropic?","limit":5}'
RESP=$(curl -sf --max-time 10 -X POST -H "Content-Type: application/json" -d "$SEARCH_BODY" "$KEX_BASE/search" 2>/dev/null || echo "")
if jhas "$RESP" "chunks"; then
  CHUNK_LEN=$(jlen "$RESP" "chunks")
  if [ "$CHUNK_LEN" -ge 1 ]; then
    pass "POST $KEX_BASE/search returned $CHUNK_LEN chunks (Qdrant working)"
  else
    fail "KEX /search returned 0 chunks (Qdrant or embedding broken)"
  fi
else
  fail "KEX /search response shape is wrong (missing 'chunks')"
fi

# ─── 8. RAG hybrid query ──────────────────────────────────────────────
section "8. RAG hybrid retrieval (chat)"

RAG_BODY='{"message":"What did Anthropic do?"}'
RESP=$(curl -sf --max-time 60 -X POST -H "Authorization: Bearer $JWT" -H "Content-Type: application/json" -d "$RAG_BODY" "$API_BASE/rag/query" 2>/dev/null || echo "")
ANSWER=$(jget "$RESP" "answer")
if [ -n "$ANSWER" ] && [ ${#ANSWER} -gt 5 ]; then
  pass "RAG answer received (${#ANSWER} chars)"
else
  fail "RAG query did not return an answer"
fi

if jhas "$RESP" "sources"; then
  pass "RAG response has 'sources' field"
else
  fail "RAG response missing 'sources' field"
fi

# ─── 9. Connectors endpoint ──────────────────────────────────────────
section "9. Connectors"

RESP=$(curl -sf --max-time 5 -H "Authorization: Bearer $JWT" "$API_BASE/connectors" 2>/dev/null || echo "")
if jhas "$RESP" "connectors"; then pass "GET /connectors returns 'connectors' array"; else fail "/connectors broken"; fi

# ─── 10. Cleanup ──────────────────────────────────────────────────────
section "10. Cleanup"

if [ -n "$NEW_COMP_ID" ]; then
  if curl -sf --max-time 5 -X DELETE -H "Authorization: Bearer $JWT" "$API_BASE/kg/compilations/$NEW_COMP_ID" -o /dev/null 2>/dev/null; then
    pass "Delete compilation"
  else
    fail "Could not delete compilation"
  fi
fi

if [ -n "$NEW_FOLDER_ID" ]; then
  if curl -sf --max-time 5 -X DELETE -H "Authorization: Bearer $JWT" "$API_BASE/kg/folders/$NEW_FOLDER_ID" -o /dev/null 2>/dev/null; then
    pass "Delete folder"
  else
    fail "Could not delete folder"
  fi
fi

if [ -n "$NEW_ONT_ID" ]; then
  if curl -sf --max-time 5 -X DELETE -H "Authorization: Bearer $JWT" "$API_BASE/ontologies/$NEW_ONT_ID" -o /dev/null 2>/dev/null; then
    pass "Delete custom ontology"
  else
    fail "Could not delete custom ontology"
  fi
fi

# ─── Summary ──────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
if [ $FAILED -eq 0 ]; then
  echo -e "${GREEN}${BOLD}  ALL TESTS PASSED  —  $PASSED/$TOTAL${NC}"
  echo -e "${GREEN}  Platform is fully functional.${NC}"
  echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  exit 0
else
  echo -e "${RED}${BOLD}  $FAILED FAILURE(S)  —  $PASSED/$TOTAL passed${NC}"
  echo ""
  echo -e "${YELLOW}Failed checks:${NC}"
  for f in "${FAIL_LOG[@]}"; do echo -e "  ${RED}✗${NC} $f"; done
  echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  exit 1
fi
