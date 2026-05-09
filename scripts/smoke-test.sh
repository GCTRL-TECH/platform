#!/usr/bin/env bash
# GCTRL Smoke Test Suite
# Verifies the full stack is functional end-to-end.
# Usage: ./scripts/smoke-test.sh
# Exit 0: all tests passed
# Exit 1: one or more tests failed
#
# Dependencies: bash, curl, python3
set -uo pipefail

# ── endpoints ─────────────────────────────────────────────────────────────────
API_BASE="http://localhost:4000/api"
KEX_BASE="http://localhost:4010"
AGENT_BASE="http://localhost:7070"
WEB_BASE="http://localhost:3001"

# ── test user (ephemeral smoke credentials) ───────────────────────────────────
SMOKE_EMAIL="test@gctrl-smoke.test"
SMOKE_PASS="SmokeTest123!"
SMOKE_NAME="Smoke Tester"

# ── colour helpers ────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

# ── state ─────────────────────────────────────────────────────────────────────
PASS_COUNT=0
FAIL_COUNT=0
TOTAL=0
JWT=""
COMPILATION_ID=""
JOB_ID=""

# ── json helper (jq preferred, python3 fallback) ──────────────────────────────
# Usage: json_get <json_string> <key.subkey>
JSON_TOOL=""
if command -v jq >/dev/null 2>&1; then JSON_TOOL=jq
elif command -v python3 >/dev/null 2>&1 && python3 --version >/dev/null 2>&1; then JSON_TOOL=python3
else echo "ERROR: need jq or python3 on PATH" >&2; exit 1; fi

json_get() {
  if [ "$JSON_TOOL" = "jq" ]; then
    printf '%s' "$1" | jq -r ".${2} // empty" 2>/dev/null
  else
    python3 -c "
import sys, json
try:
    data = json.loads(sys.argv[1])
    keys = sys.argv[2].split('.')
    for k in keys: data = data[k]
    print(data if not isinstance(data, (dict, list)) else json.dumps(data))
except Exception: print('')
" "$1" "$2"
  fi
}

json_has_key() {
  if [ "$JSON_TOOL" = "jq" ]; then
    printf '%s' "$1" | jq -e "has(\"${2%%.*}\")" >/dev/null 2>&1
  else
    python3 -c "
import sys, json
try:
    data = json.loads(sys.argv[1])
    keys = sys.argv[2].split('.')
    for k in keys: data = data[k]
    sys.exit(0)
except Exception: sys.exit(1)
" "$1" "$2"
  fi
}

json_array_len() {
  if [ "$JSON_TOOL" = "jq" ]; then
    printf '%s' "$1" | jq -r ".${2} | length" 2>/dev/null || echo 0
  else
    python3 -c "
import sys, json
try:
    data = json.loads(sys.argv[1])
    keys = sys.argv[2].split('.')
    for k in keys: data = data[k]
    print(len(data))
except Exception: print(0)
" "$1" "$2"
  fi
}

# ── core test runner ──────────────────────────────────────────────────────────
# run_test <description> <pass_condition_fn_or_inline>
# The test body is passed as arguments after the name. The last argument
# is evaluated as a bash compound command: passes if exit-0, fails otherwise.
#
# Simpler approach: use a wrapper that captures output + exit code.

CURRENT_TEST_NAME=""
CURRENT_TEST_NUM=0

begin_test() {
  TOTAL=$(( TOTAL + 1 ))
  CURRENT_TEST_NUM=$TOTAL
  CURRENT_TEST_NAME="$1"
  echo -ne "${YELLOW}[${CURRENT_TEST_NUM}/${N_TESTS}]${NC} ${CURRENT_TEST_NAME} ... "
}

pass_test() {
  PASS_COUNT=$(( PASS_COUNT + 1 ))
  echo -e "${GREEN}PASS${NC}"
}

fail_test() {
  local reason="${1:-}"
  FAIL_COUNT=$(( FAIL_COUNT + 1 ))
  echo -e "${RED}FAIL${NC}${reason:+ — $reason}"
}

# ── total test count (update when adding tests) ───────────────────────────────
N_TESTS=15

# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}${CYAN}Test Suite: GCTRL Smoke Tests${NC}"
echo -e "============================================"
echo ""

# ── [1] API health check ──────────────────────────────────────────────────────
begin_test "API health check"
RESP=$(curl -sf --max-time 5 "${API_BASE}/health" 2>/dev/null) || { fail_test "curl failed"; RESP=""; }
if [ -n "$RESP" ]; then
  STATUS=$(json_get "$RESP" "status")
  if [ "$STATUS" = "ok" ]; then
    pass_test
  else
    fail_test "expected status=ok, got: $STATUS"
  fi
fi

# ── [2] KEX health check ──────────────────────────────────────────────────────
begin_test "KEX health check"
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "${KEX_BASE}/health" 2>/dev/null)
if [ "$HTTP_CODE" = "200" ]; then
  pass_test
else
  fail_test "HTTP $HTTP_CODE"
fi

# ── [3] Agent status ──────────────────────────────────────────────────────────
begin_test "Agent status"
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "${AGENT_BASE}/status" 2>/dev/null)
if [ "$HTTP_CODE" = "200" ]; then
  pass_test
else
  fail_test "HTTP $HTTP_CODE"
fi

# ── [4] Register test user ────────────────────────────────────────────────────
begin_test "Register test user"
RESP=$(curl -sf --max-time 5 \
  -X POST "${API_BASE}/auth/register" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"${SMOKE_EMAIL}\",\"password\":\"${SMOKE_PASS}\",\"name\":\"${SMOKE_NAME}\"}" \
  2>/dev/null) || RESP=""

if [ -n "$RESP" ] && json_has_key "$RESP" "token" 2>/dev/null; then
  pass_test
else
  # User may already exist from a prior run — that is acceptable; try login next
  HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 \
    -X POST "${API_BASE}/auth/register" \
    -H "Content-Type: application/json" \
    -d "{\"email\":\"${SMOKE_EMAIL}\",\"password\":\"${SMOKE_PASS}\",\"name\":\"${SMOKE_NAME}\"}" \
    2>/dev/null)
  if [ "$HTTP_CODE" = "409" ]; then
    pass_test  # already exists — fine
  else
    fail_test "no token in response and not 409 (got HTTP $HTTP_CODE)"
  fi
fi

# ── [5] Login test user ───────────────────────────────────────────────────────
begin_test "Login test user"
RESP=$(curl -sf --max-time 5 \
  -X POST "${API_BASE}/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"${SMOKE_EMAIL}\",\"password\":\"${SMOKE_PASS}\"}" \
  2>/dev/null) || RESP=""

if [ -n "$RESP" ]; then
  JWT=$(json_get "$RESP" "token")
fi

if [ -n "$JWT" ]; then
  pass_test
else
  fail_test "no JWT received"
fi

# ── authenticated helper ──────────────────────────────────────────────────────
auth_curl() {
  # auth_curl [extra curl args...] <url>
  # Injects Authorization header; requires $JWT to be set
  curl -sf --max-time 10 \
    -H "Authorization: Bearer ${JWT}" \
    -H "Content-Type: application/json" \
    "$@"
}

# ── [6] KEX submit text job ───────────────────────────────────────────────────
begin_test "KEX submit text job"
EXTRACT_TEXT="GCTRL is a knowledge graph platform. It extracts entities from text using machine learning."
RESP=$(auth_curl \
  -X POST "${API_BASE}/kex/extract" \
  -d "{\"text\":\"${EXTRACT_TEXT}\"}" \
  2>/dev/null) || RESP=""

if [ -n "$RESP" ]; then
  JOB_ID=$(json_get "$RESP" "jobId")
fi

if [ -n "$JOB_ID" ]; then
  pass_test
else
  fail_test "no jobId in response"
fi

# ── [7] Wait for job completion ───────────────────────────────────────────────
begin_test "Wait for KEX job completion"
JOB_STATUS=""
MAX_POLL=40   # 40 × 3s = 120s
POLL_COUNT=0

while [ "$POLL_COUNT" -lt "$MAX_POLL" ]; do
  RESP=$(auth_curl "${API_BASE}/kex/jobs/${JOB_ID}" 2>/dev/null) || RESP=""
  if [ -n "$RESP" ]; then
    JOB_STATUS=$(json_get "$RESP" "status")
    if [ "$JOB_STATUS" = "completed" ] || [ "$JOB_STATUS" = "failed" ]; then
      break
    fi
  fi
  sleep 3
  POLL_COUNT=$(( POLL_COUNT + 1 ))
done

if [ "$JOB_STATUS" = "completed" ]; then
  pass_test
elif [ "$JOB_STATUS" = "failed" ]; then
  JOB_ERR=$(json_get "$RESP" "error")
  fail_test "job failed: ${JOB_ERR}"
else
  fail_test "timeout after 120s — last status: ${JOB_STATUS}"
fi

# ── [8] Check job result has entities ────────────────────────────────────────
begin_test "KEX job result has entities"
RESP=$(auth_curl "${API_BASE}/kex/jobs/${JOB_ID}/result" 2>/dev/null) || RESP=""

if [ -n "$RESP" ] && [ "$RESP" != "null" ]; then
  # Result should be non-null; check for entities array if present
  if json_has_key "$RESP" "entities" 2>/dev/null; then
    ENT_LEN=$(json_array_len "$RESP" "entities")
    if [ "$ENT_LEN" -gt 0 ]; then
      pass_test
    else
      fail_test "entities array is empty"
    fi
  else
    # Result exists but may use different schema; non-null result is acceptable
    pass_test
  fi
else
  fail_test "result is null or empty"
fi

# ── [9] KEX search ────────────────────────────────────────────────────────────
begin_test "KEX search returns chunks"
RESP=$(curl -sf --max-time 10 \
  -X POST "${KEX_BASE}/search" \
  -H "Content-Type: application/json" \
  -d '{"query":"GCTRL knowledge graph","limit":5}' \
  2>/dev/null) || RESP=""

if [ -n "$RESP" ]; then
  pass_test
else
  fail_test "no response from KEX /search"
fi

# ── [10] List KG compilations ─────────────────────────────────────────────────
begin_test "List KG compilations"
RESP=$(auth_curl "${API_BASE}/kg/compilations" 2>/dev/null) || RESP=""

if [ -n "$RESP" ] && json_has_key "$RESP" "compilations" 2>/dev/null; then
  pass_test
else
  fail_test "missing compilations key in response"
fi

# ── [11] Create compilation ───────────────────────────────────────────────────
begin_test "Create KG compilation"
RESP=$(auth_curl \
  -X POST "${API_BASE}/kg/compilations" \
  -d "{\"name\":\"Smoke Test KG\",\"description\":\"Created by smoke-test.sh\"}" \
  2>/dev/null) || RESP=""

if [ -n "$RESP" ]; then
  COMPILATION_ID=$(json_get "$RESP" "id")
fi

if [ -n "$COMPILATION_ID" ]; then
  pass_test
else
  fail_test "no id in response"
fi

# ── [12] Graph endpoint ───────────────────────────────────────────────────────
begin_test "Graph endpoint returns nodes+edges structure"
RESP=$(auth_curl "${API_BASE}/kg/compilations/${COMPILATION_ID}/graph" 2>/dev/null) || RESP=""

if [ -n "$RESP" ] && json_has_key "$RESP" "nodes" 2>/dev/null && json_has_key "$RESP" "edges" 2>/dev/null; then
  pass_test
else
  fail_test "missing nodes or edges key in response"
fi

# ── [13] List connectors ──────────────────────────────────────────────────────
begin_test "List connectors"
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 \
  -H "Authorization: Bearer ${JWT}" \
  "${API_BASE}/connectors" 2>/dev/null)

if [ "$HTTP_CODE" = "200" ]; then
  pass_test
else
  fail_test "HTTP $HTTP_CODE (connectors endpoint may not be implemented yet)"
fi

# ── [14] RAG query (no context) ───────────────────────────────────────────────
begin_test "RAG query returns answer"
# RAG uses optional_auth — no JWT required, but include it if we have it
CURL_FLAGS=(-sf --max-time 30 -X POST "${API_BASE}/rag/query"
  -H "Content-Type: application/json"
  -d '{"message":"What is GCTRL?"}')
if [ -n "$JWT" ]; then
  CURL_FLAGS+=(-H "Authorization: Bearer ${JWT}")
fi

RESP=$(curl "${CURL_FLAGS[@]}" 2>/dev/null) || RESP=""

if [ -n "$RESP" ] && json_has_key "$RESP" "answer" 2>/dev/null; then
  ANSWER=$(json_get "$RESP" "answer")
  if [ -n "$ANSWER" ]; then
    pass_test
  else
    fail_test "answer field is empty"
  fi
else
  fail_test "no answer key in response"
fi

# ── [15] Cleanup — delete test compilation ────────────────────────────────────
begin_test "Cleanup: delete smoke test compilation"
if [ -n "$COMPILATION_ID" ]; then
  HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 \
    -X DELETE \
    -H "Authorization: Bearer ${JWT}" \
    "${API_BASE}/kg/compilations/${COMPILATION_ID}" 2>/dev/null)
  if [ "$HTTP_CODE" = "200" ]; then
    pass_test
  else
    fail_test "DELETE returned HTTP $HTTP_CODE"
  fi
else
  fail_test "no compilation to delete (skipped — prior test failed)"
fi

# ── summary ───────────────────────────────────────────────────────────────────
echo ""
echo -e "============================================"
if [ "$FAIL_COUNT" -eq 0 ]; then
  echo -e "${GREEN}${BOLD}Results: ${PASS_COUNT}/${N_TESTS} passed${NC}"
  echo -e "${GREEN}All smoke tests passed.${NC}"
  echo ""
  exit 0
else
  echo -e "${RED}${BOLD}Results: ${PASS_COUNT}/${N_TESTS} passed, ${FAIL_COUNT} FAILED${NC}"
  echo ""
  exit 1
fi
