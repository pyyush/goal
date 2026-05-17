#!/usr/bin/env bash
# scripts/smoke-concurrency.sh — concurrency smoke tests for /goal.
#
# Covers what the single-threaded harness can't:
#   1. Lock primitive mutual exclusion under parallel contention (clean lock).
#   2. Stale-lock recovery: a single dead holder + a few contenders must all
#      eventually acquire and release without corrupting the lockdir. The
#      mkdir+pidfile-verify pattern bounds (but cannot eliminate) brief
#      windows under heavy contention — we don't assert strict
#      non-overlap here, we assert the lock recovers cleanly.
#   3. Two goals in the same project, parallel writers — per-goal-lock
#      isolation means progress on goal A and goal B doesn't cross-contaminate.
#   4. Two projects, parallel writers — independent .goal/ trees.
#   5. Concurrent events.jsonl appends from many writers — every line
#      preserved and well-formed (POSIX small-append atomicity).
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

TMP=$(mktemp -d -t goal-concurrency-XXXXXX)
trap 'rm -rf "$TMP"' EXIT

# A lightweight worker that uses only `sleep` (no perl spawn per step) to keep
# fork pressure low on macOS. `sleep` with a fractional arg works on macOS.
worker_acquire_hold_release() {
    local root="$1" wid="$2" hold_s="$3"
    # shellcheck disable=SC1090
    . "$LOCK_SH"
    if ! goal_lock_acquire "$root"; then
        printf '%d\tACQUIRE_FAILED\n' "$wid" >> "$root/.goal/log"
        return 1
    fi
    # Record a held-window marker. The "held" stamp file's existence count is
    # what we measure for mutual exclusion — strictly stricter than timestamp
    # comparison, and immune to perl-startup jitter.
    local held="$root/.goal/held"
    : >> "$held"   # create
    local n; n=$(wc -l < "$held" 2>/dev/null | tr -d ' ')
    printf '%s in\n' "$wid" >> "$held"
    sleep "$hold_s"
    printf '%s out\n' "$wid" >> "$held"
    # Append our identity to log AFTER hold completes (still under lock).
    printf '%d\tdone\n' "$wid" >> "$root/.goal/log"
    goal_lock_release "$root"
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
step "1. Clean lock, 5 parallel acquirers serialize (max 1 concurrent holder)"
# ────────────────────────────────────────────────────────────────────────────

P1="$TMP/p1"; mkdir -p "$P1/.goal"
N=5
for i in $(seq 1 "$N"); do
    bash -c "worker_acquire_hold_release '$P1' '$i' 0.05" &
done
wait

DONE=$(grep -c $'\tdone$' "$P1/.goal/log" 2>/dev/null || echo 0)
[ "$DONE" -eq "$N" ] || fail "expected $N completed workers, got $DONE"
MAX_CONC=$(max_concurrent_in_held_log "$P1/.goal/held")
[ "$MAX_CONC" -eq 1 ] || fail "mutual exclusion broken: $MAX_CONC simultaneous holders"
green "  ✓ $N workers serialized, max-concurrent=1"

# ────────────────────────────────────────────────────────────────────────────
step "2. Stale lock recovery: dead-owner pidfile, 3 stealers recover cleanly"
# ────────────────────────────────────────────────────────────────────────────

P2="$TMP/p2"; mkdir -p "$P2/.goal/lock"
# Plant a fake stale pid file. 99999999 is far above any live pid.
printf '99999999\n0\n' > "$P2/.goal/lock/pid"

N=3
for i in $(seq 1 "$N"); do
    bash -c "worker_acquire_hold_release '$P2' '$i' 0.05" &
done
wait

DONE=$(grep -c $'\tdone$' "$P2/.goal/log" 2>/dev/null || echo 0)
[ "$DONE" -eq "$N" ] || fail "stale recovery: only $DONE/$N workers acquired"
MAX_CONC=$(max_concurrent_in_held_log "$P2/.goal/held")
# Under stale-steal contention the post-mkdir verify can briefly fail a
# stolen acquirer; we accept max_concurrent of 1 (strict) and otherwise log
# it as a soft warning. The hard invariants are: every worker finished, the
# lockdir is clean, no JSON state was corrupted.
[ "$MAX_CONC" -eq 1 ] || fail "stale recovery: max-concurrent=$MAX_CONC (verify race regressed)"
[ ! -e "$P2/.goal/lock" ] || fail "lockdir leaked after release"
green "  ✓ $N stealers recovered cleanly; max-concurrent=1; lockdir clean"

# ────────────────────────────────────────────────────────────────────────────
step "3. Two goals in one project: per-goal isolation under parallel load"
# ────────────────────────────────────────────────────────────────────────────

P3="$TMP/p3"
"$GOALCTL" --root "$P3" create --quick "Goal alpha" > "$P3/alpha.out" 2>&1 \
    || fail "create alpha failed: $(cat "$P3/alpha.out")"
GID_A=$(jq -r '.goal_id' "$P3/.goal/state.json")
"$GOALCTL" --root "$P3" pause >/dev/null 2>&1 || true
"$GOALCTL" --root "$P3" create --quick "Goal beta" > "$P3/beta.out" 2>&1 \
    || fail "create beta failed: $(cat "$P3/beta.out")"
GID_B=$(jq -r '.goal_id' "$P3/.goal/state.json")
[ "$GID_A" != "$GID_B" ] || fail "two goals collapsed onto the same id"

N=5
for i in $(seq 1 "$N"); do
    "$GOALCTL" --root "$P3" progress --goal "$GID_A" --note "a-$i" >/dev/null 2>&1 &
    "$GOALCTL" --root "$P3" progress --goal "$GID_B" --note "b-$i" >/dev/null 2>&1 &
done
wait

jq -e . "$P3/.goal/goals/$GID_A.json" >/dev/null || fail "goal A JSON corrupted"
jq -e . "$P3/.goal/goals/$GID_B.json" >/dev/null || fail "goal B JSON corrupted"
A_COUNT=$(jq '[.history[]? | select(.action=="progress")] | length' "$P3/.goal/goals/$GID_A.json")
B_COUNT=$(jq '[.history[]? | select(.action=="progress")] | length' "$P3/.goal/goals/$GID_B.json")
[ "$A_COUNT" = "$N" ] || fail "goal A lost progress entries: $A_COUNT/$N"
[ "$B_COUNT" = "$N" ] || fail "goal B lost progress entries: $B_COUNT/$N"
green "  ✓ both goals retained all $N concurrent progress writes"

# ────────────────────────────────────────────────────────────────────────────
step "4. Two projects in parallel: separate .goal/ trees are independent"
# ────────────────────────────────────────────────────────────────────────────

P4A="$TMP/p4a" P4B="$TMP/p4b"
"$GOALCTL" --root "$P4A" create --quick "Project A goal" >/dev/null 2>&1 || fail "p4a create"
"$GOALCTL" --root "$P4B" create --quick "Project B goal" >/dev/null 2>&1 || fail "p4b create"
GID_4A=$(jq -r '.goal_id' "$P4A/.goal/state.json")
GID_4B=$(jq -r '.goal_id' "$P4B/.goal/state.json")

N=4
for i in $(seq 1 "$N"); do
    "$GOALCTL" --root "$P4A" progress --goal "$GID_4A" --note "pa-$i" >/dev/null 2>&1 &
    "$GOALCTL" --root "$P4B" progress --goal "$GID_4B" --note "pb-$i" >/dev/null 2>&1 &
done
wait

A_COUNT=$(jq '[.history[]? | select(.action=="progress")] | length' "$P4A/.goal/goals/$GID_4A.json")
B_COUNT=$(jq '[.history[]? | select(.action=="progress")] | length' "$P4B/.goal/goals/$GID_4B.json")
[ "$A_COUNT" = "$N" ] || fail "project A lost writes: $A_COUNT/$N"
[ "$B_COUNT" = "$N" ] || fail "project B lost writes: $B_COUNT/$N"
A_CROSS=$(jq '[.history[]? | select(.note? // "" | test("^pb-"))] | length' "$P4A/.goal/goals/$GID_4A.json")
B_CROSS=$(jq '[.history[]? | select(.note? // "" | test("^pa-"))] | length' "$P4B/.goal/goals/$GID_4B.json")
[ "$A_CROSS" = "0" ] && [ "$B_CROSS" = "0" ] \
    || fail "cross-project leakage: A_cross=$A_CROSS B_cross=$B_CROSS"
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
