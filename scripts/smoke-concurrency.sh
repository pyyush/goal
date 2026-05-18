#!/usr/bin/env bash
# scripts/smoke-concurrency.sh — concurrency smoke tests for /goal (v3).
#
# Covers what the single-threaded harness can't:
#   1. Lock primitive mutual exclusion under parallel contention (clean lock).
#   2. Stale-lock recovery: a single dead holder + a few contenders must all
#      eventually acquire and release without corrupting the lockdir. The
#      mkdir+pidfile-verify pattern bounds (but cannot eliminate) brief
#      windows under heavy contention — we don't assert strict non-overlap
#      here, we assert the lock recovers cleanly.
#   3. Two goals in the same project, parallel writers — per-goal-lock
#      isolation means progress on goal A and goal B doesn't cross-contaminate.
#   4. Two projects, parallel writers — independent .goal/ trees.
#   5. Concurrent events.jsonl appends from many writers — every line
#      preserved and well-formed (POSIX small-append atomicity).
#
# v3 changes:
#   * goal-lock.sh is now a generic mkdir mutex; callers pass an explicit
#     lockdir path. Steps 1 and 2 exercise it against the per-goal lock path
#     pattern (.goal/locks/<gid>.lock).
#   * Steps 3 and 4 use the v3-aware goalctl with --session flags so each
#     parallel worker owns its own goal, exercising the per-goal locks the
#     MCP and bash hooks share.
#
# Contention level is intentionally moderate (3-8 workers). Production paths
# never see 50-way contention; the goal here is to catch real regressions
# (the TOCTOU race, file-corruption bugs, cross-project leaks) without
# fork-bombing macOS in CI.

set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOCK_SH="$ROOT/hooks/goal-lock.sh"
GOALCTL="$ROOT/bin/goalctl"

green() { printf '\033[32m%s\033[0m\n' "$*"; }
red()   { printf '\033[31m%s\033[0m\n' "$*"; }
fail()  { red "FAIL: $*"; exit 1; }
step()  { printf '\n[%s] %s\n' "$(date -u +%H:%M:%S)" "$1"; }

[ -f "$LOCK_SH" ] || fail "missing $LOCK_SH"
[ -x "$GOALCTL" ] || fail "missing $GOALCTL"

TMP=$(mktemp -d -t goal-concurrency-XXXXXX)
trap 'rm -rf "$TMP"' EXIT

# Generic mkdir-mutex worker. v3 signature: pass the explicit lockdir.
worker_acquire_hold_release() {
    local lockdir="$1" wid="$2" hold_s="$3" logdir="$4"
    # shellcheck disable=SC1090
    . "$LOCK_SH"
    if ! goal_lock_acquire "$lockdir"; then
        printf '%d\tACQUIRE_FAILED\n' "$wid" >> "$logdir/log"
        return 1
    fi
    local held="$logdir/held"
    : >> "$held"
    printf '%s in\n'  "$wid" >> "$held"
    sleep "$hold_s"
    printf '%s out\n' "$wid" >> "$held"
    printf '%d\tdone\n' "$wid" >> "$logdir/log"
    goal_lock_release "$lockdir"
    return 0
}
export -f worker_acquire_hold_release
export LOCK_SH

# Walk the "in/out" trace and at every moment count the number of workers
# whose "in" was seen but "out" was not. The max of that count is the maximum
# concurrent holders — must be exactly 1 for a correct mutex.
max_concurrent_in_held_log() {
    awk '
        $2 == "in"  { inflight++; if (inflight > max) max = inflight; next }
        $2 == "out" { inflight-- }
        END         { print max + 0 }
    ' "$1"
}

# ────────────────────────────────────────────────────────────────────────────
step "1. Clean per-goal lock, 5 parallel acquirers serialize (max 1 concurrent holder)"
# ────────────────────────────────────────────────────────────────────────────

P1="$TMP/p1"; mkdir -p "$P1/.goal/locks"
GID1="11111111-aaaa-bbbb-cccc-000000000001"
L1="$P1/.goal/locks/$GID1.lock"
N=5
for i in $(seq 1 "$N"); do
    bash -c "worker_acquire_hold_release '$L1' '$i' 0.05 '$P1/.goal'" &
done
wait

DONE=$(grep -c $'\tdone$' "$P1/.goal/log" 2>/dev/null || echo 0)
[ "$DONE" -eq "$N" ] || fail "expected $N completed workers, got $DONE"
MAX_CONC=$(max_concurrent_in_held_log "$P1/.goal/held")
[ "$MAX_CONC" -eq 1 ] || fail "mutual exclusion broken: $MAX_CONC simultaneous holders"
green "  ✓ $N workers serialized on per-goal lock, max-concurrent=1"

# ────────────────────────────────────────────────────────────────────────────
step "2. Stale lock recovery: dead-owner pidfile, 3 stealers recover cleanly"
# ────────────────────────────────────────────────────────────────────────────

P2="$TMP/p2"
GID2="22222222-aaaa-bbbb-cccc-000000000002"
L2="$P2/.goal/locks/$GID2.lock"
mkdir -p "$L2"
# Plant a fake stale pid file. 99999999 is far above any live pid.
printf '99999999\n0\n' > "$L2/pid"

N=3
for i in $(seq 1 "$N"); do
    bash -c "worker_acquire_hold_release '$L2' '$i' 0.05 '$P2/.goal'" &
done
wait

DONE=$(grep -c $'\tdone$' "$P2/.goal/log" 2>/dev/null || echo 0)
[ "$DONE" -eq "$N" ] || fail "stale recovery: only $DONE/$N workers acquired"
MAX_CONC=$(max_concurrent_in_held_log "$P2/.goal/held")
[ "$MAX_CONC" -eq 1 ] || fail "stale recovery: max-concurrent=$MAX_CONC (TOCTOU verify race regressed)"
[ ! -e "$L2" ] || fail "lockdir leaked after release"
green "  ✓ $N stealers recovered cleanly on per-goal lock; max-concurrent=1; lockdir clean"

# ────────────────────────────────────────────────────────────────────────────
step "3. Two sessions, one project: two independent goals + per-goal isolation"
# ────────────────────────────────────────────────────────────────────────────

P3="$TMP/p3"; mkdir -p "$P3"
# Session A creates goal alpha.
CLAUDE_SESSION_ID="sessA-$$" "$GOALCTL" --root "$P3" create --quick "Goal alpha" > "$P3/alpha.out" 2>&1 \
    || fail "create alpha failed: $(cat "$P3/alpha.out" 2>/dev/null || echo "(no output)")"
# Session B creates goal beta — must succeed under v3 ownership semantics.
CLAUDE_SESSION_ID="sessB-$$" "$GOALCTL" --root "$P3" create --quick "Goal beta" > "$P3/beta.out" 2>&1 \
    || fail "create beta failed: $(cat "$P3/beta.out")"

# Pull each session's gid from its pointer.
GID_A=$(cat "$P3/.goal/sessions/sessA-$$")
GID_B=$(cat "$P3/.goal/sessions/sessB-$$")
[ -n "$GID_A" ] && [ -n "$GID_B" ] || fail "session pointers not written"
[ "$GID_A" != "$GID_B" ] || fail "two sessions collapsed onto the same goal id"
[ -f "$P3/.goal/goals/$GID_A.json" ] || fail "goal A record missing"
[ -f "$P3/.goal/goals/$GID_B.json" ] || fail "goal B record missing"

# Parallel set-budget writes to each goal (RMW under per-goal lock).
N=5
for i in $(seq 1 "$N"); do
    CLAUDE_SESSION_ID="sessA-$$" "$GOALCTL" --root "$P3" set-budget $((1000 + i)) >/dev/null 2>&1 &
    CLAUDE_SESSION_ID="sessB-$$" "$GOALCTL" --root "$P3" set-budget $((2000 + i)) >/dev/null 2>&1 &
done
wait

jq -e . "$P3/.goal/goals/$GID_A.json" >/dev/null || fail "goal A JSON corrupted"
jq -e . "$P3/.goal/goals/$GID_B.json" >/dev/null || fail "goal B JSON corrupted"
# Each goal recorded all N budget writes in its own history.
A_COUNT=$(jq '[.history[]? | select(.action=="set-budget")] | length' "$P3/.goal/goals/$GID_A.json")
B_COUNT=$(jq '[.history[]? | select(.action=="set-budget")] | length' "$P3/.goal/goals/$GID_B.json")
[ "$A_COUNT" = "$N" ] || fail "goal A lost history entries: $A_COUNT/$N"
[ "$B_COUNT" = "$N" ] || fail "goal B lost history entries: $B_COUNT/$N"
green "  ✓ two sessions produced two independent goals; each retained all $N concurrent set-budget RMWs"

# ────────────────────────────────────────────────────────────────────────────
step "4. Two projects in parallel: separate .goal/ trees are independent"
# ────────────────────────────────────────────────────────────────────────────

P4A="$TMP/p4a" P4B="$TMP/p4b"
mkdir -p "$P4A" "$P4B"
CLAUDE_SESSION_ID="sess4A-$$" "$GOALCTL" --root "$P4A" create --quick "Project A goal" >/dev/null 2>&1 || fail "p4a create"
CLAUDE_SESSION_ID="sess4B-$$" "$GOALCTL" --root "$P4B" create --quick "Project B goal" >/dev/null 2>&1 || fail "p4b create"
GID_4A=$(cat "$P4A/.goal/sessions/sess4A-$$")
GID_4B=$(cat "$P4B/.goal/sessions/sess4B-$$")

N=4
for i in $(seq 1 "$N"); do
    CLAUDE_SESSION_ID="sess4A-$$" "$GOALCTL" --root "$P4A" set-budget $((1000 + i)) >/dev/null 2>&1 &
    CLAUDE_SESSION_ID="sess4B-$$" "$GOALCTL" --root "$P4B" set-budget $((2000 + i)) >/dev/null 2>&1 &
done
wait

A_COUNT=$(jq '[.history[]? | select(.action=="set-budget")] | length' "$P4A/.goal/goals/$GID_4A.json")
B_COUNT=$(jq '[.history[]? | select(.action=="set-budget")] | length' "$P4B/.goal/goals/$GID_4B.json")
[ "$A_COUNT" = "$N" ] || fail "project A lost writes: $A_COUNT/$N"
[ "$B_COUNT" = "$N" ] || fail "project B lost writes: $B_COUNT/$N"
[ ! -e "$P4A/.goal/goals/$GID_4B.json" ] || fail "cross-project leak: B's gid resolved in A"
[ ! -e "$P4B/.goal/goals/$GID_4A.json" ] || fail "cross-project leak: A's gid resolved in B"
green "  ✓ projects independent, no cross-leakage"

# ────────────────────────────────────────────────────────────────────────────
step "5. Concurrent events.jsonl appends: all lines preserved + well-formed"
# ────────────────────────────────────────────────────────────────────────────

P5="$TMP/p5/.goal"; mkdir -p "$P5"
EVENTS="$P5/events.jsonl"
N=30
for i in $(seq 1 "$N"); do
    (
        printf '{"ts":"%s","src":"smoke","seq":%d,"pid":%d}\n' \
            "$(date -u +%FT%TZ)" "$i" "$$" >> "$EVENTS"
    ) &
done
wait

ACTUAL=$(wc -l < "$EVENTS" | tr -d ' ')
[ "$ACTUAL" = "$N" ] || fail "expected $N event lines, got $ACTUAL (some appends lost)"
BAD=$(jq -c . "$EVENTS" 2>/dev/null | wc -l | tr -d ' ')
[ "$BAD" = "$N" ] || fail "$((N - BAD)) lines failed to parse — append wasn't atomic"
green "  ✓ all $N concurrent appends preserved and parseable"

green ""
green "ALL CONCURRENCY SMOKE CHECKS PASSED"
