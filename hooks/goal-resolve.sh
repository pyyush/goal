#!/usr/bin/env bash
# hooks/goal-resolve.sh — v3 session-scoped resolver. Sourced helper.
#
# v3 model: a goal is OWNED by exactly one session. Resolution is by ownership,
# not by walking up to "the single file at the root". Resolving is READ-ONLY:
# unlike v2, it NEVER creates a session->goal binding as a side effect. Bindings
# are written only by the /goal slash command (create) and `/goal adopt`.
#
# This single change fixes:
#   - Bug 1: two sessions in one folder no longer share one mutable file.
#   - Bug 3: rendering the status line in a fresh session can no longer adopt
#            it into a goal it never asked for.
#
# Globals set by goal_resolve_owned on success:
#   GOAL_ROOT    project root containing .goal/
#   GOAL_DIR     $GOAL_ROOT/.goal
#   GOAL_ID      the owned goal's id
#   GOAL_FILE    $GOAL_DIR/goals/<GOAL_ID>.json
#   GOAL_LOCK    $GOAL_DIR/locks/<GOAL_ID>.lock
#   GOAL_CURSOR  $GOAL_DIR/cursors/<GOAL_ID>
#   EVENTS_FILE  $GOAL_DIR/events.jsonl
#   KILL_SWITCH  $GOAL_DIR/pause
#
# Requires bash 3.2+, jq.

# goal_find_root <cwd> — sets GOAL_ROOT to the nearest ancestor that contains a
# .goal/ directory, stopping at $HOME so user-scope ~/.claude is never a root.
# Falls back to <cwd> when none is found. Always succeeds.
goal_find_root() {
    local d="${1:-$PWD}"
    GOAL_ROOT=""
    while [ -n "$d" ] && [ "$d" != "/" ] && [ "$d" != "$HOME" ]; do
        if [ -d "$d/.goal" ]; then
            GOAL_ROOT="$d"
            return 0
        fi
        d=$(dirname "$d")
    done
    GOAL_ROOT="${1:-$PWD}"
    return 0
}

# goal_is_terminal <status> — true for states the dispatcher must never drive.
goal_is_terminal() {
    case "$1" in
        achieved|abandoned|budget-limited) return 0 ;;
        *) return 1 ;;
    esac
}

# goal_resolve_owned <session_id> <cwd>
# Resolves the goal the given session OWNS. Read-only. Returns 1 (and clears all
# globals) when: no session id, the session owns no goal, the pointer dangles,
# the goal file is unreadable, or the file's goal_id disagrees with the pointer
# (guards against a recycled session id). A miss is not an error — callers
# exit 0 on a 1 return.
goal_resolve_owned() {
    local sid="${1:-}" cwd="${2:-$PWD}"
    GOAL_ROOT="" GOAL_DIR="" GOAL_ID="" GOAL_FILE="" GOAL_LOCK=""
    GOAL_CURSOR="" EVENTS_FILE="" KILL_SWITCH=""

    [ -n "$sid" ] || return 1
    goal_find_root "$cwd"
    local gdir="$GOAL_ROOT/.goal"
    local ptr="$gdir/sessions/$sid"
    [ -f "$ptr" ] && [ ! -L "$ptr" ] || return 1

    local gid
    gid=$(tr -d ' \t\r\n' < "$ptr" 2>/dev/null) || return 1
    [ -n "$gid" ] || return 1

    local gfile="$gdir/goals/$gid.json"
    [ -f "$gfile" ] && [ ! -L "$gfile" ] || return 1

    # The pointer must agree with the file it names.
    local on_disk
    on_disk=$(jq -r '.goal_id // ""' "$gfile" 2>/dev/null) || return 1
    [ "$on_disk" = "$gid" ] || return 1

    GOAL_DIR="$gdir"
    GOAL_ID="$gid"
    GOAL_FILE="$gfile"
    GOAL_LOCK="$gdir/locks/$gid.lock"
    GOAL_CURSOR="$gdir/cursors/$gid"
    EVENTS_FILE="$gdir/events.jsonl"
    KILL_SWITCH="$gdir/pause"
    # Ensure the runtime subdirs exist (idempotent, cheap).
    mkdir -p "$gdir/locks" "$gdir/cursors" 2>/dev/null || true
    return 0
}

# goal_discover_project <cwd> — prints one TSV line "<goal_id> <status>
# <objective>" for every NON-TERMINAL goal in the project. Read-only. Used
# solely by the /goal slash command to OFFER adoption — never to bind a session.
# Prints nothing when there are no live goals.
goal_discover_project() {
    goal_find_root "${1:-$PWD}"
    local gd="$GOAL_ROOT/.goal/goals" f
    [ -d "$gd" ] || return 0
    for f in "$gd"/*.json; do
        [ -f "$f" ] || continue
        jq -r 'select((.status // "") as $s
                      | ($s=="pursuing" or $s=="paused" or $s=="needs-input"))
               | [.goal_id, .status, (.objective // "" | gsub("[\t\n]";" "))]
               | @tsv' "$f" 2>/dev/null
    done
}
