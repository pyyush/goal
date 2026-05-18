#!/usr/bin/env bash
# hooks/test-stop-quiet.sh — regression test for accounting-only Stop hook mode.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STOP="$ROOT/hooks/goal-stop.sh"

green() { printf '\033[32m%s\033[0m\n' "$*"; }
red() { printf '\033[31m%s\033[0m\n' "$*"; }
fail() { red "FAIL [stop-quiet]: $*"; exit 1; }

[ -f "$STOP" ] || fail "missing $STOP"

TMP=$(mktemp -d -t goal-stop-quiet-XXXXXX)
trap 'rm -rf "$TMP"' EXIT

PROJECT="$TMP/project"
GDIR="$PROJECT/.goal"
GID="11111111-2222-3333-4444-555555555555"
SID="sess-stop-quiet"
NOW=$(date -u +%FT%TZ)
mkdir -p "$GDIR/goals" "$GDIR/sessions" "$GDIR/cursors" "$GDIR/locks"
printf '%s\n' "$GID" > "$GDIR/sessions/$SID"

jq -n --arg gid "$GID" --arg now "$NOW" '{
  schema_version: 2,
  goal_id: $gid,
  objective: "quiet stop hook smoke goal",
  status: "pursuing",
  created_at: $now,
  updated_at: $now,
  time_used_seconds: 0,
  observed_at: $now,
  active_turn_started_at: $now,
  tokens_used_observed_at: $now,
  time_used_seconds_final: null,
  tokens_used_final: null,
  token_budget: null,
  tokens_used: 0,
  tick_count: 0,
  pursuing_seconds: 0,
  pursuing_since: $now,
  history: []
}' > "$GDIR/goals/$GID.json"

TRANSCRIPT="$TMP/transcript.jsonl"
printf '%s\n' '{"type":"assistant","message":{"usage":{"input_tokens":2,"output_tokens":3,"cache_creation_input_tokens":0},"content":[{"type":"tool_use","id":"toolu_stop_quiet"}]},"costUSD":0.001}' > "$TRANSCRIPT"
jq --arg transcript "$TRANSCRIPT" \
    '.accounting = {last_tokens:0,last_cost:0,transcript:$transcript,updated_at:.updated_at}' \
    "$GDIR/goals/$GID.json" > "$GDIR/goals/$GID.tmp" &&
    mv "$GDIR/goals/$GID.tmp" "$GDIR/goals/$GID.json"

INPUT=$(jq -nc --arg sid "$SID" --arg cwd "$PROJECT" --arg transcript "$TRANSCRIPT" \
    '{session_id:$sid,cwd:$cwd,transcript_path:$transcript}')

QUIET_OUT=$(printf '%s' "$INPUT" | GOAL_STOP_CONTINUE=0 bash "$STOP")
[ -z "$QUIET_OUT" ] || fail "quiet mode should not emit a Stop-hook block, got: $QUIET_OUT"

[ "$(jq -r '.tokens_used' "$GDIR/goals/$GID.json")" = "5" ] ||
    fail "quiet mode should still account token usage"
[ "$(jq -r '.tick_count' "$GDIR/goals/$GID.json")" = "0" ] ||
    fail "quiet mode should not run the continuation dispatcher"
grep -q '"event":"continue-suppressed"' "$GDIR/events.jsonl" ||
    fail "quiet mode should log continue-suppressed"

AUTO_OUT=$(printf '%s' "$INPUT" | GOAL_STOP_PROMPT_STYLE=compact bash "$STOP")
printf '%s\n' "$AUTO_OUT" | jq -e '.decision == "block"' >/dev/null ||
    fail "compact prompt mode should still emit decision:block"
AUTO_REASON=$(printf '%s\n' "$AUTO_OUT" | jq -r '.reason')
case "$AUTO_REASON" in
    *$'\n'*) fail "compact prompt should be one line, got: $AUTO_REASON" ;;
esac
[ "${#AUTO_REASON}" -le 320 ] ||
    fail "compact prompt should stay short (${#AUTO_REASON} chars): $AUTO_REASON"

green "ALL STOP QUIET CHECKS PASSED"
