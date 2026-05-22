#!/usr/bin/env bash
# hooks/goal-prompt.sh — v3 UserPromptSubmit hook for /goal.
#
# Two behaviors, in this order:
#
#   1. AUTO-RESUME / STRIKE-RESET (default ON; opt-out via
#      GOAL_AUTORESUME_ON_PROMPT=0). A user prompt is fresh input — if the
#      dispatcher had parked the goal at `needs-input`, the user submitting
#      anything that isn't a `/goal …` meta-command means the block is cleared,
#      so we flip back to `pursuing`. Independently, any `idle_strikes` count
#      from the prior turn is reset to 0 so the next Stop's progress check
#      starts fresh. Without this, a legitimate "stop and wait for the user"
#      turn parks the goal and the next user reply does not un-park it.
#
#   2. AUTO-PAUSE (default OFF; opt-in via GOAL_AUTOPAUSE_ON_PROMPT=1). When
#      enabled, a user prompt that isn't `/goal …` pauses the active goal so
#      the user's new request runs uncontested. They re-arm with
#      `/goal:goal resume`.
#
# Both behaviors share the `/goal …` skip — meta-commands handle status
# themselves and must not be second-guessed here.
#
# v3 changes vs the v2 version that shipped (broken) with the session-scoped
# merge:
#   - Resolves via `goal_resolve_owned` (the v2 `resolve_goal` symbol no longer
#     exists; the v2 hook was silently aborting on `set -e`).
#   - Per-goal mkdir mutex at $GOAL_LOCK (.goal/locks/<gid>.lock), mirroring
#     the Stop hook. No dependency on the deleted goal-lock.sh.
#   - `set -u` only (no `-e`/`pipefail`), matching the v3 hook hardening.

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
[ -n "$STATUS" ] || exit 0

# Trim the prompt; treat empty as nothing to do for either behavior.
PROMPT=$(printf '%s' "$INPUT" | jq -r '.prompt // ""' 2>/dev/null) || PROMPT=""
PROMPT_TRIMMED=$(printf '%s' "$PROMPT" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')
[ -z "$PROMPT_TRIMMED" ] && exit 0

# Meta-command guard: /goal … and /goal:goal … manage status themselves and
# must not be auto-resumed or auto-paused.
case "$PROMPT_TRIMMED" in
    /goal|/goal[[:space:]]*|/goal:goal|/goal:goal[[:space:]]*) exit 0 ;;
esac

# ---- helpers shared by both behaviors --------------------------------------

log_event() {
    [ -n "${EVENTS_FILE:-}" ] || return 0
    {
        printf '{"ts":"%s","src":"prompt","session":%s,"goal":"%s","event":"%s","note":%s}\n' \
            "$(date -u +%FT%TZ)" \
            "$(printf '%s' "$SESSION_ID" | jq -Rs . 2>/dev/null || printf '""')" \
            "${GOAL_ID:-}" "$1" \
            "$(printf '%s' "${2:-}" | jq -Rs . 2>/dev/null || printf '""')"
    } >> "$EVENTS_FILE" 2>/dev/null || true
}

# Per-goal mkdir mutex — mirrors goal-stop.sh:lock_acquire/release. We can't
# source the Stop hook from here (it self-executes), so we duplicate the few
# lines. Both writers serialize on the same .goal/locks/<gid>.lock path.
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

# ---- behavior 1: AUTO-RESUME / STRIKE-RESET (default ON) --------------------
#
# Triggers when:
#   * status == needs-input  → flip to pursuing (the user just unblocked us), OR
#   * idle_strikes > 0       → reset to 0 (next Stop progress check starts fresh)
# Skips terminal statuses (achieved, budget-limited) and `paused` (user-owned).

case "${GOAL_AUTORESUME_ON_PROMPT:-1}" in
    0|false|FALSE|no|NO|off|OFF) AUTORESUME=0 ;;
    *)                            AUTORESUME=1 ;;
esac

if [ "$AUTORESUME" -eq 1 ]; then
    IDLE_STRIKES=$(jq -r '.idle_strikes // 0' "$GOAL_FILE" 2>/dev/null) || IDLE_STRIKES=0
    case "$IDLE_STRIKES" in ''|*[!0-9]*) IDLE_STRIKES=0 ;; esac

    NEEDS_RESUME=0
    NEEDS_STRIKE_RESET=0
    [ "$STATUS" = "needs-input" ] && NEEDS_RESUME=1
    [ "$IDLE_STRIKES" -gt 0 ]      && NEEDS_STRIKE_RESET=1

    if [ "$NEEDS_RESUME" -eq 1 ] || [ "$NEEDS_STRIKE_RESET" -eq 1 ]; then
        if lock_acquire; then
            trap 'lock_release' EXIT INT TERM
            NOW=$(date -u +%FT%TZ)
            TMP=$(mktemp "$GOAL_DIR/goals/.t.XXXXXX" 2>/dev/null) || TMP=""
            if [ -n "$TMP" ]; then
                if jq --arg ts "$NOW" --arg gid "${GOAL_ID:-}" --argjson resume "$NEEDS_RESUME" \
                     'if (.goal_id // "") == $gid then
                          .idle_strikes = 0
                          | .updated_at = $ts
                          | (if $resume == 1 then
                                .status = "pursuing"
                                | .pursuing_since = $ts
                                | .history = ((.history // []) + [{ts:$ts, action:"auto-resume",
                                    note:"user submitted new prompt; status was needs-input"}])
                              else
                                .history = ((.history // []) + [{ts:$ts, action:"strike-reset",
                                    note:"user submitted new prompt; idle_strikes reset"}])
                              end)
                      else . end' \
                     "$GOAL_FILE" > "$TMP" 2>/dev/null; then
                    mv "$TMP" "$GOAL_FILE" 2>/dev/null || rm -f "$TMP" 2>/dev/null
                    if [ "$NEEDS_RESUME" -eq 1 ]; then
                        log_event "auto-resume" "needs-input -> pursuing"
                        STATUS="pursuing"
                    else
                        log_event "strike-reset" "idle_strikes reset to 0"
                    fi
                    AUTORESUME_FIRED=1
                else
                    rm -f "$TMP" 2>/dev/null
                    AUTORESUME_FIRED=0
                fi
            else
                AUTORESUME_FIRED=0
            fi
            lock_release
            trap - EXIT INT TERM
        else
            log_event "lock-timeout" "auto-resume could not acquire goal lock"
            AUTORESUME_FIRED=0
        fi
    else
        AUTORESUME_FIRED=0
    fi
else
    AUTORESUME_FIRED=0
fi

# Emit a visible nudge if we just auto-resumed from needs-input, so the model
# sees the status flip on this very turn (not next).
if [ "${AUTORESUME_FIRED:-0}" = "1" ] && [ "${NEEDS_RESUME:-0}" = "1" ]; then
    jq -n '{
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: "[goal auto-resumed: needs-input -> pursuing because you submitted new input. If you meant to leave the goal parked, run /goal:goal pause or /goal:goal clear.]"
      }
    }'
fi

# ---- behavior 2: AUTO-PAUSE (default OFF, opt-in) ---------------------------

[ "${GOAL_AUTOPAUSE_ON_PROMPT:-0}" = "1" ] || exit 0

# Only auto-pause a pursuing goal (which we may have just resumed above).
[ "$STATUS" = "pursuing" ] || exit 0

log_event() {
    [ -n "${EVENTS_FILE:-}" ] || return 0
    {
        printf '{"ts":"%s","src":"prompt","session":%s,"goal":"%s","event":"%s","note":%s}\n' \
            "$(date -u +%FT%TZ)" \
            "$(printf '%s' "$SESSION_ID" | jq -Rs . 2>/dev/null || printf '""')" \
            "${GOAL_ID:-}" "$1" \
            "$(printf '%s' "${2:-}" | jq -Rs . 2>/dev/null || printf '""')"
    } >> "$EVENTS_FILE" 2>/dev/null || true
}

# Per-goal mkdir mutex — mirrors goal-stop.sh:lock_acquire/release. We can't
# source the Stop hook from here (it self-executes), so we duplicate the few
# lines. Both writers serialize on the same .goal/locks/<gid>.lock path.
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
    log_event "mktemp-failed" "could not create temp for state update"
    exit 0
}

# Accumulate pursuit time from pursuing_since (with legacy fallback to created_at)
# before clearing it, so a future resume measures cleanly.
if jq --arg ts "$NOW" --arg gid "${GOAL_ID:-}" \
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
          | .history = ((.history // []) + [{ts: $ts, action: "auto-pause", note: "user submitted new prompt"}])
      else . end' \
     "$GOAL_FILE" > "$TMP" 2>/dev/null; then
    mv "$TMP" "$GOAL_FILE" 2>/dev/null || rm -f "$TMP" 2>/dev/null
else
    rm -f "$TMP" 2>/dev/null
fi

log_event "auto-pause" "user prompt submitted"
lock_release
trap - EXIT INT TERM

jq -n '{
  hookSpecificOutput: {
    hookEventName: "UserPromptSubmit",
    additionalContext: "[goal auto-paused due to user input — run /goal:goal resume to continue pursuing]"
  }
}'
