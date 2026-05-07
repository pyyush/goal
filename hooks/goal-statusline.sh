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

[ -f "$GOAL_FILE" ] || exit 0
[ -L "$GOAL_FILE" ] && exit 0

SHAPE=$(jq -r '
    if (type == "object" and (.status | type) == "string") then
        [ .status,
          (.token_budget // null | tostring),
          (.tokens_used // 0 | tostring),
          (.tick_count // 0 | tostring)
        ] | @tsv
    else "MALFORMED"
    end
' "$GOAL_FILE" 2>/dev/null) || exit 0

[ "$SHAPE" = "MALFORMED" ] && exit 0

IFS=$'\t' read -r STATUS TOKEN_BUDGET TOKENS_USED TICK_COUNT <<<"$SHAPE"

reset=$'\033[0m'
green=$'\033[32m'
yellow=$'\033[33m'
red=$'\033[31m'
magenta=$'\033[35m'
cyan=$'\033[36m'
bold=$'\033[1m'

case "$STATUS" in
    pursuing)
        if [ "$TOKEN_BUDGET" != "null" ] && [ "$TOKEN_BUDGET" -gt 0 ] 2>/dev/null; then
            label="Goal pursuing (${TOKENS_USED}/${TOKEN_BUDGET})"
        elif [ "${TICK_COUNT:-0}" -gt 0 ] 2>/dev/null; then
            label="Goal pursuing (tick ${TICK_COUNT})"
        else
            label="Goal pursuing"
        fi
        printf '%s%s%s' "$cyan" "$label" "$reset"
        ;;
    paused)
        printf '%s%s%s' "$magenta" "Goal paused (/goal resume)" "$reset"
        ;;
    achieved)
        printf '%s%s%s%s' "$bold" "$green" "Goal achieved" "$reset"
        ;;
    unmet)
        printf '%s%s%s' "$red" "Goal unmet (/goal status)" "$reset"
        ;;
    budget-limited)
        printf '%s%s%s' "$yellow" "Goal budget-limited" "$reset"
        ;;
esac
