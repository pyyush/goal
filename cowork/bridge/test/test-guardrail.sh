#!/usr/bin/env bash
# cowork/bridge/test/test-guardrail.sh — T10: Relay guardrail test (P3)
#
# Audit item: a12 — relay guardrail T10: >3 relays/hour triggers auto-pause + notification.
#
# Setup:
#   - Pre-seed relay-log.jsonl with 3 recent relay entries within the last hour.
#   - Start bridge-a (mock-a, ndjson, 429 after 1s).
#   - mock-a triggers another relay attempt (4th in window).
#   - Assert: state.status = paused (NOT relaying — guardrail tripped).
#   - Assert: .claude/goal-notify-pending exists (notification sentinel).
#
# Run from repo root: ./cowork/bridge/test/test-guardrail.sh
# Exit codes: 0 = pass, 1 = fail.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
BRIDGE="$REPO_ROOT/bin/goal-bridge"
MOCK_RUNNER="$REPO_ROOT/cowork/bridge/test/mock-runner.sh"

green() { printf '\033[32m%s\033[0m\n' "$*"; }
red()   { printf '\033[31m%s\033[0m\n' "$*"; }
say()   { printf '  %s\n' "$*"; }

step() { printf '\n[%s] %s\n' "$(date -u +%H:%M:%S)" "$1"; }

BRIDGE_A_PID=""
TMP=""

cleanup() {
    [ -n "$BRIDGE_A_PID" ] && kill "$BRIDGE_A_PID" 2>/dev/null || true
    wait "$BRIDGE_A_PID" 2>/dev/null || true
    [ -n "$TMP" ] && rm -rf "$TMP" || true
}
trap cleanup EXIT

fail() {
    red "FAIL [T10-guardrail]: $*"
    if [ -n "${TMP:-}" ]; then
        printf '\n--- bridge-a log (last 40 lines) ---\n'
        tail -40 "$TMP/.claude/goal-hook.log" 2>/dev/null || true
        printf '\n--- state.json ---\n'
        cat "$TMP/.goal/state.json" 2>/dev/null || echo "(not found)"
        printf '\n--- relay-log.jsonl ---\n'
        cat "$TMP/.goal/relay-log.jsonl" 2>/dev/null || echo "(not found)"
    fi
    exit 1
}

# ---- prereqs ----------------------------------------------------------------

step "0. Prereqs"
command -v node >/dev/null || fail "node not installed"
command -v jq   >/dev/null || fail "jq not installed"
[ -x "$BRIDGE" ]      || fail "$BRIDGE not executable"
[ -x "$MOCK_RUNNER" ] || fail "$MOCK_RUNNER not executable"
say "node $(node --version) · jq $(jq --version) ✓"

# ---- temp workspace ---------------------------------------------------------

TMP=$(mktemp -d -t goal-guardrail-test-XXXXXX)
mkdir -p "$TMP/.goal/agents" "$TMP/.goal/handoff" "$TMP/.claude"

NOW=$(date -u +%FT%TZ)
GOAL_UUID="cccccccc-dddd-eeee-ffff-000000000000"

# ---- patterns.json with single ndjson runner --------------------------------

step "1. Build patterns.json"

MOCK_ESC=$(printf '%s' "$MOCK_RUNNER" | sed 's/\\/\\\\/g; s/"/\\"/g')
PATTERNS_JSON="$TMP/patterns.json"
cat > "$PATTERNS_JSON" <<EOF
{
  "runners": {
    "mock-a": {
      "format": "ndjson",
      "provider": "openai",
      "spawn": ["$MOCK_ESC"],
      "spawn_resume": ["$MOCK_ESC"],
      "rate_limit": ["429", "rate.?limit", "too many requests"],
      "server_error": ["5\\\\d{2}", "internal server error"]
    }
  }
}
EOF
say "patterns.json written ✓"

# ---- pre-seed relay-log.jsonl with 3 recent relays (within last hour) ------

step "2. Pre-seed relay-log.jsonl with 3 recent relays"

RECENT1=$(date -u -v-30M +%FT%TZ 2>/dev/null || date -u -d '-30 minutes' +%FT%TZ 2>/dev/null || echo "$NOW")
RECENT2=$(date -u -v-20M +%FT%TZ 2>/dev/null || date -u -d '-20 minutes' +%FT%TZ 2>/dev/null || echo "$NOW")
RECENT3=$(date -u -v-10M +%FT%TZ 2>/dev/null || date -u -d '-10 minutes' +%FT%TZ 2>/dev/null || echo "$NOW")

cat > "$TMP/.goal/relay-log.jsonl" <<EOF
{"ts":"$RECENT1","from":"mock-a-host-100","to":"mock-b-host-200","reason":"rate_limit","handoff_seq":"0001"}
{"ts":"$RECENT2","from":"mock-b-host-200","to":"mock-a-host-100","reason":"rate_limit","handoff_seq":"0002"}
{"ts":"$RECENT3","from":"mock-a-host-100","to":"mock-b-host-200","reason":"rate_limit","handoff_seq":"0003"}
EOF
say "relay-log.jsonl pre-seeded with 3 entries ✓"

# ---- start bridge-a ---------------------------------------------------------

step "3. Start bridge-a — 429 after 1s will trigger 4th relay attempt"

MOCK_FORMAT=ndjson MOCK_429_AFTER=1 MOCK_EXIT_AFTER=30 \
  GOAL_RELAY_LIMIT_PER_HOUR=3 \
  GOAL_BRIDGE_PATTERNS="$PATTERNS_JSON" \
  node "$BRIDGE" mock-a --root "$TMP" \
  >> "$TMP/bridge-a.log" 2>&1 &
BRIDGE_A_PID=$!
say "bridge-a PID=$BRIDGE_A_PID"

AGENT_A=""
for i in $(seq 1 50); do
    sleep 0.1
    for f in "$TMP/.goal/agents"/mock-a-*-${BRIDGE_A_PID}.json; do
        [ -f "$f" ] && { AGENT_A=$(jq -r '.agent_id' "$f"); break 2; }
    done
done
[ -n "$AGENT_A" ] || fail "bridge-a heartbeat not found within 5s"
say "agent-a id: $AGENT_A ✓"

# ---- write initial state.json -----------------------------------------------

step "4. Write state.json — current.agent = agent-a, status = pursuing"

cat > "$TMP/.goal/state.json" <<EOF
{
  "schema_version": 2,
  "goal_id": "$GOAL_UUID",
  "objective": "guardrail test goal",
  "status": "pursuing",
  "created_at": "$NOW",
  "updated_at": "$NOW",
  "current": { "agent": "$AGENT_A", "session": null, "since": "$NOW" },
  "compat": ["claude-code", "codex"],
  "roles": { "lead": null, "build": null, "review": null },
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
say "state.json written: status=pursuing, current.agent=$AGENT_A ✓"

# ---- wait for state.status = paused (guardrail trips on 4th relay attempt) -

step "5. Wait for state.status = paused (guardrail trips within 10s)"

FOUND_PAUSED=0
for i in $(seq 1 100); do
    sleep 0.1
    STATUS=$(jq -r '.status // ""' "$TMP/.goal/state.json" 2>/dev/null) || continue
    if [ "$STATUS" = "paused" ]; then
        FOUND_PAUSED=1
        break
    fi
done
[ "$FOUND_PAUSED" -eq 1 ] || {
    FINAL=$(jq -r '.status' "$TMP/.goal/state.json" 2>/dev/null || echo "unknown")
    fail "state.status never became paused within 10s (final: $FINAL) — guardrail may not have tripped"
}
say "state.status = paused ✓ (guardrail tripped)"

# Verify it was the guardrail, not something else.
HISTORY_NOTE=$(jq -r '.history[-1].note // ""' "$TMP/.goal/state.json" 2>/dev/null)
echo "$HISTORY_NOTE" | grep -qi "relay guardrail" || \
    fail "last history note doesn't mention relay guardrail (got: $HISTORY_NOTE)"
say "history note confirms relay guardrail: $HISTORY_NOTE ✓"

# ---- assert no handoff was written (guardrail aborts before handoff write) --

step "6. Assert no new handoff written (guardrail fires before handoff write)"

# The pre-seeded relay-log has 3 entries pointing to 0001/0002/0003.
# The guardrail check is BEFORE handoff write, so no 0004.md should exist.
if [ -f "$TMP/.goal/handoff/0004.md" ]; then
    fail "handoff/0004.md was written — guardrail should have aborted before handoff write"
fi
say "no handoff/0004.md written ✓ (guardrail fired before write)"

# ---- assert notification sentinel file exists --------------------------------

step "7. Assert .claude/goal-notify-pending sentinel exists"

SENTINEL="$TMP/.claude/goal-notify-pending"
FOUND_SENTINEL=0
for i in $(seq 1 30); do
    sleep 0.1
    [ -f "$SENTINEL" ] && { FOUND_SENTINEL=1; break; }
done
[ "$FOUND_SENTINEL" -eq 1 ] || fail ".claude/goal-notify-pending not found within 3s"
jq empty "$SENTINEL" 2>/dev/null || fail "goal-notify-pending is not valid JSON"
SENTINEL_MSG=$(jq -r '.message // ""' "$SENTINEL" 2>/dev/null)
echo "$SENTINEL_MSG" | grep -qi "guardrail" || \
    fail "sentinel message doesn't mention guardrail (got: $SENTINEL_MSG)"
say ".claude/goal-notify-pending exists with guardrail message ✓"

# ---- confirm paused goal does NOT auto-resume (spec §6) --------------------

step "8. Confirm paused state stays paused (no auto-resume)"

for i in $(seq 1 30); do
    sleep 0.1
    STATUS=$(jq -r '.status // ""' "$TMP/.goal/state.json" 2>/dev/null) || continue
    if [ "$STATUS" != "paused" ]; then
        fail "paused goal auto-resumed to $STATUS — spec §6 violated"
    fi
done
say "state stays paused after 3s (no auto-resume) ✓"

# ---- done -------------------------------------------------------------------

green "ALL T10 GUARDRAIL TESTS PASSED (a12 evidence)"
