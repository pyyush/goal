#!/usr/bin/env bash
# .claude/hooks/goal-notify.sh
#
# Notification hook for /goal — auto-pauses an active goal when Claude Code
# surfaces a rate-limit, API error, quota, or overload notification.
#
# Resolves goal state via goal-resolve.sh: session pointer first, then
# walk-up from $cwd. Requires bash 3.2+, jq.

set -euo pipefail

RESOLVER="$(dirname "$0")/goal-resolve.sh"
[ -f "$RESOLVER" ] || exit 0
# shellcheck disable=SC1090
. "$RESOLVER"

INPUT=$(cat || printf '')
INPUT=${INPUT:-\{\}}

SESSION_ID=$(printf '%s' "$INPUT" | jq -r '.session_id // ""' 2>/dev/null)
SESSION_CWD=$(printf '%s' "$INPUT" | jq -r '.cwd // ""' 2>/dev/null)

resolve_goal "$SESSION_ID" "${SESSION_CWD:-$PWD}" || exit 0

STATUS=$(jq -r '.status // ""' "$GOAL_FILE" 2>/dev/null) || exit 0
[ "$STATUS" = "pursuing" ] || exit 0

# Capture goal_id for CAS check on write.
GOAL_ID=$(jq -r '.goal_id // ""' "$GOAL_FILE" 2>/dev/null) || GOAL_ID=""

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
if jq --arg ts "$NOW" --arg r "$reason" --arg gid "$GOAL_ID" \
     'if (.goal_id // "") == $gid then
          .status = "paused"
          | .updated_at = $ts
          | .history = ((.history // []) + [{ts: $ts, action: "auto-pause-error", note: $r}])
      else . end' \
     "$GOAL_FILE" > "$TMP" 2>/dev/null; then
    mv "$TMP" "$GOAL_FILE"
else
    rm -f "$TMP"
fi

{
    printf '{"ts":"%s","pid":%d,"hook":"notify","session":%s,"event":"auto-pause-error","note":%s}\n' \
        "$NOW" "$$" \
        "$(printf '%s' "$SESSION_ID" | jq -Rs . 2>/dev/null || printf '""')" \
        "$(printf '%s' "$reason" | jq -Rs . 2>/dev/null || printf '""')" \
        >> "$LOG_FILE" 2>/dev/null || true
}
