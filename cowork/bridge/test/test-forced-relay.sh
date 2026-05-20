#!/usr/bin/env bash
# Verify externally requested relay: goalctl writes .goal/agents/<agent>.fault,
# goal-bridge consumes it, writes a handoff, and the peer resumes.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
BRIDGE="$REPO_ROOT/bin/goal-bridge"
GOALCTL="$REPO_ROOT/bin/goalctl"
MOCK_RUNNER="$REPO_ROOT/cowork/bridge/test/mock-runner.sh"

green() { printf '\033[32m%s\033[0m\n' "$*"; }
red() { printf '\033[31m%s\033[0m\n' "$*"; }
step() { printf '\n[%s] %s\n' "$(date -u +%H:%M:%S)" "$1"; }
fail() {
  red "FAIL [forced-relay]: $*"
  [ -n "${TMP:-}" ] && {
    printf '\n--- goal record ---\n'; cat "${STATE_FILE:-}" 2>/dev/null || true
    printf '\n--- bridge-a ---\n'; tail -40 "$TMP/bridge-a.log" 2>/dev/null || true
    printf '\n--- bridge-b ---\n'; tail -40 "$TMP/bridge-b.log" 2>/dev/null || true
  }
  exit 1
}

TMP=""
BRIDGE_A_PID=""
BRIDGE_B_PID=""
cleanup() {
  [ -n "$BRIDGE_A_PID" ] && kill "$BRIDGE_A_PID" 2>/dev/null || true
  [ -n "$BRIDGE_B_PID" ] && kill "$BRIDGE_B_PID" 2>/dev/null || true
  wait "$BRIDGE_A_PID" 2>/dev/null || true
  wait "$BRIDGE_B_PID" 2>/dev/null || true
  [ -n "$TMP" ] && rm -rf "$TMP" || true
}
trap cleanup EXIT

step "0. Prereqs"
command -v node >/dev/null || fail "node not installed"
command -v jq >/dev/null || fail "jq not installed"
[ -x "$BRIDGE" ] || fail "$BRIDGE not executable"
[ -x "$GOALCTL" ] || fail "$GOALCTL not executable"
[ -x "$MOCK_RUNNER" ] || fail "$MOCK_RUNNER not executable"

TMP=$(mktemp -d -t goal-forced-relay-XXXXXX)
mkdir -p "$TMP/.goal/goals" "$TMP/.goal/agents" "$TMP/.goal/handoff" "$TMP/.claude"
NOW=$(date -u +%FT%TZ)
GOAL_UUID="bbbbbbbb-cccc-dddd-eeee-ffffffffffff"
STATE_FILE="$TMP/.goal/goals/$GOAL_UUID.json"

MOCK_ESC=$(printf '%s' "$MOCK_RUNNER" | sed 's/\\/\\\\/g; s/"/\\"/g')
PATTERNS_JSON="$TMP/patterns.json"
cat > "$PATTERNS_JSON" <<EOF
{
  "runners": {
    "mock-a": {"format":"ndjson","provider":"openai","spawn":["$MOCK_ESC"],"spawn_resume":["$MOCK_ESC"],"rate_limit":["429"],"server_error":["5\\\\d{2}"]},
    "mock-c": {"format":"ndjson","provider":"openai","spawn":["$MOCK_ESC"],"spawn_resume":["$MOCK_ESC"],"rate_limit":["429"],"server_error":["5\\\\d{2}"]},
    "mock-b": {"format":"ndjson","provider":"anthropic","spawn":["$MOCK_ESC"],"spawn_resume":["$MOCK_ESC"],"rate_limit":["429"],"server_error":["5\\\\d{2}"]}
  }
}
EOF
cat > "$TMP/.goal/cowork.yml" <<COWORK
version: 1
agents:
  lead_agent:
    runner: mock-a
  build_agent:
    runner: mock-b
roles:
  lead: lead_agent
  build: build_agent
  review: lead_agent
COWORK

step "1. Start two bridges"
MOCK_FORMAT=ndjson MOCK_TURNS=5 MOCK_429_AFTER=0 MOCK_EXIT_AFTER=30 \
  GOAL_BRIDGE_PATTERNS="$PATTERNS_JSON" \
  node "$BRIDGE" mock-a --root "$TMP" >> "$TMP/bridge-a.log" 2>&1 &
BRIDGE_A_PID=$!
MOCK_FORMAT=ndjson MOCK_TURNS=1 MOCK_429_AFTER=0 MOCK_EXIT_AFTER=30 \
  GOAL_BRIDGE_PATTERNS="$PATTERNS_JSON" \
  node "$BRIDGE" mock-b --root "$TMP" >> "$TMP/bridge-b.log" 2>&1 &
BRIDGE_B_PID=$!

AGENT_A=""
AGENT_B=""
for _ in $(seq 1 50); do
  sleep 0.1
  [ -n "$AGENT_A" ] || for f in "$TMP/.goal/agents"/mock-a-*-"$BRIDGE_A_PID".json; do [ -f "$f" ] && AGENT_A=$(jq -r '.agent_id' "$f"); done
  [ -n "$AGENT_B" ] || for f in "$TMP/.goal/agents"/mock-b-*-"$BRIDGE_B_PID".json; do [ -f "$f" ] && AGENT_B=$(jq -r '.agent_id' "$f"); done
  [ -n "$AGENT_A" ] && [ -n "$AGENT_B" ] && break
done
[ -n "$AGENT_A" ] || fail "agent A heartbeat missing"
[ -n "$AGENT_B" ] || fail "agent B heartbeat missing"

step "2. Assign agent A and request relay via goalctl"
cat > "$STATE_FILE.tmp" <<EOF
{
  "schema_version": 2,
  "goal_id": "$GOAL_UUID",
  "objective": "forced relay test goal",
  "status": "pursuing",
  "created_at": "$NOW",
  "updated_at": "$NOW",
  "current": { "agent": "$AGENT_A", "session": null, "since": "$NOW" },
  "compat": ["claude-code", "codex"],
  "roles": { "lead": "$AGENT_A", "build": "$AGENT_B", "review": null },
  "lineage": [],
  "budget": null,
  "audit": null,
  "handoff_head": null,
  "queued_until": null,
  "token_budget": null,
  "tokens_used": 0,
  "tick_count": 0,
  "pursuing_seconds": 0,
  "pursuing_since": "$NOW",
  "history": []
}
EOF
mv "$STATE_FILE.tmp" "$STATE_FILE"
"$GOALCTL" --root "$TMP" relay --json >/tmp/goal-forced-relay.json
jq -e '.ok == true' /tmp/goal-forced-relay.json >/dev/null || fail "goalctl relay did not return ok"

step "3. Bridge consumes fault and writes handoff"
for _ in $(seq 1 80); do
  sleep 0.1
  [ -f "$TMP/.goal/handoff/0001.md" ] && break
done
[ -f "$TMP/.goal/handoff/0001.md" ] || fail "handoff/0001.md not written"
grep -q '^reason: user' "$TMP/.goal/handoff/0001.md" || fail "handoff reason is not user"
grep -q '"external-fault-consumed"' "$TMP/bridge-a.log" || fail "bridge did not log external-fault-consumed"

step "4. Peer resumes"
for _ in $(seq 1 120); do
  sleep 0.1
  STATUS=$(jq -r '.status' "$STATE_FILE" 2>/dev/null || echo "")
  [ "$STATUS" = "pursuing" ] && break
done
[ "$(jq -r '.status' "$STATE_FILE")" = "pursuing" ] || fail "state did not return to pursuing"
[ "$(jq -r '.current.agent' "$STATE_FILE")" = "$AGENT_B" ] || fail "current agent is not peer"

green "ALL FORCED RELAY TESTS PASSED"
