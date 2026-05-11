#!/usr/bin/env bash
# .claude/hooks/goal-resolve.sh
#
# Sourced helper — locates the active /goal state for a given session and
# directory. Sets these globals on success:
#
#   GOAL_ROOT    project root (directory containing .claude/ or .goal/)
#   GOAL_FILE    absolute path to state file (prefers .goal/state.json, falls
#                back to .claude/goal.json for v1 / GOAL_DISABLE_MIGRATION=1)
#   GOAL_DIR     absolute path to the v2 state directory ($GOAL_ROOT/.goal).
#                Set even when falling back to v1 path, so callers can use it
#                to decide whether migration has happened.
#   LOG_FILE     absolute path to goal-hook.log
#   KILL_SWITCH  absolute path to goal.pause
#
# Resolution order:
#   1) Session pointer (~/.claude/goal-sessions/<session_id>.goal). Sticky
#      to a session even if the user /cwd's somewhere outside the goal's tree.
#   2) Walk up from $cwd looking for:
#        a) .goal/state.json   (v2 — preferred)
#        b) .claude/goal.json  (v1 — compat)
#      Stops at $HOME (so user-scope ~/.claude/ is never the goal root).
#
# If a goal is resolved, the pointer is refreshed for next time.
#
# Usage:
#   . "$(dirname "$0")/goal-resolve.sh"
#   resolve_goal "$session_id" "$cwd" || exit 0   # exit-0 on miss

resolve_goal() {
    local sid="${1:-}"
    local cwd="${2:-$PWD}"

    GOAL_ROOT=""
    GOAL_FILE=""
    GOAL_DIR=""
    LOG_FILE=""
    KILL_SWITCH=""

    # 1) Session pointer.
    if [ -n "$sid" ] && [ -f "$HOME/.claude/goal-sessions/${sid}.goal" ]; then
        local pointer
        pointer=$(cat "$HOME/.claude/goal-sessions/${sid}.goal" 2>/dev/null)
        if [ -n "$pointer" ] && [ ! -L "$pointer" ]; then
            # pointer may point at either v1 (.claude/goal.json) or v2
            # (.goal/state.json). Accept both if file exists.
            if [ -f "$pointer" ]; then
                GOAL_FILE="$pointer"
                # Derive GOAL_ROOT from the pointer path.
                # v2: pointer ends in .goal/state.json → root = dirname(dirname)
                # v1: pointer ends in .claude/goal.json → root = dirname(dirname)
                GOAL_ROOT=$(dirname "$(dirname "$pointer")")
            fi
        fi
    fi

    # 2) Walk up from cwd — prefer v2 (.goal/state.json), fall back to v1.
    if [ -z "$GOAL_FILE" ]; then
        local d="$cwd"
        while [ "$d" != "/" ] && [ "$d" != "$HOME" ] && [ -n "$d" ]; do
            # Prefer v2 state dir.
            if [ -f "$d/.goal/state.json" ] && [ ! -L "$d/.goal/state.json" ]; then
                GOAL_ROOT="$d"
                GOAL_FILE="$d/.goal/state.json"
                break
            fi
            # Fall back to v1 file (also used when GOAL_DISABLE_MIGRATION=1).
            if [ -f "$d/.claude/goal.json" ] && [ ! -L "$d/.claude/goal.json" ]; then
                GOAL_ROOT="$d"
                GOAL_FILE="$d/.claude/goal.json"
                break
            fi
            d=$(dirname "$d")
        done
    fi

    [ -z "$GOAL_FILE" ] && return 1

    # GOAL_DIR always points at the v2 dir for this root, regardless of which
    # file was found. Callers use this to check migration status.
    GOAL_DIR="$GOAL_ROOT/.goal"

    LOG_FILE="$GOAL_ROOT/.claude/goal-hook.log"
    KILL_SWITCH="$GOAL_ROOT/.claude/goal.pause"

    # Refresh session pointer so future fires skip the walk-up.
    if [ -n "$sid" ]; then
        mkdir -p "$HOME/.claude/goal-sessions" 2>/dev/null || true
        printf '%s\n' "$GOAL_FILE" > "$HOME/.claude/goal-sessions/${sid}.goal" 2>/dev/null || true
    fi
    return 0
}
