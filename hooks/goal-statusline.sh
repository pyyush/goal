#!/usr/bin/env bash
# hooks/goal-statusline.sh — the /goal cockpit segment.
#
# Prints ONE compact, state-coloured status-line segment for the goal THIS
# session owns. Composed by a host statusLine script (see settings.json.example)
# alongside model/context/cost segments.
#
# Design (see docs/goal-statusline-cockpit.html):
#   * Session-OWNED — resolves via goal_resolve_owned, so a fresh shell in a
#     directory with old goals renders NOTHING. Structural fix for the bug
#     where every session inherited a stale "Goal achieved".
#   * State drives colour and glyph; the glyph is the at-a-glance signal:
#       ◎ pursuing (healthy)   teal     — making progress
#       ◍ pursuing (stalled)   amber    — no progress last turn, re-orienting
#       ◌ needs-input          orange   — parked; the user must act
#       ↔ relaying             violet   — peer agent is taking over
#       ⌛ queued              amber    — waiting for provider headroom
#       ✓ achieved             green    — done
#       ‖ paused               dim      — /goal resume to continue
#       ⊘ budget-limited       red      — token budget reached
#   * No `unmet` — the model can never reach a failed state (RFC §3.4).
#   * Pull-based: re-renders when Claude Code re-renders the status line. Pair
#     with `refreshInterval` in settings for a live timer — NOT a /dev/tty
#     daemon, which Claude Code hooks can no longer use (v2.1.139+).
#
# Usage:  goal-statusline.sh <cwd> <session_id>
# Output: one line on stdout, or nothing if this session owns no goal.
#
# Style override:  GOAL_STATUSLINE_STYLE = color (default) | plain
#
# Hardening: `set -u` ONLY. A status-line script must never abort or it renders
# blank — every command is guarded; worst case is an empty segment.
#
# Requires bash 3.2+, jq, awk.

set -u

RESOLVER="$(cd "$(dirname "$0")" 2>/dev/null && pwd)/goal-resolve.sh"
[ -f "$RESOLVER" ] || exit 0
# shellcheck disable=SC1090
. "$RESOLVER" 2>/dev/null || exit 0

goal_resolve_owned "${2:-}" "${1:-$PWD}" 2>/dev/null || exit 0
[ -n "${GOAL_FILE:-}" ] && [ -r "$GOAL_FILE" ] || exit 0

US=$'\x1f'
ROW=$(jq -r --arg s "$US" '
    (now | floor) as $now
    | (.spec.title // .objective // "" | gsub("[\t\r\n]"; " ")) as $title
    | (.audit.checklist // []) as $cl
    | (first($cl[]? | select((.status // "") != "passed" and (.status // "") != "confirmed")) // null) as $task
    | (if $task == null then ""
       else (($task.id // "task") + " " + ($task.predicate // "") | gsub("[\t\r\n]"; " ") | .[0:72])
       end) as $task_label
    | [ (.status // ""),
        ($title | .[0:72]),
        (.idle_strikes // 0 | tostring),
        (.tick_count // 0 | tostring),
        ((.tokens_used_final // .tokens_used // 0) | tostring),
        (([ $cl[] | select(.status == "passed" or .status == "confirmed") ] | length
          | tostring) + "/" + ($cl | length | tostring)),
        ( (.time_used_seconds // .pursuing_seconds // 0) as $base
          | ((try ((.observed_at // .updated_at) | fromdateiso8601) catch $now)) as $obs
          | (if ((.status // "") == "pursuing" or (.status // "") == "relaying")
               then ($base + (($now - $obs) | if . < 0 then 0 else . end))
               else (.time_used_seconds_final // $base) end)
          | floor | tostring ),
        ((.cost_usd_final // .cost_usd // 0) | tostring),
        $task_label,
        ((.history // [] | if length > 0 then .[-1].note // "" else "" end) | gsub("[\t\r\n]"; " ") | .[0:72]),
        ((.current.agent // .current.session // "") | tostring | .[0:48]),
        ((.queued_until // "") | tostring | .[0:32])
      ] | join($s)
' "$GOAL_FILE" 2>/dev/null) || exit 0
[ -n "$ROW" ] || exit 0

IFS=$US read -r STATUS TITLE STRIKES TICKS TOKENS CHECKS SECONDS COST TASK LAST_NOTE AGENT QUEUED_UNTIL <<EOF
$ROW
EOF

[ -n "${STATUS:-}" ] || exit 0
case "${STRIKES:-0}" in ''|*[!0-9]*) STRIKES=0 ;; esac
case "${TOKENS:-0}"  in ''|*[!0-9]*) TOKENS=0 ;; esac
case "${SECONDS:-0}" in ''|*[!0-9]*) SECONDS=0 ;; esac

fmt_time() {
    local s="${1:-0}"
    if   [ "$s" -lt 60 ];    then printf '%ds' "$s"
    elif [ "$s" -lt 3600 ];  then printf '%dm' $((s / 60))
    elif [ "$s" -lt 86400 ]; then
        if [ $(((s % 3600) / 60)) -gt 0 ]
            then printf '%dh %dm' $((s / 3600)) $(((s % 3600) / 60))
            else printf '%dh' $((s / 3600)); fi
    else printf '%dd %dh' $((s / 86400)) $(((s % 86400) / 3600)); fi
}
fmt_tokens() {
    awk -v n="${1:-0}" 'BEGIN {
        if      (n < 1000)    printf "%d", n;
        else if (n < 100000)  printf "%.1fK", n/1000;
        else if (n < 1000000) printf "%.0fK", n/1000;
        else                  printf "%.1fM", n/1000000;
    }'
}
# fmt_cost -- Claude Code's own per-turn costUSD, summed for this goal. Notional
# (API-equivalent) for subscription users -- prefixed with the approx sign to
# say so. Prints nothing when cost is zero/unknown, so callers append freely.
fmt_cost() {
    awk -v c="${1:-0}" 'BEGIN {
        c = c + 0;
        if (c <= 0) exit;
        if (c < 1) printf "≈$%.3f", c;
        else       printf "≈$%.2f", c;
    }'
}

GLYPH="" ; COLOR="" ; LABEL=""
case "$STATUS" in
    pursuing)
        if [ "$STRIKES" -gt 0 ]; then
            GLYPH="◍" ; COLOR=$'\033[33m'  ; LABEL="goal stalled"
        else
            GLYPH="◎" ; COLOR=$'\033[36m'  ; LABEL="goal"
        fi ;;
    relaying)
        GLYPH="↔" ; COLOR=$'\033[35m'  ; LABEL="relaying" ;;
    queued)
        GLYPH="⌛" ; COLOR=$'\033[33m'  ; LABEL="queued" ;;
    needs-input)
        GLYPH="◌" ; COLOR=$'\033[38;5;208m' ; LABEL="needs input" ;;
    achieved)
        GLYPH="✓" ; COLOR=$'\033[32m'  ; LABEL="goal achieved" ;;
    paused)
        GLYPH="‖" ; COLOR=$'\033[2m'   ; LABEL="goal paused" ;;
    budget-limited)
        GLYPH="⊘" ; COLOR=$'\033[31m'  ; LABEL="budget limit" ;;
    *)
        exit 0 ;;
esac

DOT=" · "
SEG=""
FOCUS="$TITLE"
[ -n "${TASK:-}" ] && FOCUS="$TASK"
case "$STATUS" in
    pursuing)
        if [ "$STRIKES" -gt 0 ]; then
            SEG="${GLYPH} ${LABEL}${DOT}${FOCUS}${DOT}$(fmt_time "$SECONDS")"
            [ -n "${LAST_NOTE:-}" ] && SEG="${SEG}${DOT}${LAST_NOTE}"
        else
            SEG="${GLYPH} ${TITLE}"
            [ -n "${TASK:-}" ] && SEG="${SEG}${DOT}${TASK}"
            case "$CHECKS" in 0/0|/) : ;; *) SEG="${SEG}${DOT}${CHECKS}" ;; esac
            SEG="${SEG}${DOT}$(fmt_time "$SECONDS")"
        fi ;;
    relaying)
        SEG="${GLYPH} ${LABEL}${DOT}${TITLE}"
        [ -n "${TASK:-}" ] && SEG="${SEG}${DOT}${TASK}"
        [ -n "${AGENT:-}" ] && SEG="${SEG}${DOT}${AGENT}" ;;
    queued)
        SEG="${GLYPH} ${LABEL}${DOT}${FOCUS}"
        [ -n "${QUEUED_UNTIL:-}" ] && SEG="${SEG}${DOT}retry ${QUEUED_UNTIL}" ;;
    needs-input)
        SEG="${GLYPH} ${LABEL}${DOT}${FOCUS}${DOT}$(fmt_time "$SECONDS")"
        [ -n "${LAST_NOTE:-}" ] && SEG="${SEG}${DOT}${LAST_NOTE}" ;;
    achieved)
        SEG="${GLYPH} ${LABEL}${DOT}${TITLE}${DOT}$(fmt_time "$SECONDS")"
        [ "$TOKENS" -gt 0 ] 2>/dev/null && SEG="${SEG}${DOT}$(fmt_tokens "$TOKENS")" ;;
    paused|budget-limited)
        SEG="${GLYPH} ${LABEL}${DOT}${TITLE}"
        [ -n "${TASK:-}" ] && SEG="${SEG}${DOT}${TASK}" ;;
esac

# Append the goal's notional cost to every state (when known and non-zero).
COSTSEG=$(fmt_cost "$COST")
[ -n "$COSTSEG" ] && SEG="${SEG}${DOT}${COSTSEG}"

if [ "${GOAL_STATUSLINE_STYLE:-color}" = "plain" ]; then
    printf '%s' "$SEG"
else
    printf '%s%s\033[0m' "$COLOR" "$SEG"
fi
