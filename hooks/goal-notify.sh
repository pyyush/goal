#!/usr/bin/env bash
# .claude/hooks/goal-notify.sh
#
# Notification hook for /goal — auto-pauses an active goal when Claude Code
# surfaces a rate-limit, API error, quota, or overload notification.
#
# Best-effort: depends on Claude Code emitting Notification events with
# recognizable text. If your client doesn't fire Notification on errors,
# the goal naturally stops anyway (no Stop hook fires while the API is
# unreachable), and resumes when the runtime recovers.
#
# Resolves goal state by walking up from $PWD. Requires bash 3.2+, jq.

set -euo pipefail

find_goal_root() {
    local d="${1:-$PWD}"
    while [ "$d" != "/" ] && [ "$d" != "$HOME" ] && [ -n "$d" ]; do
        if [ -f "$d/.claude/goal.json" ]; then
            printf '%s' "$d"
            return
        fi
        d=$(dirname "$d")
    done
}

GOAL_ROOT=$(find_goal_root "$PWD")
[ -n "$GOAL_ROOT" ] || exit 0

GOAL_FILE="$GOAL_ROOT/.claude/goal.json"
LOG_FILE="$GOAL_ROOT/.claude/goal-hook.log"

[ -L "$GOAL_FILE" ] && exit 0

INPUT=$(cat || printf '')
INPUT=${INPUT:-\{\}}

STATUS=$(jq -r '.status // ""' "$GOAL_FILE" 2>/dev/null) || exit 0
[ "$STATUS" = "pursuing" ] || exit 0

MESSAGE=$(printf '%s' "$INPUT" | jq -r '((.message // "") + " " + (.title // "") + " " + (.notification_type // ""))' 2>/dev/null) || MESSAGE=""
[ -z "$MESSAGE" ] && exit 0

reason=""
case "$MESSAGE" in
    *[Rr]ate[\ -][Ll]imit*|*rate_limit*|*RATE_LIMIT*) reason="rate limit" ;;
    *[Qq]uota*[Ee]xceeded*|*[Qq]uota*[Ll]imit*)        reason="quota exceeded" ;;
    *[Oo]verload*)                                      reason="API overloaded" ;;
    *5[0-9][0-9]*[Ee]rror*|*[Ss]erver[\ -][Ee]rror*)   reason="server error" ;;
    *[Aa]uthentication[\ -][Ee]rror*|*[Aa]uthorization[\ -][Ee]rror*|*[Ii]nvalid[\ -][Aa]PI*) reason="auth error" ;;
    *[Tt]imeout*|*[Tt]imed[\ -][Oo]ut*)                reason="timeout" ;;
    *)                                                  exit 0 ;;
esac

NOW=$(date -u +%FT%TZ)
TMP=$(mktemp "$GOAL_ROOT/.claude/goal.json.XXXXXX") || exit 0
if jq --arg ts "$NOW" --arg r "$reason" \
     '.status = "paused"
      | .updated_at = $ts
      | .history = ((.history // []) + [{ts: $ts, action: "auto-pause-error", note: $r}])' \
     "$GOAL_FILE" > "$TMP" 2>/dev/null; then
    mv "$TMP" "$GOAL_FILE"
else
    rm -f "$TMP"
fi

{
    printf '{"ts":"%s","pid":%d,"hook":"notify","event":"auto-pause-error","note":%s}\n' \
        "$NOW" "$$" \
        "$(printf '%s' "$reason" | jq -Rs . 2>/dev/null || printf '""')" \
        >> "$LOG_FILE" 2>/dev/null || true
}
