#!/usr/bin/env bash
# .claude/hooks/goal-statusline.sh
#
# Helper for the Claude Code statusLine — outputs a single segment showing
# the active /goal status, designed to mirror Codex's TUI bottom_pane
# indicator (codex-rs/tui/src/bottom_pane/footer.rs:537-567).
#
# Faithful to Codex on:
#   - Label wording per state ("Pursuing goal", "Goal paused", "Goal achieved",
#     "Goal abandoned").
#   - Color: magenta (named ANSI 35), the only color Codex uses for the
#     indicator regardless of state. Named ANSI is theme-adaptive — terminals
#     remap it to a readable hue on both dark and light backgrounds.
#   - Compact token formatting (12.5K, 100K, 1.2M).
#   - Compact elapsed formatting (12s, 5m, 1h23m, 2d4h).
#
# Differences from Codex:
#   - Push vs pull: Codex pushes from runtime events; this is pull-based and
#     refreshes only when Claude Code re-renders the statusLine.
#   - Adds a port-specific "Goal unmet" label for the `unmet` state (model
#     gave up); Codex has no equivalent state.
#   - Codex hides the indicator in Plan mode; Claude Code's hook input
#     doesn't expose mode, so we always render.
#
# Style override:
#   GOAL_STATUSLINE_STYLE = magenta | dim | plain
#     magenta (default): single ANSI 35 — matches Codex
#     dim:               ANSI 35 + dim attribute — softer, reference-like
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
        [ .status,
          (.token_budget // null | tostring),
          (.tokens_used // 0 | tostring),
          (if (.created_at // null | type) == "string"
            then ((now - (.created_at | fromdateiso8601)) | floor | tostring)
            else "0"
          end)
        ] | @tsv
    else "MALFORMED"
    end
' "$GOAL_FILE" 2>/dev/null) || exit 0

[ "$SHAPE" = "MALFORMED" ] && exit 0

IFS=$'\t' read -r STATUS TOKEN_BUDGET TOKENS_USED TIME_USED <<<"$SHAPE"

case "$TOKENS_USED" in ''|*[!0-9]*) TOKENS_USED=0 ;; esac
case "$TIME_USED"   in ''|*[!0-9]*) TIME_USED=0 ;; esac

# Compact elapsed: "12s", "5m", "1h23m", "2d4h"
fmt_elapsed() {
    local s="$1"
    if   [ "$s" -lt 60 ];    then printf '%ds' "$s"
    elif [ "$s" -lt 3600 ];  then printf '%dm' $((s / 60))
    elif [ "$s" -lt 86400 ]; then printf '%dh%dm' $((s / 3600)) $(((s % 3600) / 60))
    else                          printf '%dd%dh' $((s / 86400)) $(((s % 86400) / 3600))
    fi
}

# Compact tokens, matching Codex's compact_tokens (goal_status.rs:66):
# "950" / "12.5K" / "100K" / "1.2M"
fmt_tokens() {
    awk -v n="$1" 'BEGIN {
        if (n < 1000)         { printf "%d", n; }
        else if (n < 100000)  { printf "%.1fK", n/1000; }
        else if (n < 1000000) { printf "%.0fK", n/1000; }
        else                  { printf "%.1fM", n/1000000; }
    }'
}

# Style — defaults to plain magenta (matches Codex). Theme-adaptive: named
# ANSI 35 is remapped by the terminal to be readable on both dark and light
# backgrounds.
case "${GOAL_STATUSLINE_STYLE:-magenta}" in
    plain)        open=''            ; close='' ;;
    dim)          open=$'\033[2;35m' ; close=$'\033[0m' ;;
    magenta|*)    open=$'\033[35m'   ; close=$'\033[0m' ;;
esac

# Build the usage suffix used by Active / BudgetLimited (matches Codex's
# active_goal_usage helper, goal_status.rs:66).
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
        # Port-specific state — Codex has no equivalent. Use neutral wording.
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
