#!/usr/bin/env bash
# .claude/hooks/goal-statusline.sh
#
# Helper for the Claude Code statusLine — outputs a single segment showing
# the active /goal status.
#
# Conventions:
#   - Label wording per state: "Pursuing goal", "Goal paused", "Goal achieved",
#     "Goal abandoned", "Goal unmet".
#   - Color: magenta (named ANSI 35) for every state. Named ANSI is
#     theme-adaptive — terminals remap it to a readable hue on both dark and
#     light backgrounds.
#   - Compact token formatting (12.5K, 100K, 1.2M).
#   - Compact elapsed formatting (12s, 5m, 1h 23m, 1d 12h 3m). Reflects
#     active-pursuit time only (paused intervals are excluded).
#   - Pull-based: refreshes only when Claude Code re-renders the statusLine.
#
# Style override:
#   GOAL_STATUSLINE_STYLE = magenta | dim | plain
#     magenta (default): single ANSI 35
#     dim:               ANSI 35 + dim attribute — softer
#     plain:             no color — for users who prefer monochrome
#
# Usage from your statusLine command:
#   cwd=$(echo "$input" | jq -r '.cwd // ""')
#   sid=$(echo "$input" | jq -r '.session_id // ""')
#   goal=$(bash "$HOME/.claude/hooks/goal-statusline.sh" "$cwd" "$sid")
#   [ -n "$goal" ] && segments+=("$goal")
#
# Requires: bash 3.2+, jq, awk.

set -euo pipefail

RESOLVER="$(dirname "$0")/goal-resolve.sh"
[ -f "$RESOLVER" ] || exit 0
# shellcheck disable=SC1090
. "$RESOLVER"

resolve_goal "${2:-}" "${1:-$PWD}" || exit 0

SHAPE=$(jq -r '
    if (type == "object" and (.status | type) == "string") then
        ( (try (.pursuing_since | fromdateiso8601) catch null) ) as $since
        | ( (try (.created_at | fromdateiso8601) catch null) ) as $created
        | ( .pursuing_seconds // 0 ) as $base
        # Backward-compat: if pursuing_since is missing on a pursuing legacy
        # file, approximate by using created_at as the session start.
        | ( if .status == "pursuing"
              then (if $since != null then $since
                    elif $created != null then $created
                    else null end)
              else null
            end ) as $start
        | ( if $start != null
              then $base + ((now - ($start | floor)) | floor | (if . < 0 then 0 else . end))
              else $base
            end ) as $elapsed
        | [ .status,
            (.token_budget // null | tostring),
            (.tokens_used // 0 | tostring),
            ($elapsed | tostring)
          ] | @tsv
    else "MALFORMED"
    end
' "$GOAL_FILE" 2>/dev/null) || exit 0

[ "$SHAPE" = "MALFORMED" ] && exit 0

IFS=$'\t' read -r STATUS TOKEN_BUDGET TOKENS_USED TIME_USED <<<"$SHAPE"

case "$TOKENS_USED" in ''|*[!0-9]*) TOKENS_USED=0 ;; esac
case "$TIME_USED"   in ''|*[!0-9]*) TIME_USED=0 ;; esac

# Compact elapsed (active pursuit time only):
#   < 60s   → "45s"
#   < 60m   → "5m"
#   < 24h   → "1h 23m"
#   ≥ 24h   → "1d 12h 3m" (always all three units once ≥ 1 day)
fmt_elapsed() {
    local s="$1"
    if   [ "$s" -lt 60 ];    then printf '%ds' "$s"
    elif [ "$s" -lt 3600 ];  then printf '%dm' $((s / 60))
    elif [ "$s" -lt 86400 ]; then printf '%dh %dm' $((s / 3600)) $(((s % 3600) / 60))
    else                          printf '%dd %dh %dm' \
                                      $((s / 86400)) \
                                      $(((s % 86400) / 3600)) \
                                      $(((s % 3600) / 60))
    fi
}

# Compact tokens: "950" / "12.5K" / "100K" / "1.2M".
fmt_tokens() {
    awk -v n="$1" 'BEGIN {
        if (n < 1000)         { printf "%d", n; }
        else if (n < 100000)  { printf "%.1fK", n/1000; }
        else if (n < 1000000) { printf "%.0fK", n/1000; }
        else                  { printf "%.1fM", n/1000000; }
    }'
}

# Style — defaults to plain magenta. Theme-adaptive: named
# ANSI 35 is remapped by the terminal to be readable on both dark and light
# backgrounds.
case "${GOAL_STATUSLINE_STYLE:-magenta}" in
    plain)        open=''            ; close='' ;;
    dim)          open=$'\033[2;35m' ; close=$'\033[0m' ;;
    magenta|*)    open=$'\033[35m'   ; close=$'\033[0m' ;;
esac

# Build the usage suffix used by Active / BudgetLimited.
usage_with_budget() {
    printf '%s / %s' "$(fmt_tokens "$TOKENS_USED")" "$(fmt_tokens "$TOKEN_BUDGET")"
}

case "$STATUS" in
    pursuing)
        if [ "$TOKEN_BUDGET" != "null" ] && [ "$TOKEN_BUDGET" -gt 0 ] 2>/dev/null; then
            label="Pursuing goal ($(usage_with_budget))"
        elif [ "$TIME_USED" -gt 0 ]; then
            label="Pursuing goal ($(fmt_elapsed "$TIME_USED"))"
        else
            label="Pursuing goal"
        fi
        ;;
    paused)
        label="Goal paused (/goal resume)"
        ;;
    achieved)
        if [ "$TOKEN_BUDGET" != "null" ] && [ "$TOKEN_BUDGET" -gt 0 ] 2>/dev/null; then
            label="Goal achieved ($(fmt_tokens "$TOKENS_USED"))"
        elif [ "$TIME_USED" -gt 0 ]; then
            label="Goal achieved ($(fmt_elapsed "$TIME_USED"))"
        else
            label="Goal achieved"
        fi
        ;;
    unmet)
        label="Goal unmet (/goal status)"
        ;;
    budget-limited)
        if [ "$TOKEN_BUDGET" != "null" ] && [ "$TOKEN_BUDGET" -gt 0 ] 2>/dev/null; then
            label="Goal abandoned ($(usage_with_budget))"
        else
            label="Goal abandoned"
        fi
        ;;
    *)
        exit 0
        ;;
esac

printf '%s%s%s' "$open" "$label" "$close"
