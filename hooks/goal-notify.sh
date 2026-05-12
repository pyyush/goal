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

LOCK_SH="$(dirname "$0")/goal-lock.sh"
[ -f "$LOCK_SH" ] || exit 0
# shellcheck disable=SC1090
. "$LOCK_SH"

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
if ! goal_lock_acquire "$GOAL_ROOT"; then
    {
        printf '{"ts":"%s","pid":%d,"hook":"notify","session":%s,"event":"lock-timeout","note":"could not acquire goal lock"}\n' \
            "$NOW" "$$" \
            "$(printf '%s' "$SESSION_ID" | jq -Rs . 2>/dev/null || printf '""')" \
            >> "$LOG_FILE" 2>/dev/null || true
    }
    exit 0
fi
trap 'goal_lock_release "$GOAL_ROOT"' EXIT INT TERM

STATE_DIR=$(dirname "$GOAL_FILE")
TMP=$(mktemp "$STATE_DIR/.state.XXXXXX") || {
    goal_lock_release "$GOAL_ROOT"
    trap - EXIT INT TERM
    exit 0
}
# Auto-pause: accumulate pursuit time from pursuing_since (with legacy
# fallback to created_at) before clearing it.
if jq --arg ts "$NOW" --arg r "$reason" --arg gid "$GOAL_ID" \
     'if ((.goal_id // "") == $gid and (.status // "") == "pursuing") then
          ( (try (.pursuing_since | fromdateiso8601) catch null) ) as $since
          | ( (try (.created_at | fromdateiso8601) catch null) ) as $created
          | ( $since // $created ) as $start
          | ( .pursuing_seconds // 0 ) as $base
          | ( if $start != null
                then $base + ((now - ($start | floor)) | floor | (if . < 0 then 0 else . end))
                else $base
              end ) as $new_seconds
          | .status = "paused"
          | .updated_at = $ts
          | .pursuing_seconds = $new_seconds
          | .pursuing_since = null
          | .history = ((.history // []) + [{ts: $ts, action: "auto-pause-error", note: $r}])
      else . end' \
     "$GOAL_FILE" > "$TMP" 2>/dev/null; then
    mv "$TMP" "$GOAL_FILE"
else
    rm -f "$TMP"
fi
goal_lock_release "$GOAL_ROOT"
trap - EXIT INT TERM

{
    printf '{"ts":"%s","pid":%d,"hook":"notify","session":%s,"event":"auto-pause-error","note":%s}\n' \
        "$NOW" "$$" \
        "$(printf '%s' "$SESSION_ID" | jq -Rs . 2>/dev/null || printf '""')" \
        "$(printf '%s' "$reason" | jq -Rs . 2>/dev/null || printf '""')" \
        >> "$LOG_FILE" 2>/dev/null || true
}
