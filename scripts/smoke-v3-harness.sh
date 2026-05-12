#!/usr/bin/env bash
# Focused v3 harness smoke: schema/live rendering, scoped MCP tools, CLI product
# layer, history/debrief, PR scaffold, and git sync roundtrip.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
GOALCTL="$ROOT/bin/goalctl"
STATUSLINE="$ROOT/hooks/goal-statusline.sh"
MCP="$ROOT/mcp/dist/goal-server.js"

green() { printf '\033[32m%s\033[0m\n' "$*"; }
red() { printf '\033[31m%s\033[0m\n' "$*"; }
fail() { red "FAIL: $*"; exit 1; }
step() { printf '\n[%s] %s\n' "$(date -u +%H:%M:%S)" "$1"; }

TMP=$(mktemp -d -t goal-v3-smoke-XXXXXX)
trap 'rm -rf "$TMP"' EXIT

step "1. Authoring scaffold and --quick"
"$GOALCTL" --root "$TMP" create "Refactor auth module" >/dev/null
[ "$(jq '.audit.checklist | length' "$TMP/.goal/state.json")" -ge 3 ] || fail "default scaffold did not create audit items"
"$GOALCTL" --root "$TMP" clear >/dev/null
"$GOALCTL" --root "$TMP" create --quick "Quick objective" >/dev/null
[ "$(jq -r '.audit == null' "$TMP/.goal/state.json")" = "true" ] || fail "--quick should skip audit scaffold"

step "2. Template instantiation and backlog decomposition"
"$GOALCTL" --root "$TMP" clear >/dev/null
"$GOALCTL" --root "$TMP" create --template bug-fix --decompose "Fix login bug" >/tmp/v3-template.out 2>/tmp/v3-template.err
[ "$(jq '.audit.checklist | length' "$TMP/.goal/state.json")" -eq 3 ] || fail "template audit count"
[ "$(jq -r '.budget.kind' "$TMP/.goal/state.json")" = "tokens" ] || fail "template budget"
[ "$(jq -r '.roles.build' "$TMP/.goal/state.json")" = "codex" ] || fail "template roles"
[ "$(wc -l < "$TMP/.goal/backlog.jsonl")" -eq 2 ] || fail "decompose backlog lines"
"$GOALCTL" --root "$TMP" template list >/tmp/v3-templates
grep -q dependency-upgrade /tmp/v3-templates || fail "template list missing shipped template"

step "3. V3 statusline live time, token freshness, and final snapshot"
NOW=$(date -u +%FT%TZ)
OLD=$(date -u -v-45S +%FT%TZ 2>/dev/null || date -u -d '45 seconds ago' +%FT%TZ)
jq --arg now "$NOW" --arg old "$OLD" '
  .status="pursuing" | .token_budget=50000 | .tokens_used=12500 |
  .time_used_seconds=300 | .observed_at=$now | .active_turn_started_at=$now |
  .tokens_used_observed_at=$old
' "$TMP/.goal/state.json" > "$TMP/.goal/state.tmp" && mv "$TMP/.goal/state.tmp" "$TMP/.goal/state.json"
touch "$TMP/.goal/heartbeat"
OUT=$(GOAL_STATUSLINE_STYLE=plain bash "$STATUSLINE" "$TMP" "" 2>/dev/null)
printf '%s\n' "$OUT" | grep -q '12.5K/50K\*' || fail "statusline missing stale token asterisk: $OUT"
jq '.status="achieved" | .time_used_seconds_final=420 | .tokens_used_final=47000 | .active_turn_started_at=null' "$TMP/.goal/state.json" > "$TMP/.goal/state.tmp" && mv "$TMP/.goal/state.tmp" "$TMP/.goal/state.json"
OUT=$(GOAL_STATUSLINE_STYLE=plain bash "$STATUSLINE" "$TMP" "" 2>/dev/null)
printf '%s\n' "$OUT" | grep -q '✓ 7m · 47K tokens' || fail "achieved final snapshot render: $OUT"

step "4. MCP scoped tools: progress, breadcrumbs, stuck, queue, steer"
rpc() {
  GOAL_ROOT="$TMP" node "$MCP" <<EOF | tail -n 1
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"v3-smoke","version":"0"}}}
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"$1","arguments":$2}}
EOF
}
jq '.status="pursuing" | .time_used_seconds=0 | .observed_at=$now | .active_turn_started_at=$now' --arg now "$NOW" "$TMP/.goal/state.json" > "$TMP/.goal/state.tmp" && mv "$TMP/.goal/state.tmp" "$TMP/.goal/state.json"
rpc report_progress '{"audit_item_id":"a1","status":"passed","evidence_ref":"v3-smoke"}' >/tmp/v3-rpc
[ "$(jq -r '.audit.checklist[] | select(.id=="a1") | .status' "$TMP/.goal/state.json")" = "passed" ] || fail "report_progress did not mark audit"
for i in 1 2 3; do rpc record_breadcrumb '{"audit_item":"a2","approach":"ran same failing test command","outcome":"still fails","evidence_ref":"events:test"}' >/dev/null; done
grep -q "similar approaches 3 times" "$TMP/.goal/preamble.md" || fail "anti-loop preamble note missing"
rpc queue_message '{"session_id":"s1","text":"next turn"}' >/dev/null
[ -s "$TMP/.goal/queue/s1.jsonl" ] || fail "queue_message did not write queue"
rpc steer_message '{"session_id":"s1","text":"mid turn"}' >/dev/null
[ -s "$TMP/.goal/steers/s1.jsonl" ] || fail "steer_message did not write steer"
rpc report_stuck '{"audit_item_id":"a2","reason":"blocked","attempts":5}' >/dev/null
[ "$(jq -r '.status' "$TMP/.goal/state.json")" = "paused" ] || fail "report_stuck attempts=5 should pause"

step "5. Watch, history, debrief, PR, notifier/webhook, sync"
jq '.status="achieved" | .time_used_seconds_final=420 | .tokens_used_final=47000' "$TMP/.goal/state.json" > "$TMP/.goal/state.tmp" && mv "$TMP/.goal/state.tmp" "$TMP/.goal/state.json"
"$GOALCTL" --root "$TMP" watch --once >/tmp/v3-watch
grep -q 'Audit checklist' /tmp/v3-watch || fail "watch missing audit pane"
grep -q 'Token graph' /tmp/v3-watch || fail "watch missing token graph"
"$GOALCTL" --root "$TMP" history archive --retry >/tmp/v3-archive
"$GOALCTL" --root "$TMP" history list >/tmp/v3-history
grep -q 'Fix login bug' /tmp/v3-history || fail "history list missing archived goal"
"$GOALCTL" --root "$TMP" debrief >/tmp/v3-debrief
grep -q 'Goal Debrief' /tmp/v3-debrief || fail "debrief missing"
"$GOALCTL" --root "$TMP" pr --json >/tmp/v3-pr
jq -e '.pushes == false and (.title | length > 0)' /tmp/v3-pr >/dev/null || fail "pr scaffold should not push"
"$GOALCTL" --root "$TMP" notifier start >/dev/null
[ -f "$TMP/.goal/notifier.pid" ] || fail "notifier marker missing"
printf '{"webhook":{"url":"mock","secret":"s"}}\n' > "$TMP/.goal/notification-test.json"
node "$ROOT/bin/goal-v3" notify-webhook "$TMP" 0 achieved '{"type":"goal.achieved"}'
grep -q webhook.delivered "$TMP/.goal/events.jsonl" || fail "webhook event missing"

git -C "$TMP" init -q
git -C "$TMP" config user.email v3@example.invalid
git -C "$TMP" config user.name "v3 smoke"
"$GOALCTL" --root "$TMP" sync push >/tmp/v3-sync
git -C "$TMP" show-ref --verify --quiet refs/heads/goal-state || fail "goal-state branch missing"
rm -rf "$TMP/.goal"
"$GOALCTL" --root "$TMP" sync pull >/dev/null
[ -f "$TMP/.goal/state.json" ] || fail "sync pull did not restore state"

green "ALL V3 HARNESS SMOKE CHECKS PASSED"
