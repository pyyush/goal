#!/usr/bin/env bash
# cowork/bridge/test/test-otel-lane-conflict.sh
#
# P6: end-to-end verification that the goal.lane.conflict OTEL counter
# fires when an MCP claim_lane call hits a conflicting existing lease.
#
# What we test (closes audit a19 for the lane-conflict counter):
#   1. claim_lane glob='src/**' from agent-A succeeds → lanes.json persists.
#   2. claim_lane glob='src/foo.ts' from agent-B (state.current.agent
#      changed between calls) is denied with conflict_with set.
#   3. The events.jsonl file contains a goal.lane.conflict line with the
#      expected payload (goal_id, glob, holder, conflict_with).
#   4. The OTEL exporter consumes that line cleanly.
#
# IMPORTANT: env vars must be EXPORTED, not prefix-assigned, so the spawned
# node child inherits them. Bash command-prefix env vars (`VAR=x cmd | node`)
# only apply to the FIRST command in the pipeline. Same pattern as
# scripts/smoke-phase-1.sh step 3.
#
# Exit codes: 0 = pass, non-zero on first failed assertion.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
TMP=$(mktemp -d -t goal-otel-lane-conflict-XXXXXX)
trap 'rm -rf "$TMP"' EXIT

green() { printf '\033[32m%s\033[0m\n' "$*"; }
red()   { printf '\033[31m%s\033[0m\n' "$*"; }
say()   { printf '  %s\n' "$*"; }
step()  { printf '\n[%s] %s\n' "$(date -u +%H:%M:%S)" "$1"; }

step "1. Set up v2 goal fixture (current.agent = agent-A)"

mkdir -p "$TMP/.goal" "$TMP/.claude"
GOAL_ID="$(uuidgen 2>/dev/null | tr 'A-Z' 'a-z' || printf 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')"
NOW="$(date -u +%FT%TZ)"
write_state() {
    local agent="$1"
    cat > "$TMP/.goal/state.json" <<STATE
{
  "schema_version": 2,
  "goal_id": "$GOAL_ID",
  "objective": "lane conflict otel test",
  "status": "pursuing",
  "created_at": "$NOW",
  "updated_at": "$NOW",
  "current": { "agent": "$agent", "session": null, "since": "$NOW" },
  "roles": { "lead": "agent-A", "build": "agent-B", "review": null },
  "compat": ["claude-code"],
  "lineage": [],
  "budget": null,
  "audit": null,
  "handoff_head": null,
  "queued_until": null,
  "token_budget": null,
  "tokens_used": 0,
  "pursuing_seconds": 0,
  "pursuing_since": "$NOW"
}
STATE
}
write_state "agent-A"
say "fixture written ✓"

# Export env so the node child actually sees them (see header note).
export GOAL_ROOT="$TMP"
SERVER="$REPO_ROOT/mcp/dist/goal-server.js"
[ -f "$SERVER" ] || { red "FAIL: built MCP server not found at $SERVER (run: cd mcp && npm run build)"; exit 1; }

step "2. agent-A claim_lane glob='src/**' (should succeed and persist)"
RESP1=$(printf '%s\n%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"otel-test","version":"0"}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"claim_lane","arguments":{"glob":"src/**","ttl_seconds":600,"reason":"hold src tree"}}}' \
  | node "$SERVER" 2>/dev/null)
echo "$RESP1" | grep -q 'lease_id' || { red "FAIL: first claim_lane should return lease_id"; printf '%s\n' "$RESP1" | head -5; exit 2; }
[ -f "$TMP/.goal/lanes.json" ] || { red "FAIL: lanes.json not persisted after first claim"; exit 2; }
LEASE_COUNT=$(jq '.leases | length' "$TMP/.goal/lanes.json")
[ "$LEASE_COUNT" = "1" ] || { red "FAIL: expected 1 lease in lanes.json, got $LEASE_COUNT"; cat "$TMP/.goal/lanes.json"; exit 2; }
say "first claim succeeded, lanes.json has 1 lease ✓"

step "3. Switch current.agent to agent-B, then claim_lane glob='src/foo.ts' (should conflict)"
write_state "agent-B"
RESP2=$(printf '%s\n%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"otel-test","version":"0"}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"claim_lane","arguments":{"glob":"src/foo.ts","ttl_seconds":600,"reason":"second claim"}}}' \
  | node "$SERVER" 2>/dev/null)
echo "$RESP2" | grep -q 'conflict_with' || {
    red "FAIL: agent-B claim should report conflict_with (agent-A holds src/**)"
    printf '%s\n' "$RESP2" | head -5
    exit 3
}
say "agent-B claim correctly denied with conflict_with ✓"

step "4. Assert goal.lane.conflict event in .claude/goal-events.jsonl"
EVENTS_FILE="$TMP/.claude/goal-events.jsonl"
[ -f "$EVENTS_FILE" ] || { red "FAIL: events file not created at $EVENTS_FILE"; exit 4; }
if ! grep -q '"type":"goal.lane.conflict"' "$EVENTS_FILE"; then
    red "FAIL: events file missing goal.lane.conflict line"
    say "events file contents:"
    cat "$EVENTS_FILE"
    exit 4
fi
COUNT=$(grep -c '"type":"goal.lane.conflict"' "$EVENTS_FILE")
say "goal.lane.conflict events emitted: $COUNT ✓"

step "5. Assert event payload has goal_id, glob, conflict_with, holder"
LINE=$(grep '"type":"goal.lane.conflict"' "$EVENTS_FILE" | head -1)
for field in goal_id glob conflict_with holder; do
    echo "$LINE" | grep -q "\"$field\":" || {
        red "FAIL: emitted event missing field '$field'"
        printf '  line: %s\n' "$LINE"
        exit 5
    }
done
EVT_GOAL_ID=$(echo "$LINE" | jq -r '.goal_id')
EVT_HOLDER=$(echo "$LINE" | jq -r '.holder')
[ "$EVT_GOAL_ID" = "$GOAL_ID" ] || { red "FAIL: event goal_id mismatch (expected $GOAL_ID, got $EVT_GOAL_ID)"; exit 5; }
[ "$EVT_HOLDER" = "agent-B" ] || { red "FAIL: event holder should be agent-B (the would-be claimer), got $EVT_HOLDER"; exit 5; }
say "event payload correct: goal_id=$EVT_GOAL_ID, holder=$EVT_HOLDER ✓"

step "6. Static check: OTEL exporter declares the counter + dispatch case"
grep -q 'createCounter("goal.lane.conflict"' "$REPO_ROOT/bin/goal-otel-exporter.ts" || {
    red "FAIL: counter goal.lane.conflict not declared in goal-otel-exporter.ts"
    exit 6
}
grep -q '"goal.lane.conflict"' "$REPO_ROOT/bin/goal-otel-exporter.ts" || {
    red "FAIL: dispatch case for goal.lane.conflict missing"
    exit 6
}
say "goal-otel-exporter.ts declares lane_conflict counter + dispatch case ✓"

green "ALL P6 OTEL LANE-CONFLICT TESTS PASSED (a19 evidence — emit + counter end-to-end)"
