#!/usr/bin/env bash
# hooks/goal-statusline-wrap.sh — additive statusLine wrapper.
#
# Set as `statusLine.command`. It NEVER replaces the user's status line: it runs
# whatever status line was there before (preserved verbatim as the "inner"
# command) and appends the /goal cockpit line below it.
#
#   <the user's existing status line, untouched>
#   ◎ Migrate auth to session API · 4/7 · 12m      <- goal line, added
#
# When no goal is active, only the inner line is printed — zero footprint.
# When the user never had a status line, a minimal default line is shown.
#
# State (written by bin/goal-statusline-install):
#   $HOME/.claude/goal/statusline-inner   the original statusLine command
#
# Hardening: `set -u` only. A status line script must never abort or it renders
# blank — every step is guarded; the worst case is the inner line alone.
#
# Requires bash 3.2+, jq.

set -u

SELF_DIR=$(cd "$(dirname "$0")" 2>/dev/null && pwd) || SELF_DIR=""
INNER_FILE="$HOME/.claude/goal/statusline-inner"

INPUT=$(cat 2>/dev/null || printf '{}')
[ -n "$INPUT" ] || INPUT='{}'

# --- inner: the user's own status line, run verbatim ------------------------

INNER_CMD=""
[ -r "$INNER_FILE" ] && INNER_CMD=$(cat "$INNER_FILE" 2>/dev/null)
# Never recurse into ourselves.
case "$INNER_CMD" in *goal-statusline-wrap.sh*) INNER_CMD="" ;; esac

INNER_OUT=""
if [ -n "$INNER_CMD" ]; then
    INNER_OUT=$(printf '%s' "$INPUT" | eval "$INNER_CMD" 2>/dev/null) || INNER_OUT=""
fi

# Fallback: the user had no status line at all — show a minimal default so the
# wrapper is still a complete, useful status line on its own.
if [ -z "$INNER_CMD" ]; then
    INNER_OUT=$(printf '%s' "$INPUT" | jq -r '
        "[" + (.model.display_name // "Claude") + "] "
        + ((.workspace.current_dir // .cwd // "") | sub(".*/"; ""))
        + ( (.context_window.used_percentage // null) as $p
            | if $p != null then "  " + ($p | floor | tostring) + "% ctx" else "" end )
    ' 2>/dev/null) || INNER_OUT=""
fi

# --- goal segment -----------------------------------------------------------

GOAL_OUT=""
if [ -n "$SELF_DIR" ] && [ -f "$SELF_DIR/goal-statusline.sh" ]; then
    CWD=$(printf '%s' "$INPUT" | jq -r '.workspace.current_dir // .cwd // ""' 2>/dev/null) || CWD=""
    SID=$(printf '%s' "$INPUT" | jq -r '.session_id // ""' 2>/dev/null) || SID=""
    GOAL_OUT=$(bash "$SELF_DIR/goal-statusline.sh" "$CWD" "$SID" 2>/dev/null) || GOAL_OUT=""
fi

# --- compose: inner line(s), then the goal line (only if a goal is active) --

if [ -n "$INNER_OUT" ] && [ -n "$GOAL_OUT" ]; then
    printf '%s\n%s\n' "$INNER_OUT" "$GOAL_OUT"
elif [ -n "$GOAL_OUT" ]; then
    printf '%s\n' "$GOAL_OUT"
elif [ -n "$INNER_OUT" ]; then
    printf '%s\n' "$INNER_OUT"
fi
