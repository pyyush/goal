#!/usr/bin/env bash
# cowork/bridge/test/test-queued.sh — T5: Queued state test (P3)
#
# Audit item: a7 — queued test T5 passes.
#
# Setup:
#   - Both mock providers are throttled (quota.json has exhausted headroom).
#   - mock-a bridge detects a 429 from mock-a runner.
#   - With no peer having headroom, state transitions to queued.
#   - Assert: state.status = queued, queued_until is set.
#   - Then patch quota.json to restore headroom (mock-recovery).
#   - Assert: state.status returns to pursuing within 45s (poll cadence).
#
# Run from repo root: ./cowork/bridge/test/test-queued.sh
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
    red "FAIL [T5-queued]: $*"
    if [ -n "${TMP:-}" ]; then
        printf '\n--- bridge-a log (last 40 lines) ---\n'
        tail -40 "$TMP/.claude/goal-hook.log" 2>/dev/null || true
        printf '\n--- state.json ---\n'
        cat "$TMP/.goal/state.json" 2>/dev/null || echo "(not found)"
        printf '\n--- quota.json ---\n'
        cat "$TMP/.goal/quota.json" 2>/dev/null || echo "(not found)"
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

TMP=$(mktemp -d -t goal-queued-test-XXXXXX)
mkdir -p "$TMP/.goal/agents" "$TMP/.goal/handoff" "$TMP/.claude"

NOW=$(date -u +%FT%TZ)
GOAL_UUID="bbbbbbbb-cccc-dddd-eeee-ffffffffffff"

# ---- patterns.json with ndjson mock-a only (no peer) -----------------------

step "1. Build patterns.json — single ndjson runner (no peer = queued path)"

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
say "patterns.json written (single runner = no peer) ✓"

# ---- pre-seed quota.json with both providers exhausted ----------------------

step "2. Pre-seed quota.json — openai exhausted"

RESET_AT=$(date -u -v+1H +%FT%TZ 2>/dev/null || date -u -d '+1 hour' +%FT%TZ 2>/dev/null || echo "${NOW}")
cat > "$TMP/.goal/quota.json" <<EOF
{
  "providers": {
    "openai": {
      "limit_reset_at": "$RESET_AT",
      "last_429_at": "$NOW",
      "consecutive_429": 3,
      "estimated_headroom": "exhausted"
    },
    "anthropic": {
      "limit_reset_at": "$RESET_AT",
      "last_429_at": "$NOW",
      "consecutive_429": 3,
      "estimated_headroom": "exhausted"
    }
  },
  "updated_at": "$NOW"
}
EOF
say "quota.json pre-seeded (both exhausted) ✓"

# ---- start bridge-a ---------------------------------------------------------

step "3. Start bridge-a (mock-a); wait for heartbeat"

MOCK_FORMAT=ndjson MOCK_429_AFTER=1 MOCK_EXIT_AFTER=30 \
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

# ---- write initial state.json with agent-a as current ----------------------

step "4. Write state.json — current.agent = agent-a"

cat > "$TMP/.goal/state.json" <<EOF
{
  "schema_version": 2,
  "goal_id": "$GOAL_UUID",
  "objective": "queued state test goal",
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
say "state.json written: current.agent=$AGENT_A ✓"

# ---- wait for state.status = queued (within 10s after 429) -----------------

step "5. Wait for state.status = queued (within 10s)"

FOUND_QUEUED=0
for i in $(seq 1 100); do
    sleep 0.1
    STATUS=$(jq -r '.status // ""' "$TMP/.goal/state.json" 2>/dev/null) || continue
    if [ "$STATUS" = "queued" ]; then
        FOUND_QUEUED=1
        break
    fi
done
[ "$FOUND_QUEUED" -eq 1 ] || {
    FINAL=$(jq -r '.status' "$TMP/.goal/state.json" 2>/dev/null || echo "unknown")
    fail "state.status never became queued within 10s (final: $FINAL)"
}
say "state.status = queued ✓"

QUEUED_UNTIL=$(jq -r '.queued_until // ""' "$TMP/.goal/state.json" 2>/dev/null)
[ -n "$QUEUED_UNTIL" ] || fail "queued_until not set"
say "queued_until = $QUEUED_UNTIL ✓"

# ---- mock-recovery: patch quota.json to restore headroom -------------------

step "6. Mock-recovery: patch quota.json to restore openai headroom"

# Set queued_until to now so the bridge's poll triggers immediately.
PAST_RESET=$(date -u -v-5M +%FT%TZ 2>/dev/null || date -u -d '-5 minutes' +%FT%TZ 2>/dev/null || echo "$NOW")

cat > "$TMP/.goal/quota.json" <<EOF
{
  "providers": {
    "openai": {
      "limit_reset_at": "$PAST_RESET",
      "last_429_at": "$NOW",
      "consecutive_429": 0,
      "estimated_headroom": "medium"
    },
    "anthropic": {
      "limit_reset_at": null,
      "last_429_at": null,
      "consecutive_429": 0,
      "estimated_headroom": "high"
    }
  },
  "updated_at": "$(date -u +%FT%TZ)"
}
EOF

# Also patch state.queued_until to be in the past so the poll triggers.
jq --arg past "$PAST_RESET" '.queued_until = $past' \
    "$TMP/.goal/state.json" > "$TMP/.goal/state.json.tmp" 2>/dev/null \
    && mv "$TMP/.goal/state.json.tmp" "$TMP/.goal/state.json"

say "quota.json patched (headroom=medium), queued_until set to past ✓"

# ---- wait for state.status = pursuing (within 45s — poll cadence) ----------

step "7. Wait for state.status = pursuing (within 45s — poll backoff)"

FOUND_PURSUING=0
for i in $(seq 1 450); do
    sleep 0.1
    STATUS=$(jq -r '.status // ""' "$TMP/.goal/state.json" 2>/dev/null) || continue
    if [ "$STATUS" = "pursuing" ]; then
        FOUND_PURSUING=1
        break
    fi
done
[ "$FOUND_PURSUING" -eq 1 ] || {
    FINAL=$(jq -r '.status' "$TMP/.goal/state.json" 2>/dev/null || echo "unknown")
    fail "state.status never returned to pursuing within 45s (final: $FINAL)"
}
say "state.status = pursuing (auto-resumed from queued) ✓"

QUEUED_UNTIL_AFTER=$(jq -r '.queued_until // "null"' "$TMP/.goal/state.json" 2>/dev/null)
[ "$QUEUED_UNTIL_AFTER" = "null" ] || fail "queued_until not cleared after resume (got: $QUEUED_UNTIL_AFTER)"
say "queued_until cleared ✓"

# ---- done -------------------------------------------------------------------

green "ALL T5 QUEUED TESTS PASSED (a7 evidence)"
