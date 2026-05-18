#!/usr/bin/env bash
# goal-lock.sh — sourced helper. Generic mkdir-based file lock.
#
# v3: the signature is `goal_lock_acquire <lockdir>` — the caller decides what
# path to lock. This replaces the v2 signature `goal_lock_acquire <root>` that
# baked v1/v2 path picking into the helper itself. v3 callers pass the explicit
# path:
#
#   * per-goal RMW lock:        $GOAL_ROOT/.goal/locks/<goal_id>.lock
#   * project-coordination lock: $GOAL_ROOT/.goal/locks/_coord.lock
#
# These are the same paths the v3 MCP server (proper-lockfile) and v3 hooks
# (inline mkdir mutex in goal-stop.sh / goal-prompt.sh / goal-notify.sh) use,
# so all writers across runtimes serialize against each other on the right
# granularity. The Stop hook's inline lock and this helper agree byte-for-byte.
#
# Usage:
#   . "$(dirname "$0")/goal-lock.sh"
#   GLOCK=".goal/locks/${GOAL_ID}.lock"          # or "_coord.lock"
#   goal_lock_acquire "$GLOCK" || exit 1
#   trap 'goal_lock_release "$GLOCK"' EXIT INT TERM
#   ...do RMW...
#   goal_lock_release "$GLOCK"
#   trap - EXIT INT TERM
#
# Tunables (env vars):
#   GOAL_LOCK_TIMEOUT_MS    overall acquisition timeout (default 5000)
#   GOAL_LOCK_STALE_MS      consider a lock stale and steal it after (default 30000)

# goal_lock_acquire <lockdir> [timeout_ms] [stale_ms]
goal_lock_acquire() {
    local lockdir="$1"
    local timeout_ms="${2:-${GOAL_LOCK_TIMEOUT_MS:-5000}}"
    local stale_ms="${3:-${GOAL_LOCK_STALE_MS:-30000}}"
    [ -n "$lockdir" ] || return 2
    local pidfile="$lockdir/pid"

    local lockparent
    lockparent=$(dirname "$lockdir")
    [ -d "$lockparent" ] || mkdir -p "$lockparent" 2>/dev/null || return 1

    local started_ms
    started_ms=$(goal_lock_now_ms)
    local backoff_ms=50

    while :; do
        if mkdir "$lockdir" 2>/dev/null; then
            # Acquired. Stamp pid + timestamp inside, then VERIFY ownership by
            # reading the pid back. A concurrent stealer that races between our
            # mkdir and our pid-write can `mv` our fresh lockdir aside (still
            # appearing "stale" from its pre-fetched view) and recreate it; our
            # pidfile then ends up under .dead.<X>/, not at $pidfile, so the
            # readback will show empty or a different pid. If so, we did NOT
            # actually win — loop and retry. This closes the TOCTOU race.
            printf '%d\n%d\n' "$$" "$(goal_lock_now_ms)" > "$pidfile" 2>/dev/null || true
            local _verify
            _verify=$(head -n1 "$pidfile" 2>/dev/null | tr -d ' \t\r\n')
            if [ "$_verify" = "$$" ]; then
                return 0
            fi
            goal_lock_sleep_ms 25
            continue
        fi

        # Held — check for staleness.
        if [ -f "$pidfile" ]; then
            local owner held_at
            {
                IFS= read -r owner || owner=""
                IFS= read -r held_at || held_at=""
            } < "$pidfile" 2>/dev/null

            local should_steal=0
            if [ -n "$owner" ] && ! kill -0 "$owner" 2>/dev/null; then
                should_steal=1
            elif [ -n "$held_at" ]; then
                local now_ms held_for_ms
                now_ms=$(goal_lock_now_ms)
                held_for_ms=$((now_ms - held_at))
                if [ "$held_for_ms" -ge "$stale_ms" ]; then
                    should_steal=1
                fi
            fi

            if [ "$should_steal" = 1 ]; then
                # ATOMIC STEAL: rename the stale lockdir aside, THEN remove it.
                # rename(2) is atomic — only one stealer wins; if the lock was
                # released and re-acquired by another process, our rename
                # misses (source no longer exists, or its inode changed) and
                # the active holder is undisturbed. This closes the TOCTOU
                # race where naive `rm -rf` could blow away a fresh lock
                # between our staleness read and our removal.
                local dead="${lockdir}.dead.$$.$(goal_lock_now_ms)"
                if mv "$lockdir" "$dead" 2>/dev/null; then
                    rm -rf "$dead" 2>/dev/null
                fi
                continue
            fi
        fi

        local elapsed_ms
        elapsed_ms=$(( $(goal_lock_now_ms) - started_ms ))
        if [ "$elapsed_ms" -ge "$timeout_ms" ]; then
            return 1
        fi

        goal_lock_sleep_ms "$backoff_ms"
        backoff_ms=$(( backoff_ms < 250 ? backoff_ms * 2 : 250 ))
    done
}

# goal_lock_release <lockdir>
goal_lock_release() {
    local lockdir="$1"
    [ -n "$lockdir" ] || return 0
    rm -rf "$lockdir" 2>/dev/null
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
        sleep "$(awk -v ms="$ms" 'BEGIN{printf "%.3f", ms/1000.0}')" 2>/dev/null \
            || sleep 1
    fi
}
