#!/usr/bin/env bash
# .claude/hooks/goal-statusline.sh
#
# Helper for the Claude Code statusLine — outputs a single colored segment
# describing the active /goal status (or nothing if no goal is set).
#
# Designed to be called from your statusLine command. Pass the session's
# working directory as the first argument and (optionally) the session_id
# as the second, both extracted from the statusLine input JSON:
#
#   cwd=$(echo "$input" | jq -r '.cwd // ""')
#   session=$(echo "$input" | jq -r '.session_id // ""')
#   goal_seg=$(bash "$HOME/.claude/hooks/goal-statusline.sh" "$cwd" "$session")
#   [ -n "$goal_seg" ] && segments+=("$goal_seg")
#
# When session_id is provided, the helper uses the session pointer
# (~/.claude/goal-sessions/<sid>.goal) for sticky goal lookup across /cwd
# changes. Otherwise it walks up from $cwd.
#
# Requires: bash 3.2+, jq.

set -euo pipefail

RESOLVER="$(dirname "$0")/goal-resolve.sh"
[ -f "$RESOLVER" ] || exit 0
# shellcheck disable=SC1090
. "$RESOLVER"

resolve_goal "${2:-}" "${1:-$PWD}" || exit 0

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

case "$TIME_USED" in
    ''|*[!0-9]*) TIME_USED=0 ;;
esac

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
