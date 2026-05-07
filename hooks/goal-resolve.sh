#!/usr/bin/env bash
# .claude/hooks/goal-resolve.sh
#
# Sourced helper — locates the active /goal state for a given session and
# directory. Sets these globals on success:
#
#   GOAL_ROOT    project root (directory containing .claude/)
#   GOAL_FILE    absolute path to goal.json
#   LOG_FILE     absolute path to goal-hook.log
#   KILL_SWITCH  absolute path to goal.pause
#
# Resolution order:
#   1) Session pointer (~/.claude/goal-sessions/<session_id>.goal). Sticky
#      to a session even if the user /cwd's somewhere outside the goal's tree.
#   2) Walk up from $cwd looking for the nearest enclosing .claude/goal.json,
#      stopping at $HOME (so user-scope ~/.claude/ is never the goal root).
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
    LOG_FILE=""
    KILL_SWITCH=""

    # 1) Session pointer.
    if [ -n "$sid" ] && [ -f "$HOME/.claude/goal-sessions/${sid}.goal" ]; then
        local pointer
        pointer=$(cat "$HOME/.claude/goal-sessions/${sid}.goal" 2>/dev/null)
        if [ -n "$pointer" ] && [ -f "$pointer" ] && [ ! -L "$pointer" ]; then
            GOAL_FILE="$pointer"
            GOAL_ROOT=$(dirname "$(dirname "$pointer")")
        fi
    fi

    # 2) Walk up from cwd.
    if [ -z "$GOAL_FILE" ]; then
        local d="$cwd"
        while [ "$d" != "/" ] && [ "$d" != "$HOME" ] && [ -n "$d" ]; do
            if [ -f "$d/.claude/goal.json" ] && [ ! -L "$d/.claude/goal.json" ]; then
                GOAL_ROOT="$d"
                GOAL_FILE="$d/.claude/goal.json"
                break
            fi
            d=$(dirname "$d")
        done
    fi

    [ -z "$GOAL_FILE" ] && return 1

    LOG_FILE="$GOAL_ROOT/.claude/goal-hook.log"
    KILL_SWITCH="$GOAL_ROOT/.claude/goal.pause"

    # Refresh session pointer so future fires skip the walk-up.
    if [ -n "$sid" ]; then
        mkdir -p "$HOME/.claude/goal-sessions" 2>/dev/null || true
        printf '%s\n' "$GOAL_FILE" > "$HOME/.claude/goal-sessions/${sid}.goal" 2>/dev/null || true
    fi
    return 0
}
