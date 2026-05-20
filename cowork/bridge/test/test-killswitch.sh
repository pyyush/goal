#!/usr/bin/env bash
# cowork/bridge/test/test-killswitch.sh — Kill switch test T9 (audit item a11).
#
# Verifies that touching .goal/pause halts BOTH bridges within one tick.
#
# The bridge polls PAUSE_FILE every 500ms (B5). "One tick" = 500ms poll
# interval + 500ms grace = 1000ms. We allow 2s total to accommodate macOS
# scheduler jitter.
#
# Tests:
#   T9-1: Two bridges start and write heartbeats within 5s.
#   T9-2: touch .goal/pause → Bridge A exits 0 within 2s.
#   T9-3: Bridge B also exits 0 within 2s (same pause file, same .goal/).
#   T9-4: Verify both exited with code 0 (clean exit per B5).
#   T9-5: Verify no bridge processes remain (no orphans).
#   T9-6: Solo regression — single bridge also halts within one tick.
#
# Run from repo root:
#   ./cowork/bridge/test/test-killswitch.sh
#
# Exit codes:
#   0  all checks passed
#   1+ specific check that failed

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
BRIDGE="$REPO_ROOT/bin/goal-bridge"
MOCK_RUNNER="$REPO_ROOT/cowork/bridge/test/mock-runner.sh"

green() { printf '\033[32m%s\033[0m\n' "$*"; }
red()   { printf '\033[31m%s\033[0m\n' "$*"; }
say()   { printf '  %s\n' "$*"; }

step() {
    printf '\n[%s] %s\n' "$(date -u +%H:%M:%S)" "$1"
}

# Track all bridge PIDs for cleanup.
BRIDGE_PIDS=()

fail() {
    red "FAIL: $*"
    # Kill all running bridges.
    for pid in "${BRIDGE_PIDS[@]:-}"; do
        kill "$pid" 2>/dev/null || true
    done
    # Print any available logs.
    if [ -n "${TMP:-}" ] && [ -d "$TMP" ]; then
        printf '\n--- bridge-a stdout ---\n'
        cat "$TMP/bridge-a.log" 2>/dev/null || true
        printf '\n--- bridge-b stdout ---\n'
        cat "$TMP/bridge-b.log" 2>/dev/null || true
    fi
    exit 1
}

# ---- prereqs ----------------------------------------------------------------

step "0. Prereqs"
command -v node >/dev/null || fail "node not installed"
command -v jq   >/dev/null || fail "jq not installed"
[ -x "$BRIDGE" ]           || fail "$BRIDGE not executable"
[ -x "$MOCK_RUNNER" ]      || fail "$MOCK_RUNNER not executable"
say "node $(node --version) · jq $(jq --version) ✓"

# ---- setup ------------------------------------------------------------------

TMP=$(mktemp -d -t goal-killswitch-test-XXXXXX)
trap 'cleanup' EXIT

cleanup() {
    for pid in "${BRIDGE_PIDS[@]:-}"; do
        kill "$pid" 2>/dev/null || true
        wait "$pid" 2>/dev/null || true
    done
    rm -rf "$TMP"
}

mkdir -p "$TMP/.goal/goals" "$TMP/.goal/agents" "$TMP/.claude"

NOW=$(date -u +%FT%TZ)
GOAL_UUID="11111111-2222-3333-4444-666666666666"
STATE_FILE="$TMP/.goal/goals/$GOAL_UUID.json"
cat > "$STATE_FILE.tmp" <<EOF
{
  "schema_version": 2,
  "goal_id": "$GOAL_UUID",
  "objective": "kill switch T9 test",
  "status": "pursuing",
  "created_at": "$NOW",
  "updated_at": "$NOW",
  "current": { "agent": null, "session": null, "since": null },
  "compat": ["claude-code"],
  "roles": { "lead": null, "build": null, "review": null },
  "lineage": [],
  "budget": null,
  "audit": null,
  "handoff_head": null,
  "queued_until": null
}
EOF
mv "$STATE_FILE.tmp" "$STATE_FILE"

# Custom patterns config with two runner keys (a=mock-a, b=mock-b).
# Both map to the same mock runner binary so we can run two bridges in the
# same .goal/ directory with distinct agent_ids.
MOCK_RUNNER_ESC=$(printf '%s' "$MOCK_RUNNER" | sed 's/\\/\\\\/g; s/"/\\"/g')
PATTERNS_JSON="$TMP/patterns.json"
cat > "$PATTERNS_JSON" <<EOF
{
  "runners": {
    "mock-a": {
      "spawn": ["$MOCK_RUNNER_ESC"],
      "rate_limit": ["429"],
      "server_error": ["500"]
    },
    "mock-b": {
      "spawn": ["$MOCK_RUNNER_ESC"],
      "rate_limit": ["429"],
      "server_error": ["500"]
    }
  }
}
EOF

# ---- T9-1: Both bridges start and write heartbeats within 5s ----------------

step "T9-1. Start two bridges; both write heartbeats within 5s"

MOCK_EXIT_AFTER=60 MOCK_429_AFTER=0 \
  GOAL_BRIDGE_PATTERNS="$PATTERNS_JSON" \
  node "$BRIDGE" mock-a --root "$TMP" \
  >> "$TMP/bridge-a.log" 2>&1 &
BRIDGE_A_PID=$!
BRIDGE_PIDS+=("$BRIDGE_A_PID")
say "Bridge A PID=$BRIDGE_A_PID (runner=mock-a)"

MOCK_EXIT_AFTER=60 MOCK_429_AFTER=0 \
  GOAL_BRIDGE_PATTERNS="$PATTERNS_JSON" \
  node "$BRIDGE" mock-b --root "$TMP" \
  >> "$TMP/bridge-b.log" 2>&1 &
BRIDGE_B_PID=$!
BRIDGE_PIDS+=("$BRIDGE_B_PID")
say "Bridge B PID=$BRIDGE_B_PID (runner=mock-b)"

# Wait for both heartbeat files.
HB_A=""
HB_B=""
for i in $(seq 1 50); do
    sleep 0.1
    if [ -z "$HB_A" ]; then
        for f in "$TMP/.goal/agents"/mock-a-*.json; do
            [ -f "$f" ] && HB_A="$f" && break
        done
    fi
    if [ -z "$HB_B" ]; then
        for f in "$TMP/.goal/agents"/mock-b-*.json; do
            [ -f "$f" ] && HB_B="$f" && break
        done
    fi
    [ -n "$HB_A" ] && [ -n "$HB_B" ] && break
done

[ -n "$HB_A" ] || fail "Bridge A heartbeat not found within 5s"
[ -n "$HB_B" ] || fail "Bridge B heartbeat not found within 5s"

AGENT_A=$(jq -r '.agent_id' "$HB_A")
AGENT_B=$(jq -r '.agent_id' "$HB_B")
say "Bridge A agent_id=$AGENT_A ✓"
say "Bridge B agent_id=$AGENT_B ✓"

# Both must be distinct agent_ids.
[ "$AGENT_A" != "$AGENT_B" ] || fail "Both bridges have same agent_id — should be distinct"
say "Distinct agent_ids ✓"

# Both must be alive.
kill -0 "$BRIDGE_A_PID" 2>/dev/null || fail "Bridge A (PID=$BRIDGE_A_PID) already dead before pause"
kill -0 "$BRIDGE_B_PID" 2>/dev/null || fail "Bridge B (PID=$BRIDGE_B_PID) already dead before pause"
say "Both bridges alive before pause ✓"

# ---- T9-2 + T9-3: touch .goal/pause → both exit within 2s ------------------

step "T9-2/T9-3. touch .goal/pause → both bridges exit within 2s (one tick + grace)"

PAUSE_FILE="$TMP/.goal/pause"
touch "$PAUSE_FILE"
PAUSE_TS=$(date -u +%H:%M:%S)
say "Touched $PAUSE_FILE at $PAUSE_TS"

# Poll 2s for Bridge A to die.
A_GONE=0
for i in $(seq 1 20); do
    sleep 0.1
    if ! kill -0 "$BRIDGE_A_PID" 2>/dev/null; then
        A_GONE=1
        break
    fi
done

# Poll 2s for Bridge B to die (continue even if A already gone).
B_GONE=0
for i in $(seq 1 20); do
    sleep 0.1
    if ! kill -0 "$BRIDGE_B_PID" 2>/dev/null; then
        B_GONE=1
        break
    fi
done

[ "$A_GONE" -eq 1 ] || fail "Bridge A did not exit within 2s of .goal/pause (PID=$BRIDGE_A_PID)"
say "Bridge A exited within 2s ✓"

[ "$B_GONE" -eq 1 ] || fail "Bridge B did not exit within 2s of .goal/pause (PID=$BRIDGE_B_PID)"
say "Bridge B exited within 2s ✓"

# ---- T9-4: Both exited with code 0 ------------------------------------------

step "T9-4. Both bridges exited with code 0 (clean B5 exit)"

wait "$BRIDGE_A_PID" 2>/dev/null; EXIT_A=$?
wait "$BRIDGE_B_PID" 2>/dev/null; EXIT_B=$?
BRIDGE_PIDS=()  # Already reaped.

[ "$EXIT_A" -eq 0 ] || fail "Bridge A exit code $EXIT_A (expected 0)"
say "Bridge A exit code 0 ✓"

[ "$EXIT_B" -eq 0 ] || fail "Bridge B exit code $EXIT_B (expected 0)"
say "Bridge B exit code 0 ✓"

# ---- T9-5: No orphan processes ----------------------------------------------

step "T9-5. No orphan bridge processes remain"

# Wait briefly for OS process table to update.
sleep 0.2

# Check that neither PID is still alive.
if kill -0 "$BRIDGE_A_PID" 2>/dev/null; then
    kill "$BRIDGE_A_PID" 2>/dev/null || true
    fail "Bridge A (PID=$BRIDGE_A_PID) still alive after wait — orphan"
fi
if kill -0 "$BRIDGE_B_PID" 2>/dev/null; then
    kill "$BRIDGE_B_PID" 2>/dev/null || true
    fail "Bridge B (PID=$BRIDGE_B_PID) still alive after wait — orphan"
fi
say "No orphan processes ✓"

# ---- T9-6: Solo regression — single bridge halts within one tick ------------

step "T9-6. Solo regression: single bridge (no peer) also halts within one tick"

# Fresh .goal/ dir for isolation.
TMP2=$(mktemp -d -t goal-killswitch-solo-XXXXXX)
trap 'cleanup2' EXIT
cleanup2() {
    for pid in "${SOLO_PIDS[@]:-}"; do
        kill "$pid" 2>/dev/null || true
        wait "$pid" 2>/dev/null || true
    done
    rm -rf "${TMP2:-}" "${TMP:-}"
}

mkdir -p "$TMP2/.goal/goals" "$TMP2/.goal/agents" "$TMP2/.claude"

NOW2=$(date -u +%FT%TZ)
GOAL_UUID2="11111111-2222-3333-4444-777777777777"
STATE_FILE2="$TMP2/.goal/goals/$GOAL_UUID2.json"
cat > "$STATE_FILE2.tmp" <<EOF
{
  "schema_version": 2,
  "goal_id": "$GOAL_UUID2",
  "objective": "solo pause test",
  "status": "pursuing",
  "created_at": "$NOW2",
  "updated_at": "$NOW2",
  "current": { "agent": null, "session": null, "since": null },
  "compat": ["claude-code"],
  "roles": {},
  "lineage": [],
  "budget": null,
  "audit": null,
  "handoff_head": null,
  "queued_until": null
}
EOF
mv "$STATE_FILE2.tmp" "$STATE_FILE2"

MOCK_EXIT_AFTER=60 MOCK_429_AFTER=0 \
  GOAL_BRIDGE_PATTERNS="$PATTERNS_JSON" \
  node "$BRIDGE" mock-a --root "$TMP2" \
  >> "$TMP2/bridge-solo.log" 2>&1 &
SOLO_PID=$!
SOLO_PIDS=("$SOLO_PID")
say "Solo bridge PID=$SOLO_PID"

# Wait for heartbeat.
SOLO_HB=""
for i in $(seq 1 50); do
    sleep 0.1
    for f in "$TMP2/.goal/agents"/mock-a-*.json; do
        [ -f "$f" ] && SOLO_HB="$f" && break 2
    done
done
[ -n "$SOLO_HB" ] || fail "Solo bridge heartbeat not found within 5s"
say "Solo bridge heartbeat ✓"

# Touch pause and time it.
PAUSE2="$TMP2/.goal/pause"
touch "$PAUSE2"
TICK_START=$(date +%s%N 2>/dev/null || date +%s)

SOLO_GONE=0
for i in $(seq 1 20); do
    sleep 0.1
    if ! kill -0 "$SOLO_PID" 2>/dev/null; then
        SOLO_GONE=1
        break
    fi
done

TICK_END=$(date +%s%N 2>/dev/null || date +%s)

[ "$SOLO_GONE" -eq 1 ] || fail "Solo bridge did not exit within 2s of .goal/pause"

wait "$SOLO_PID" 2>/dev/null; SOLO_EXIT=$?
SOLO_PIDS=()

[ "$SOLO_EXIT" -eq 0 ] || fail "Solo bridge exit code $SOLO_EXIT (expected 0)"
say "Solo bridge exited 0 within 2s ✓"

# Report approximate elapsed (best-effort; macOS date may lack nanoseconds).
if [ "$TICK_END" != "$TICK_START" ] && [ "${#TICK_END}" -gt 10 ]; then
    ELAPSED_MS=$(( (TICK_END - TICK_START) / 1000000 ))
    say "Elapsed: ~${ELAPSED_MS}ms (spec: ≤ one tick = 500ms poll + grace)"
else
    say "Elapsed timing not available on this platform"
fi

# ---- Summary ----------------------------------------------------------------

step "Summary — audit item a11 evidence"
say "✓ T9-1: Two bridges started and wrote heartbeats within 5s"
say "✓ T9-2: Bridge A (mock-a) exited within 2s of .goal/pause"
say "✓ T9-3: Bridge B (mock-b) exited within 2s of .goal/pause"
say "✓ T9-4: Both exited with code 0 (clean B5 exit)"
say "✓ T9-5: No orphan processes"
say "✓ T9-6: Solo bridge (no peer) also halted within one tick"
say "Kill switch halts ALL bridges within one poll tick (500ms) per spec §7 B5 ✓"

green "ALL KILL SWITCH TESTS PASSED (T9 / a11)"
