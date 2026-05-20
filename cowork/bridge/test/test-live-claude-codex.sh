#!/usr/bin/env bash
# Opt-in account-backed E2E for the production cowork path:
#   1. Claude Code writes work, then forces a relay to Codex.
#   2. Codex runs through goal-bridge/codex exec, writes work, then relays to Claude.
#   3. Claude Code reads the handoff and writes the final pickup.
#
# This intentionally consumes authenticated Claude Code and Codex quota.

set -euo pipefail

if [ "${GOAL_LIVE_E2E:-0}" != "1" ]; then
  printf 'SKIP [live-claude-codex]: set GOAL_LIVE_E2E=1 to run authenticated CLI E2E\n'
  exit 0
fi

REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
BRIDGE="$REPO_ROOT/bin/goal-bridge"
GOALCTL="$REPO_ROOT/bin/goalctl"
CLAUDE_BIN="${CLAUDE_BIN:-claude}"
CODEX_BIN="${CODEX_BIN:-codex}"
CLAUDE_MAX_BUDGET_USD="${GOAL_LIVE_CLAUDE_MAX_BUDGET_USD:-0.50}"

green() { printf '\033[32m%s\033[0m\n' "$*"; }
red() { printf '\033[31m%s\033[0m\n' "$*"; }
step() { printf '\n[%s] %s\n' "$(date -u +%H:%M:%S)" "$1"; }
fail() {
  red "FAIL [live-claude-codex]: $*"
  if [ -n "${TMP:-}" ] && [ -d "$TMP" ]; then
    printf '\n--- root ---\n%s\n' "$TMP"
    printf '\n--- artifact ---\n'; cat "$TMP/LIVE_E2E.md" 2>/dev/null || true
    printf '\n--- goal record ---\n'; jq '.' "${STATE_FILE:-}" 2>/dev/null || cat "${STATE_FILE:-}" 2>/dev/null || true
    printf '\n--- events ---\n'; tail -50 "$TMP/.goal/events.jsonl" 2>/dev/null || true
    printf '\n--- logs ---\n'
    for f in "$TMP"/logs/*.log "$TMP"/.goal/agents/*.log; do
      [ -f "$f" ] || continue
      printf '\n# %s\n' "$f"
      tail -80 "$f" || true
    done
  fi
  exit 1
}

PIDS=()
TMP=""

cleanup() {
  for pid in "${PIDS[@]:-}"; do kill "$pid" 2>/dev/null || true; done
  for pid in "${PIDS[@]:-}"; do wait "$pid" 2>/dev/null || true; done
  if [ "${GOAL_LIVE_KEEP_TMP:-0}" != "1" ] && [ -n "${TMP:-}" ]; then
    rm -rf "$TMP" 2>/dev/null || true
  fi
}
trap cleanup EXIT

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "$1 not found"
}

wait_for() {
  local label="$1" timeout="${2:-180}" elapsed=0
  shift 2
  while [ "$elapsed" -lt "$timeout" ]; do
    if "$@"; then return 0; fi
    sleep 1
    elapsed=$((elapsed + 1))
    if [ $((elapsed % 30)) -eq 0 ]; then
      printf '[%s] waiting for %s (%ss)\n' "$(date -u +%H:%M:%S)" "$label" "$elapsed"
    fi
  done
  return 1
}

wait_agent_id() {
  local root="$1" runner="$2" pid="$3" id=""
  for _ in $(seq 1 100); do
    sleep 0.1
    for f in "$root/.goal/agents"/"$runner"-*-"$pid".json; do
      [ -f "$f" ] || continue
      id=$(jq -r '.agent_id' "$f" 2>/dev/null || true)
      [ -n "$id" ] && [ "$id" != "null" ] && { printf '%s' "$id"; return 0; }
    done
  done
  return 1
}

write_patterns() {
  local path="$1" codex_path
  codex_path="$(command -v "$CODEX_BIN")"
  jq -n --arg codex "$codex_path" '{
    runners: {
      "claude-code": {
        format: "line",
        provider: "anthropic",
        spawn: ["echo", "claude-code-stub"],
        rate_limit: ["429", "rate ?limit", "Too Many Requests"],
        server_error: ["5\\d{2}", "internal server error", "service unavailable"]
      },
      codex: {
        format: "ndjson",
        provider: "openai",
        spawn: [$codex, "exec", "--json", "--sandbox", "workspace-write", "-C", "{root}", "-"],
        spawn_resume: [$codex, "exec", "--json", "--sandbox", "workspace-write", "-C", "{root}", "resume", "{session_id}", "-"],
        rate_limit: ["429", "rate ?limit", "too many requests"],
        server_error: ["5\\d{2}", "internal server error", "service unavailable"]
      }
    }
  }' > "$path"
}

write_cowork() {
  local root="$1"
  cat > "$root/.goal/cowork.yml" <<'EOF'
version: 1
agents:
  claude:
    runner: claude-code
  codex:
    runner: codex
roles:
  lead: claude
  build: codex
  review: claude
relay:
  on_rate_limit: true
  on_5xx: true
heartbeat_ttl_seconds: 15
EOF
}

write_state() {
  local root="$1" current="$2" objective="$3" now goal_id
  now="$(date -u +%FT%TZ)"
  goal_id="$(uuidgen 2>/dev/null | tr 'A-Z' 'a-z' || printf '11111111-2222-3333-4444-555555555555')"
  mkdir -p "$root/.goal/goals"
  STATE_FILE="$root/.goal/goals/$goal_id.json"
  jq -n --arg gid "$goal_id" --arg obj "$objective" --arg ts "$now" --arg current "$current" '{
    schema_version: 2,
    goal_id: $gid,
    objective: $obj,
    status: "pursuing",
    created_at: $ts,
    updated_at: $ts,
    time_used_seconds: 0,
    observed_at: $ts,
    active_turn_started_at: $ts,
    tokens_used_observed_at: $ts,
    time_used_seconds_final: null,
    tokens_used_final: null,
    current: {agent: $current, session: null, since: $ts},
    compat: ["claude-code", "codex"],
    roles: {lead: "claude", build: "codex", review: "claude"},
    lineage: [],
    budget: null,
    audit: {checklist: [
      {id: "live-a", predicate: "Claude can relay to Codex", status: "open", evidence: null},
      {id: "live-b", predicate: "Codex can relay to Claude", status: "open", evidence: null}
    ]},
    handoff_head: null,
    queued_until: null,
    token_budget: null,
    tokens_used: 0,
    tick_count: 0,
    pursuing_seconds: 0,
    pursuing_since: $ts,
    history: [{ts: $ts, action: "create", note: "live e2e"}]
  }' > "$STATE_FILE.tmp"
  mv "$STATE_FILE.tmp" "$STATE_FILE"
}

start_bridge() {
  local root="$1" patterns="$2" runner="$3" log="$4"
  GOAL_BRIDGE_PATTERNS="$patterns" node "$BRIDGE" "$runner" --root "$root" >> "$log" 2>&1 &
  PIDS+=("$!")
  printf '%s' "$!"
}

run_claude_prompt() {
  local root="$1" prompt="$2" log="$3"
  (
    cd "$root"
    "$CLAUDE_BIN" -p \
      --output-format json \
      --permission-mode bypassPermissions \
      --max-budget-usd "$CLAUDE_MAX_BUDGET_USD" \
      "$prompt"
  ) >> "$log" 2>&1
}

reset_tmp() {
  cleanup
  PIDS=()
  TMP="$(mktemp -d -t goal-live-e2e-XXXXXX)"
  mkdir -p "$TMP/.goal/goals" "$TMP/.goal/agents" "$TMP/.goal/handoff" "$TMP/.claude" "$TMP/logs"
  git -C "$TMP" init -q
  printf '# /goal live E2E\n' > "$TMP/LIVE_E2E.md"
  write_cowork "$TMP"
  write_patterns "$TMP/patterns.json"
}

has_line() {
  local root="$1" line="$2"
  grep -qxF "$line" "$root/LIVE_E2E.md"
}

state_is() {
  local root="$1" status="$2" agent="$3"
  local state_file="${STATE_FILE:-}"
  [ -f "$state_file" ] || state_file="$(find "$root/.goal/goals" -maxdepth 1 -type f -name '*.json' | head -1)"
  [ "$(jq -r '.status' "$state_file")" = "$status" ] &&
    [ "$(jq -r '.current.agent' "$state_file")" = "$agent" ]
}

run_claude_to_codex() {
  step "1. Claude Code relays to Codex"
  reset_tmp

  local claude_pid codex_pid claude_id codex_id objective prompt
  claude_pid=$(start_bridge "$TMP" "$TMP/patterns.json" claude-code "$TMP/logs/claude-bridge.log")
  codex_pid=$(start_bridge "$TMP" "$TMP/patterns.json" codex "$TMP/logs/codex-bridge.log")
  claude_id=$(wait_agent_id "$TMP" claude-code "$claude_pid") || fail "Claude bridge heartbeat missing"
  codex_id=$(wait_agent_id "$TMP" codex "$codex_pid") || fail "Codex bridge heartbeat missing"

  objective="Live E2E A. Claude Code appends CLAUDE_TO_CODEX_START and forces a relay. When Codex receives the handoff, it must append CODEX_PICKUP_FROM_CLAUDE to LIVE_E2E.md exactly once, inspect .goal/handoff/0001.md, then stop without marking the goal complete."
  write_state "$TMP" "$claude_id" "$objective"

  prompt="You are the Claude Code half of a /goal cowork live E2E in $TMP.
Do exactly these steps:
1. Append exactly one line to LIVE_E2E.md: CLAUDE_TO_CODEX_START
2. Run this command: $GOALCTL --root $TMP relay --json
3. Stop. Do not mark the goal complete. Do not edit files outside $TMP."
  run_claude_prompt "$TMP" "$prompt" "$TMP/logs/claude-live-a.log" || fail "Claude start command failed"

  wait_for "Codex pickup from Claude" 240 has_line "$TMP" "CODEX_PICKUP_FROM_CLAUDE" ||
    fail "Codex did not append CODEX_PICKUP_FROM_CLAUDE"
  wait_for "Claude to Codex state recovery" 120 state_is "$TMP" "pursuing" "$codex_id" ||
    fail "state did not recover to pursuing on Codex"

  has_line "$TMP" "CLAUDE_TO_CODEX_START" || fail "Claude start line missing"
  grep -q '^from: claude-code-' "$TMP/.goal/handoff/0001.md" || fail "handoff from Claude missing"
  grep -q '^to: codex-' "$TMP/.goal/handoff/0001.md" || fail "handoff to Codex missing"
  grep -q '"type":"goal.relayed"' "$TMP/.goal/events.jsonl" || fail "goal.relayed event missing"
  grep -q '"type":"goal.handoff.peer_picked_up"' "$TMP/.goal/events.jsonl" || fail "peer pickup event missing"
}

run_codex_to_claude() {
  step "2. Codex relays to Claude Code"
  reset_tmp

  local claude_pid codex_pid claude_id codex_id objective prompt
  claude_pid=$(start_bridge "$TMP" "$TMP/patterns.json" claude-code "$TMP/logs/claude-bridge.log")
  codex_pid=$(start_bridge "$TMP" "$TMP/patterns.json" codex "$TMP/logs/codex-bridge.log")
  claude_id=$(wait_agent_id "$TMP" claude-code "$claude_pid") || fail "Claude bridge heartbeat missing"
  codex_id=$(wait_agent_id "$TMP" codex "$codex_pid") || fail "Codex bridge heartbeat missing"

  objective="Live E2E B. When Codex starts, append CODEX_TO_CLAUDE_START to LIVE_E2E.md exactly once, run '$GOALCTL --root $TMP relay --json' to relay to Claude Code, then stop. Claude Code will read .goal/handoff/0001.md and append CLAUDE_PICKUP_FROM_CODEX."
  write_state "$TMP" "$codex_id" "$objective"

  wait_for "Codex start line" 240 has_line "$TMP" "CODEX_TO_CLAUDE_START" ||
    fail "Codex did not append CODEX_TO_CLAUDE_START"
  wait_for "Claude line-mode pickup" 180 state_is "$TMP" "pursuing" "$claude_id" ||
    fail "state did not recover to pursuing on Claude"
  [ -s "$TMP/.goal/agents/${claude_id}.continue" ] || fail "Claude continuation file missing"
  grep -q '^from: codex-' "$TMP/.goal/handoff/0001.md" || fail "handoff from Codex missing"
  grep -q '^to: claude-code-' "$TMP/.goal/handoff/0001.md" || fail "handoff to Claude missing"

  prompt="You are the Claude Code pickup half of a /goal cowork live E2E in $TMP.
Read .goal/handoff/0001.md and LIVE_E2E.md.
Append exactly one line to LIVE_E2E.md: CLAUDE_PICKUP_FROM_CODEX
Then stop. Do not mark the goal complete. Do not edit files outside $TMP."
  run_claude_prompt "$TMP" "$prompt" "$TMP/logs/claude-live-b.log" || fail "Claude pickup command failed"

  has_line "$TMP" "CLAUDE_PICKUP_FROM_CODEX" || fail "Claude pickup line missing"
  grep -q '"type":"goal.relayed"' "$TMP/.goal/events.jsonl" || fail "goal.relayed event missing"
  grep -q '"type":"goal.relay.recovery_seconds"' "$TMP/.goal/events.jsonl" || fail "relay recovery event missing"
}

step "0. Prereqs"
require_cmd jq
require_cmd git
require_cmd node
require_cmd "$CLAUDE_BIN"
require_cmd "$CODEX_BIN"
[ -x "$BRIDGE" ] || fail "$BRIDGE not executable"
[ -x "$GOALCTL" ] || fail "$GOALCTL not executable"

run_claude_to_codex
run_codex_to_claude

green "ALL LIVE CLAUDE CODE ↔ CODEX E2E CHECKS PASSED"
