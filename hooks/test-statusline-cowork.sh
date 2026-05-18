#!/usr/bin/env bash
# hooks/test-statusline-cowork.sh — v3 statusline task/cowork rendering smoke.
#
# Verifies the statusline renders only for the owning session and includes the
# task-level checkpoint, relay, and queue states users rely on during long runs.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STATUSLINE="$REPO_ROOT/hooks/goal-statusline.sh"

fail() { printf 'FAIL [statusline]: %s\n' "$*" >&2; exit 1; }
say() { printf '  %s\n' "$*"; }

[ -f "$STATUSLINE" ] || fail "missing $STATUSLINE"
command -v jq >/dev/null 2>&1 || fail "jq not found"

TMP=$(mktemp -d -t goal-statusline-v3-XXXXXX)
trap 'rm -rf "$TMP"' EXIT

PROJECT="$TMP/project"
GOAL_DIR="$PROJECT/.goal"
GOALS_DIR="$GOAL_DIR/goals"
SESSIONS_DIR="$GOAL_DIR/sessions"
mkdir -p "$GOALS_DIR" "$SESSIONS_DIR"

GID="aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
SID="sess-statusline"
NOW="2026-05-18T04:00:00Z"
printf '%s\n' "$GID" > "$SESSIONS_DIR/$SID"

write_goal() {
    jq -n --arg gid "$GID" --arg now "$NOW" "$1" > "$GOALS_DIR/$GID.json"
}

render() {
    GOAL_STATUSLINE_STYLE=plain bash "$STATUSLINE" "$PROJECT" "${1:-$SID}" 2>/dev/null || true
}

assert_contains() {
    local out="$1" needle="$2" label="$3"
    printf '%s' "$out" | grep -qF "$needle" || fail "$label: expected '$needle' in [$out]"
    say "$label"
}

assert_empty() {
    local out="$1" label="$2"
    [ -z "$out" ] || fail "$label: expected empty output, got [$out]"
    say "$label"
}

write_goal '{
  schema_version: 2,
  goal_id: $gid,
  objective: "Task cockpit goal",
  spec: {title: "Ship task cockpit"},
  status: "pursuing",
  created_at: $now,
  updated_at: $now,
  time_used_seconds: 120,
  observed_at: $now,
  token_budget: null,
  tokens_used: 0,
  tick_count: 1,
  idle_strikes: 0,
  pursuing_seconds: 120,
  pursuing_since: $now,
  history: [{ts:$now, action:"tick", note:"progress observed"}],
  current: {agent:"codex", session:null, since:$now},
  audit: {checklist:[
    {id:"t1", predicate:"map tasks", status:"confirmed", evidence:"smoke"},
    {id:"t2", predicate:"render current task", status:"open", evidence:null}
  ]}
}'

out=$(render)
assert_contains "$out" "◎" "healthy glyph"
assert_contains "$out" "Ship task cockpit" "goal title"
assert_contains "$out" "t2 render current task" "current task"
assert_contains "$out" "1/2" "audit count"
assert_empty "$(render stranger)" "unowned session renders nothing"

write_goal '{
  schema_version: 2,
  goal_id: $gid,
  objective: "Task cockpit goal",
  spec: {title: "Ship task cockpit"},
  status: "relaying",
  created_at: $now,
  updated_at: $now,
  time_used_seconds: 120,
  observed_at: $now,
  token_budget: null,
  tokens_used: 0,
  tick_count: 1,
  pursuing_seconds: 120,
  pursuing_since: null,
  history: [{ts:$now, action:"relay", note:"rate limit"}],
  current: {agent:"codex", session:null, since:$now},
  audit: {checklist:[
    {id:"t1", predicate:"map tasks", status:"confirmed", evidence:"smoke"},
    {id:"t2", predicate:"render current task", status:"open", evidence:null}
  ]}
}'
out=$(render)
assert_contains "$out" "↔ relaying" "relaying label"
assert_contains "$out" "codex" "relaying agent"

write_goal '{
  schema_version: 2,
  goal_id: $gid,
  objective: "Task cockpit goal",
  spec: {title: "Ship task cockpit"},
  status: "queued",
  queued_until: "2026-05-18T05:00:00Z",
  created_at: $now,
  updated_at: $now,
  time_used_seconds: 120,
  observed_at: $now,
  token_budget: null,
  tokens_used: 0,
  tick_count: 1,
  pursuing_seconds: 120,
  pursuing_since: null,
  history: [{ts:$now, action:"queue", note:"all peers throttled"}],
  current: {agent:"codex", session:null, since:$now},
  audit: {checklist:[
    {id:"t1", predicate:"map tasks", status:"confirmed", evidence:"smoke"},
    {id:"t2", predicate:"render current task", status:"open", evidence:null}
  ]}
}'
out=$(render)
assert_contains "$out" "⌛ queued" "queued label"
assert_contains "$out" "retry 2026-05-18T05:00:00Z" "queued retry"

printf 'ALL STATUSLINE V3 CHECKS PASSED\n'
