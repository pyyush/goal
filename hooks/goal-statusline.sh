#!/usr/bin/env bash
# .claude/hooks/goal-statusline.sh
#
# Helper for the Claude Code statusLine — outputs a single colored segment
# describing the active /goal status (or nothing if no goal is set).
#
# Designed to be called from your statusLine command. Pass the project's
# working directory as the first argument (the statusLine input JSON has
# this as `.cwd`). Example, from your existing statusline-command.sh:
#
#   goal_seg=$(bash "$HOME/.claude/hooks/goal-statusline.sh" "$cwd")
#   [ -n "$goal_seg" ] && segments+=("$goal_seg")
#
# Requires: bash 3.2+, jq.

set -euo pipefail

CWD="${1:-$PWD}"
GOAL_FILE="$CWD/.claude/goal.json"

[ -L "$GOAL_FILE" ] && exit 0
[ -f "$GOAL_FILE" ] || exit 0

SHAPE=$(jq -r '
    if (type == "object" and (.status | type) == "string") then
        [ .status,
          (.token_budget // null | tostring),
          (.tokens_used // 0 | tostring),
          (.tick_count // 0 | tostring),
          (if (.created_at // null | type) == "string"
            then ((now - (.created_at | fromdateiso8601)) | floor | tostring)
            else "0"
          end)
        ] | @tsv
    else "MALFORMED"
    end
' "$GOAL_FILE" 2>/dev/null) || exit 0

[ "$SHAPE" = "MALFORMED" ] && exit 0

IFS=$'\t' read -r STATUS TOKEN_BUDGET TOKENS_USED TICK_COUNT TIME_USED <<<"$SHAPE"

# Numeric guard
case "$TIME_USED" in
    ''|*[!0-9]*) TIME_USED=0 ;;
esac

# Compact human-readable elapsed string: "12s" | "5m" | "1h23m" | "2d4h"
fmt_elapsed() {
    local s="$1"
    if [ "$s" -lt 60 ]; then
        printf '%ds' "$s"
    elif [ "$s" -lt 3600 ]; then
        printf '%dm' $((s / 60))
    elif [ "$s" -lt 86400 ]; then
        printf '%dh%dm' $((s / 3600)) $(((s % 3600) / 60))
    else
        printf '%dd%dh' $((s / 86400)) $(((s % 86400) / 3600))
    fi
}

reset=$'\033[0m'
green=$'\033[32m'
yellow=$'\033[33m'
red=$'\033[31m'
magenta=$'\033[35m'
cyan=$'\033[36m'
bold=$'\033[1m'

case "$STATUS" in
    pursuing)
        elapsed=$(fmt_elapsed "$TIME_USED")
        if [ "$TOKEN_BUDGET" != "null" ] && [ "$TOKEN_BUDGET" -gt 0 ] 2>/dev/null; then
            label="Goal pursuing (${elapsed} · ${TOKENS_USED}/${TOKEN_BUDGET})"
        else
            label="Goal pursuing (${elapsed})"
        fi
        printf '%s%s%s' "$cyan" "$label" "$reset"
        ;;
    paused)
        elapsed=$(fmt_elapsed "$TIME_USED")
        printf '%s%s%s' "$magenta" "Goal paused (${elapsed}) · /goal resume" "$reset"
        ;;
    achieved)
        elapsed=$(fmt_elapsed "$TIME_USED")
        printf '%s%s%s%s' "$bold" "$green" "Goal achieved (${elapsed})" "$reset"
        ;;
    unmet)
        printf '%s%s%s' "$red" "Goal unmet · /goal status" "$reset"
        ;;
    budget-limited)
        printf '%s%s%s' "$yellow" "Goal budget-limited" "$reset"
        ;;
esac
