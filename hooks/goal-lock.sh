#!/usr/bin/env bash
# goal-lock.sh — sourced helper. Portable directory-based mutex around
# goal state, coordinating with the Node side's `proper-lockfile`.
#
# Both sides treat the lock directory as the mutex: `mkdir` is atomic on
# POSIX, so the first writer to mkdir wins. The pid file inside the lockdir
# is informational (used for stale-lock detection only).
#
# Lock path selection (v2-aware):
#   - After migration:  $GOAL_ROOT/.goal/lock
#   - Before migration: $GOAL_ROOT/.claude/goal.lock
#   Use goal_lock_path "$GOAL_ROOT" to get the canonical path for the root.
#
# Usage from a bash script:
#   . "$(dirname "$0")/goal-lock.sh"       # adjust path as needed
#   goal_lock_acquire "$GOAL_ROOT" || exit 1
#   trap 'goal_lock_release "$GOAL_ROOT"' EXIT INT TERM
#   ... do RMW on goal state ...
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

# goal_lock_path: returns the canonical lockdir path for a given root.
# After migration (.goal/ exists), the lock lives at .goal/lock.
# Before migration, it lives at .claude/goal.lock (legacy path).
goal_lock_path() {
    local root="$1"
    if [ -d "$root/.goal" ]; then
        printf '%s/.goal/lock' "$root"
    else
        printf '%s/.claude/goal.lock' "$root"
    fi
}

goal_lock_acquire() {
    local root="$1"
    local timeout_ms="${GOAL_LOCK_TIMEOUT_MS:-5000}"
    local stale_ms="${GOAL_LOCK_STALE_MS:-30000}"
    local lockdir
    lockdir=$(goal_lock_path "$root")
    local pidfile="$lockdir/pid"

    # Ensure the parent of the lockdir exists.
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
            # actually win — loop and retry. This is the second half of the
            # TOCTOU fix; the rename-based steal alone isn't sufficient.
            printf '%d\n%d\n' "$$" "$(goal_lock_now_ms)" > "$pidfile" 2>/dev/null || true
            local _verify
            _verify=$(head -n1 "$pidfile" 2>/dev/null | tr -d ' \t\r\n')
            if [ "$_verify" = "$$" ]; then
                return 0
            fi
            # Got swapped — give the racing stealer a moment, then retry.
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
                # Owner is dead. Steal.
                should_steal=1
            elif [ -n "$held_at" ]; then
                local now_ms held_for_ms
                now_ms=$(goal_lock_now_ms)
                held_for_ms=$((now_ms - held_at))
                if [ "$held_for_ms" -ge "$stale_ms" ]; then
                    # Held too long. Steal — owner is hung.
                    should_steal=1
                fi
            fi

            if [ "$should_steal" = 1 ]; then
                # ATOMIC STEAL: rename the stale lockdir aside, THEN remove it.
                # `mv` is rename(2) — atomic. Only one stealer wins; if the lock
                # was already released and re-acquired by another process, our
                # rename misses (source no longer exists, or its inode changed)
                # and the active holder is undisturbed. This closes the TOCTOU
                # race where `rm -rf` could blow away a fresh lock that another
                # process had legitimately acquired in the window between our
                # staleness read and our removal.
                local dead="${lockdir}.dead.$$.$(goal_lock_now_ms)"
                if mv "$lockdir" "$dead" 2>/dev/null; then
                    rm -rf "$dead" 2>/dev/null
                fi
                continue
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
    local lockdir
    lockdir=$(goal_lock_path "$root")
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
        # Fallback: sleep accepts fractional seconds on macOS/Linux GNU sleep.
        sleep "$(awk -v ms="$ms" 'BEGIN{printf "%.3f", ms/1000.0}')" 2>/dev/null \
            || sleep 1
    fi
}
