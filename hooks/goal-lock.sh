#!/usr/bin/env bash
# goal-lock.sh — sourced helper. Portable directory-based mutex around
# .claude/goal.json, coordinating with the Node side's `proper-lockfile`.
#
# Both sides treat `<root>/.claude/goal.lock/` as the lock: `mkdir` is atomic
# on POSIX, so the first writer to mkdir wins. The pid file inside the lockdir
# is informational (used for stale-lock detection only).
#
# Usage from a bash script:
#   . "$(dirname "$0")/goal-lock.sh"       # adjust path as needed
#   goal_lock_acquire "$GOAL_ROOT" || exit 1
#   trap 'goal_lock_release "$GOAL_ROOT"' EXIT INT TERM
#   ... do RMW on goal.json ...
#   goal_lock_release "$GOAL_ROOT"
#   trap - EXIT INT TERM
#
# Tunables (env vars):
#   GOAL_LOCK_TIMEOUT_MS    overall acquisition timeout (default 5000)
#   GOAL_LOCK_STALE_MS      consider lock stale and steal it after (default 30000)
#
# Compatible with the MCP server's `proper-lockfile.lock(claudeDir, {
# lockfilePath: '.claude/goal.lock' })` because both implementations use the
# directory's existence as the lock signal.

goal_lock_acquire() {
    local root="$1"
    local timeout_ms="${GOAL_LOCK_TIMEOUT_MS:-5000}"
    local stale_ms="${GOAL_LOCK_STALE_MS:-30000}"
    local lockdir="$root/.claude/goal.lock"
    local pidfile="$lockdir/pid"

    [ -d "$root/.claude" ] || mkdir -p "$root/.claude" 2>/dev/null || return 1

    local started_ms
    started_ms=$(goal_lock_now_ms)
    local backoff_ms=50

    while :; do
        if mkdir "$lockdir" 2>/dev/null; then
            # Acquired. Stamp pid + timestamp inside.
            printf '%d\n%d\n' "$$" "$(goal_lock_now_ms)" > "$pidfile" 2>/dev/null || true
            return 0
        fi

        # Held — check for staleness.
        if [ -f "$pidfile" ]; then
            local owner held_at
            {
                IFS= read -r owner || owner=""
                IFS= read -r held_at || held_at=""
            } < "$pidfile" 2>/dev/null

            if [ -n "$owner" ] && ! kill -0 "$owner" 2>/dev/null; then
                # Owner is dead. Steal.
                rm -rf "$lockdir" 2>/dev/null
                continue
            fi
            if [ -n "$held_at" ]; then
                local now_ms held_for_ms
                now_ms=$(goal_lock_now_ms)
                held_for_ms=$((now_ms - held_at))
                if [ "$held_for_ms" -ge "$stale_ms" ]; then
                    # Held too long. Steal — owner is hung.
                    rm -rf "$lockdir" 2>/dev/null
                    continue
                fi
            fi
        fi

        # Timed out?
        local elapsed_ms
        elapsed_ms=$(( $(goal_lock_now_ms) - started_ms ))
        if [ "$elapsed_ms" -ge "$timeout_ms" ]; then
            return 1
        fi

        # Backoff with jitter, capped at 250ms.
        goal_lock_sleep_ms "$backoff_ms"
        backoff_ms=$(( backoff_ms < 250 ? backoff_ms * 2 : 250 ))
    done
}

goal_lock_release() {
    local root="$1"
    rm -rf "$root/.claude/goal.lock" 2>/dev/null
}

# ---- internals -------------------------------------------------------------

# Best-effort millisecond clock. macOS `date` doesn't support %N; falls back
# to second-resolution * 1000.
goal_lock_now_ms() {
    local out
    if out=$(date -u +%s%3N 2>/dev/null) && [ "${out#*N}" = "$out" ]; then
        printf '%s' "$out"
    elif command -v perl >/dev/null 2>&1; then
        perl -MTime::HiRes=time -e 'printf "%d\n", time * 1000'
    elif command -v python3 >/dev/null 2>&1; then
        python3 -c 'import time; print(int(time.time()*1000))'
    else
        printf '%d000' "$(date -u +%s)"
    fi
}

goal_lock_sleep_ms() {
    local ms="$1"
    if command -v perl >/dev/null 2>&1; then
        perl -e "select(undef, undef, undef, $ms/1000)"
    elif command -v python3 >/dev/null 2>&1; then
        python3 -c "import time; time.sleep($ms/1000.0)"
    else
        # Fallback: sleep accepts fractional seconds on macOS/Linux GNU sleep.
        sleep "$(awk -v ms="$ms" 'BEGIN{printf "%.3f", ms/1000.0}')" 2>/dev/null \
            || sleep 1
    fi
}
