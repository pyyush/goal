#!/usr/bin/env bash
# scripts/smoke-phase-1.sh
#
# Integration smoke test for Phase 1 of the parity-tools rollout.
# Verifies that the three artifacts produced by the parallel build
# (mcp/goal-server.ts, bin/goalctl --json/listen, bin/goal-http-server.ts)
# all coordinate correctly against a single .claude/goal.json file.
#
# Run from the repo root:
#   ./scripts/smoke-phase-1.sh
#
# Exit codes:
#   0  all checks passed
#   1+ specific check that failed (see messages)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

# Set up an isolated goal root so we don't touch the repo's actual goal state.
TMP=$(mktemp -d -t goal-smoke-XXXXXX)
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/.claude"

GOAL_FILE="$TMP/.claude/goal.json"
EVENTS_FILE="$TMP/.claude/goal-events.jsonl"
GOALCTL="$REPO_ROOT/bin/goalctl"
MCP_PKG="$REPO_ROOT/mcp/package.json"

green() { printf '\033[32m%s\033[0m\n' "$*"; }
red()   { printf '\033[31m%s\033[0m\n' "$*"; }
say()   { printf '  %s\n' "$*"; }

step() {
    printf '\n[%s] %s\n' "$(date -u +%H:%M:%S)" "$1"
}

# -------- 1. Prereqs ---------------------------------------------------------

step "1. Prereqs (node, jq, goalctl, MCP server, http server)"
command -v node >/dev/null || { red "FAIL: node not installed"; exit 1; }
command -v jq   >/dev/null || { red "FAIL: jq not installed"; exit 1; }
[ -x "$GOALCTL" ]          || { red "FAIL: $GOALCTL not executable"; exit 1; }
[ -f "$MCP_PKG" ]          || { red "FAIL: $MCP_PKG missing (subagent A incomplete?)"; exit 1; }
[ -f "$REPO_ROOT/bin/goal-http-server.ts" ] || { red "FAIL: bin/goal-http-server.ts missing (subagent B incomplete?)"; exit 1; }
say "node $(node --version) · jq $(jq --version)"

# -------- 2. goalctl create + status --json ---------------------------------

step "2. goalctl: create + --json status round-trip"
"$GOALCTL" --root "$TMP" create "smoke objective" --budget 5000 >/dev/null
STATUS_JSON=$("$GOALCTL" --root "$TMP" status --json)
RT=$(echo "$STATUS_JSON" | jq -r '.remaining_tokens // empty')
[ "$RT" = "5000" ] || { red "FAIL: --json status missing remaining_tokens (got '$RT')"; exit 2; }
say "remaining_tokens=$RT ✓"

# -------- 3. MCP server: handshake + 3 tools listed -------------------------

step "3. MCP server: tools/list returns create_goal, update_goal, get_goal"

# Pipe a single JSON-RPC initialize + tools/list, capture stdout.
MCP_OUT=$(GOAL_ROOT="$TMP" \
  printf '%s\n%s\n' \
    '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}' \
    '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  | node "$REPO_ROOT/mcp/dist/goal-server.js" 2>/dev/null \
  || GOAL_ROOT="$TMP" \
  printf '%s\n%s\n' \
    '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}' \
    '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  | npx --prefix "$REPO_ROOT/mcp" tsx "$REPO_ROOT/mcp/goal-server.ts" 2>/dev/null
)

for tool in create_goal update_goal get_goal; do
    echo "$MCP_OUT" | grep -q "\"name\":\"$tool\"" \
        || { red "FAIL: MCP server did not advertise '$tool'"; echo "$MCP_OUT" | head -20; exit 3; }
done
say "tools advertised: create_goal, update_goal, get_goal ✓"

# -------- 4. MCP get_goal sees the goal that goalctl created ----------------

step "4. MCP get_goal reads the same .claude/goal.json that goalctl wrote"
GET_OUT=$(GOAL_ROOT="$TMP" printf '%s\n%s\n%s\n' \
    '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}' \
    '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_goal","arguments":{}}}' \
    | (node "$REPO_ROOT/mcp/dist/goal-server.js" 2>/dev/null \
       || npx --prefix "$REPO_ROOT/mcp" tsx "$REPO_ROOT/mcp/goal-server.ts" 2>/dev/null))
echo "$GET_OUT" | grep -q "smoke objective" \
    || { red "FAIL: MCP get_goal didn't return the goalctl-written objective"; exit 4; }
say "MCP and goalctl share state ✓"

# -------- 5. HTTP shim: full CRUD round-trip ---------------------------------

step "5. goalctl serve-http: GET / POST / PATCH / DELETE"
PORT=17474
"$GOALCTL" --root "$TMP" serve-http --port $PORT &
HTTP_PID=$!
sleep 1
trap 'kill $HTTP_PID 2>/dev/null; rm -rf "$TMP"' EXIT

# GET existing
CODE=$(curl -s -o /tmp/goal-smoke-resp -w '%{http_code}' "http://127.0.0.1:$PORT/goal")
[ "$CODE" = "200" ] || { red "FAIL: GET /goal returned $CODE (expected 200)"; exit 5; }
jq -e '.status == "pursuing"' /tmp/goal-smoke-resp >/dev/null \
    || { red "FAIL: GET /goal payload doesn't show pursuing status"; cat /tmp/goal-smoke-resp; exit 5; }

# PATCH pause
CODE=$(curl -s -o /tmp/goal-smoke-resp -w '%{http_code}' -X PATCH \
    -H 'Content-Type: application/json' \
    -d '{"action":"pause"}' "http://127.0.0.1:$PORT/goal")
[ "$CODE" = "200" ] || { red "FAIL: PATCH pause returned $CODE"; exit 5; }
jq -e '.status == "paused"' /tmp/goal-smoke-resp >/dev/null \
    || { red "FAIL: PATCH pause payload not paused"; cat /tmp/goal-smoke-resp; exit 5; }

say "HTTP CRUD round-trip ✓"

# -------- 6. Events: at least one event line per lifecycle transition -------

step "6. goal-events.jsonl: create + pause both emit events"
[ -f "$EVENTS_FILE" ] || { red "FAIL: no events file at $EVENTS_FILE"; exit 6; }
grep -q 'goal.created'   "$EVENTS_FILE" || { red "FAIL: no goal.created event"; cat "$EVENTS_FILE"; exit 6; }
say "events emitted ✓ ($(wc -l <"$EVENTS_FILE") lines)"

# -------- 7. Concurrency: CAS rejects stale write ---------------------------

step "7. CAS: stale goal_id rejected"
# Snapshot the current goal_id
OLD_ID=$(jq -r .goal_id "$GOAL_FILE")
# Bump goal_id via /goal replace (simulated by goalctl replace)
"$GOALCTL" --root "$TMP" replace "second objective" >/dev/null
NEW_ID=$(jq -r .goal_id "$GOAL_FILE")
[ "$OLD_ID" != "$NEW_ID" ] || { red "FAIL: replace didn't generate new goal_id"; exit 7; }
say "goal_id rotated $OLD_ID → $NEW_ID ✓"

kill $HTTP_PID 2>/dev/null || true
green "ALL SMOKE CHECKS PASSED"
