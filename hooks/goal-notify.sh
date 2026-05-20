#!/usr/bin/env bash
# hooks/goal-notify.sh — v3 Notification hook for /goal.
#
# Auto-pauses an active goal when Claude Code surfaces a rate-limit, API error,
# quota, or overload notification. The user re-arms with `/goal:goal resume`.
#
# v3 changes vs the v2 version that shipped (broken) with the session-scoped
# merge:
#   - Resolves via `goal_resolve_owned` (the v2 `resolve_goal` symbol no longer
#     exists; the v2 hook was silently aborting on `set -e`).
#   - Per-goal mkdir mutex at $GOAL_LOCK (.goal/locks/<gid>.lock), mirroring
#     the Stop hook. No dependency on the deleted goal-lock.sh.
#   - `set -u` only — same hardening as the Stop hook.

set -u

HOOK_DIR="$(cd "$(dirname "$0")" 2>/dev/null && pwd)" || exit 0

[ -f "$HOOK_DIR/goal-resolve.sh" ] || exit 0
# shellcheck disable=SC1091
. "$HOOK_DIR/goal-resolve.sh"

INPUT=$(cat 2>/dev/null || printf '{}')
[ -n "$INPUT" ] || INPUT='{}'

SESSION_ID=$(printf '%s' "$INPUT" | jq -r '.session_id // ""' 2>/dev/null) || SESSION_ID=""
SESSION_CWD=$(printf '%s' "$INPUT" | jq -r '.cwd // ""'        2>/dev/null) || SESSION_CWD=""

goal_resolve_owned "$SESSION_ID" "${SESSION_CWD:-$PWD}" || exit 0

STATUS=$(jq -r '.status // ""' "$GOAL_FILE" 2>/dev/null) || STATUS=""
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

log_event() {
    [ -n "${EVENTS_FILE:-}" ] || return 0
    {
        printf '{"ts":"%s","src":"notify","session":%s,"goal":"%s","event":"%s","note":%s}\n' \
            "$(date -u +%FT%TZ)" \
            "$(printf '%s' "$SESSION_ID" | jq -Rs . 2>/dev/null || printf '""')" \
            "${GOAL_ID:-}" "$1" \
            "$(printf '%s' "${2:-}" | jq -Rs . 2>/dev/null || printf '""')"
    } >> "$EVENTS_FILE" 2>/dev/null || true
}

# Per-goal mkdir mutex (same pattern as goal-stop.sh / goal-prompt.sh).
lock_acquire() {
    local started elapsed
    started=$(date +%s 2>/dev/null || echo 0)
    mkdir -p "$(dirname "$GOAL_LOCK")" 2>/dev/null || true
    while :; do
        if mkdir "$GOAL_LOCK" 2>/dev/null; then
            printf '%d' "$$" > "$GOAL_LOCK/pid" 2>/dev/null
            local _v; _v=$(cat "$GOAL_LOCK/pid" 2>/dev/null | tr -d ' \t\r\n')
            [ "$_v" = "$$" ] && return 0
            sleep 0.02 2>/dev/null || true
            continue
        fi
        if [ -f "$GOAL_LOCK/pid" ]; then
            local owner; owner=$(cat "$GOAL_LOCK/pid" 2>/dev/null || echo "")
            if [ -n "$owner" ] && ! kill -0 "$owner" 2>/dev/null; then
                local dead="${GOAL_LOCK}.dead.$$.$(date +%s 2>/dev/null || echo 0)"
                if mv "$GOAL_LOCK" "$dead" 2>/dev/null; then
                    rm -rf "$dead" 2>/dev/null
                fi
                continue
            fi
        fi
        elapsed=$(( $(date +%s 2>/dev/null || echo 0) - started ))
        [ "$elapsed" -ge 5 ] && return 1
        sleep 0.1 2>/dev/null || sleep 1
    done
}
lock_release() { rm -rf "$GOAL_LOCK" 2>/dev/null || true; }

if ! lock_acquire; then
    log_event "lock-timeout" "could not acquire goal lock"
    exit 0
fi
trap 'lock_release' EXIT INT TERM

NOW=$(date -u +%FT%TZ)
TMP=$(mktemp "$GOAL_DIR/goals/.t.XXXXXX" 2>/dev/null) || {
    log_event "mktemp-failed" "could not create temp"
    exit 0
}
if jq --arg ts "$NOW" --arg r "$reason" --arg gid "${GOAL_ID:-}" \
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
    mv "$TMP" "$GOAL_FILE" 2>/dev/null || rm -f "$TMP" 2>/dev/null
else
    rm -f "$TMP" 2>/dev/null
fi

log_event "auto-pause-error" "$reason"
lock_release
trap - EXIT INT TERM
