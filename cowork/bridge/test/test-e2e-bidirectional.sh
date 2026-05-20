#!/usr/bin/env bash
# Bidirectional cowork E2E with representative runner formats:
#   1. Claude-style line runner -> Codex-style NDJSON runner.
#   2. Codex-style NDJSON runner -> Claude-style line runner.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
BRIDGE="$REPO_ROOT/bin/goal-bridge"
MOCK_RUNNER="$REPO_ROOT/cowork/bridge/test/mock-runner.sh"

green() { printf '\033[32m%s\033[0m\n' "$*"; }
red() { printf '\033[31m%s\033[0m\n' "$*"; }
step() { printf '\n[%s] %s\n' "$(date -u +%H:%M:%S)" "$1"; }
fail() {
  red "FAIL [bidirectional-e2e]: $*"
  [ -n "${TMP:-}" ] && {
    printf '\n--- goal record ---\n'; cat "${STATE_FILE:-}" 2>/dev/null || true
    printf '\n--- from log ---\n'; tail -50 "$TMP/from.log" 2>/dev/null || true
    printf '\n--- to log ---\n'; tail -50 "$TMP/to.log" 2>/dev/null || true
  }
  exit 1
}

PIDS=()
TMP=""
cleanup() {
  for pid in "${PIDS[@]:-}"; do kill "$pid" 2>/dev/null || true; done
  for pid in "${PIDS[@]:-}"; do wait "$pid" 2>/dev/null || true; done
  [ -n "$TMP" ] && rm -rf "$TMP" || true
}
trap cleanup EXIT

wait_agent_id() {
  local root="$1" runner="$2" pid="$3" id=""
  for _ in $(seq 1 50); do
    sleep 0.1
    for f in "$root/.goal/agents"/"$runner"-*-"$pid".json; do
      [ -f "$f" ] && { id=$(jq -r '.agent_id' "$f"); printf '%s' "$id"; return 0; }
    done
  done
  return 1
}

write_patterns() {
  local path="$1"
  local mock_esc
  mock_esc=$(printf '%s' "$MOCK_RUNNER" | sed 's/\\/\\\\/g; s/"/\\"/g')
  cat > "$path" <<EOF
{
  "runners": {
    "claude-mock": {"format":"line","provider":"anthropic","spawn":["$mock_esc"],"rate_limit":["429","rate.?limit"],"server_error":["5\\\\d{2}"]},
    "codex-mock": {"format":"ndjson","provider":"openai","spawn":["$mock_esc"],"spawn_resume":["$mock_esc"],"rate_limit":["429","rate.?limit"],"server_error":["5\\\\d{2}"]}
  }
}
EOF
}

write_cowork() {
  local root="$1"
  cat > "$root/.goal/cowork.yml" <<EOF
version: 1
agents:
  claude:
    runner: claude-mock
  codex:
    runner: codex-mock
roles:
  lead: claude
  build: codex
  review: claude
EOF
}

write_state() {
  local root="$1" current="$2" lead="$3" build="$4"
  local now goal_id
  now=$(date -u +%FT%TZ)
  goal_id="$(uuidgen 2>/dev/null | tr 'A-Z' 'a-z' || printf 'cccccccc-dddd-eeee-ffff-000000000000')"
  mkdir -p "$root/.goal/goals"
  STATE_FILE="$root/.goal/goals/$goal_id.json"
  cat > "$STATE_FILE.tmp" <<EOF
{
  "schema_version": 2,
  "goal_id": "$goal_id",
  "objective": "bidirectional relay test",
  "status": "pursuing",
  "created_at": "$now",
  "updated_at": "$now",
  "current": { "agent": "$current", "session": null, "since": "$now" },
  "compat": ["claude-code", "codex"],
  "roles": { "lead": "$lead", "build": "$build", "review": "$lead" },
  "lineage": [],
  "budget": null,
  "audit": null,
  "handoff_head": null,
  "queued_until": null,
  "token_budget": null,
  "tokens_used": 0,
  "tick_count": 0,
  "pursuing_seconds": 0,
  "pursuing_since": "$now",
  "history": []
}
EOF
  mv "$STATE_FILE.tmp" "$STATE_FILE"
}

run_line_to_ndjson() {
  step "1. Claude-style line runner relays to Codex-style NDJSON runner"
  TMP=$(mktemp -d -t goal-e2e-line-to-ndjson-XXXXXX)
  mkdir -p "$TMP/.goal/goals" "$TMP/.goal/agents" "$TMP/.goal/handoff" "$TMP/.claude"
  write_patterns "$TMP/patterns.json"
  write_cowork "$TMP"

  MOCK_FORMAT=line MOCK_429_AFTER=1 MOCK_EXIT_AFTER=30 \
    GOAL_BRIDGE_PATTERNS="$TMP/patterns.json" \
    node "$BRIDGE" claude-mock --root "$TMP" >> "$TMP/from.log" 2>&1 &
  local from_pid=$!
  PIDS+=("$from_pid")
  MOCK_FORMAT=ndjson MOCK_TURNS=1 MOCK_429_AFTER=0 MOCK_EXIT_AFTER=30 \
    GOAL_BRIDGE_PATTERNS="$TMP/patterns.json" \
    node "$BRIDGE" codex-mock --root "$TMP" >> "$TMP/to.log" 2>&1 &
  local to_pid=$!
  PIDS+=("$to_pid")

  local from_id to_id
  from_id=$(wait_agent_id "$TMP" claude-mock "$from_pid") || fail "line agent heartbeat missing"
  to_id=$(wait_agent_id "$TMP" codex-mock "$to_pid") || fail "ndjson agent heartbeat missing"
  write_state "$TMP" "$from_id" "$from_id" "$to_id"

  for _ in $(seq 1 120); do
    sleep 0.1
    [ -f "$TMP/.goal/handoff/0001.md" ] && [ "$(jq -r '.status' "$STATE_FILE")" = "pursuing" ] && break
  done
  [ -f "$TMP/.goal/handoff/0001.md" ] || fail "line->ndjson handoff missing"
  [ "$(jq -r '.current.agent' "$STATE_FILE")" = "$to_id" ] || fail "line->ndjson did not switch to codex peer"
  grep -q '^from: claude-mock-' "$TMP/.goal/handoff/0001.md" || fail "line->ndjson handoff from mismatch"
  grep -q '^to: codex-mock-' "$TMP/.goal/handoff/0001.md" || fail "line->ndjson handoff to mismatch"

  cleanup
  PIDS=()
  TMP=""
}

run_ndjson_to_line() {
  step "2. Codex-style NDJSON runner relays to Claude-style line runner"
  TMP=$(mktemp -d -t goal-e2e-ndjson-to-line-XXXXXX)
  mkdir -p "$TMP/.goal/goals" "$TMP/.goal/agents" "$TMP/.goal/handoff" "$TMP/.claude"
  write_patterns "$TMP/patterns.json"
  write_cowork "$TMP"

  MOCK_FORMAT=ndjson MOCK_429_AFTER=1 MOCK_EXIT_AFTER=30 \
    GOAL_BRIDGE_PATTERNS="$TMP/patterns.json" \
    node "$BRIDGE" codex-mock --root "$TMP" >> "$TMP/from.log" 2>&1 &
  local from_pid=$!
  PIDS+=("$from_pid")
  MOCK_FORMAT=line MOCK_429_AFTER=0 MOCK_EXIT_AFTER=30 \
    GOAL_BRIDGE_PATTERNS="$TMP/patterns.json" \
    node "$BRIDGE" claude-mock --root "$TMP" >> "$TMP/to.log" 2>&1 &
  local to_pid=$!
  PIDS+=("$to_pid")

  local from_id to_id
  from_id=$(wait_agent_id "$TMP" codex-mock "$from_pid") || fail "ndjson agent heartbeat missing"
  to_id=$(wait_agent_id "$TMP" claude-mock "$to_pid") || fail "line agent heartbeat missing"
  write_state "$TMP" "$from_id" "$to_id" "$from_id"

  for _ in $(seq 1 120); do
    sleep 0.1
    [ -f "$TMP/.goal/handoff/0001.md" ] && [ -s "$TMP/.goal/agents/${to_id}.continue" ] && [ "$(jq -r '.status' "$STATE_FILE")" = "pursuing" ] && break
  done
  [ -f "$TMP/.goal/handoff/0001.md" ] || fail "ndjson->line handoff missing"
  [ -s "$TMP/.goal/agents/${to_id}.continue" ] || fail "line peer did not receive continuation"
  [ "$(jq -r '.current.agent' "$STATE_FILE")" = "$to_id" ] || fail "ndjson->line did not switch to claude peer"
  grep -q '"relay-pickup-line"' "$TMP/to.log" || fail "line bridge did not log relay-pickup-line"

  cleanup
  PIDS=()
  TMP=""
}

step "0. Prereqs"
command -v node >/dev/null || fail "node not installed"
command -v jq >/dev/null || fail "jq not installed"
[ -x "$BRIDGE" ] || fail "$BRIDGE not executable"
[ -x "$MOCK_RUNNER" ] || fail "$MOCK_RUNNER not executable"

run_line_to_ndjson
run_ndjson_to_line

green "ALL BIDIRECTIONAL COWORK E2E TESTS PASSED"
