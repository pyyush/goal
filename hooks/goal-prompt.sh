#!/usr/bin/env bash
# .claude/hooks/goal-prompt.sh
#
# UserPromptSubmit hook for /goal — opt-in auto-pause.
#
# Subscription-first default: this hook does NOTHING unless you opt in.
# Set GOAL_AUTOPAUSE_ON_PROMPT=1 to restore Codex-style pause-on-input.
#
# Resolves goal state via goal-resolve.sh: session pointer first, then
# walk-up from $cwd. Requires bash 3.2+, jq.

set -euo pipefail

[ "${GOAL_AUTOPAUSE_ON_PROMPT:-0}" = "1" ] || exit 0

RESOLVER="$(dirname "$0")/goal-resolve.sh"
[ -f "$RESOLVER" ] || exit 0
# shellcheck disable=SC1090
. "$RESOLVER"

INPUT=$(cat || printf '')
INPUT=${INPUT:-\{\}}

SESSION_ID=$(printf '%s' "$INPUT" | jq -r '.session_id // ""' 2>/dev/null)
SESSION_CWD=$(printf '%s' "$INPUT" | jq -r '.cwd // ""' 2>/dev/null)

resolve_goal "$SESSION_ID" "${SESSION_CWD:-$PWD}" || exit 0

log() {
    {
        printf '{"ts":"%s","pid":%d,"hook":"prompt","session":%s,"event":"%s","note":%s}\n' \
            "$(date -u +%FT%TZ)" "$$" \
            "$(printf '%s' "$SESSION_ID" | jq -Rs . 2>/dev/null || printf '""')" \
            "$1" \
            "$(printf '%s' "${2:-}" | jq -Rs . 2>/dev/null || printf '""')"
    } >> "$LOG_FILE" 2>/dev/null || true
}

write_pause() {
    local now tmp gid
    now=$(date -u +%FT%TZ)
    gid=$(jq -r '.goal_id // ""' "$GOAL_FILE" 2>/dev/null) || gid=""
    tmp=$(mktemp "$GOAL_ROOT/.claude/goal.json.XXXXXX") || return 0
    if jq --arg ts "$now" --arg gid "$gid" \
         'if (.goal_id // "") == $gid then
              .status = "paused"
              | .updated_at = $ts
              | .history = ((.history // []) + [{ts: $ts, action: "auto-pause", note: "user submitted new prompt"}])
          else . end' \
         "$GOAL_FILE" > "$tmp" 2>/dev/null; then
        mv "$tmp" "$GOAL_FILE"
    else
        rm -f "$tmp"
    fi
}

STATUS=$(jq -r '.status // ""' "$GOAL_FILE" 2>/dev/null) || STATUS=""
[ "$STATUS" = "pursuing" ] || exit 0

PROMPT=$(printf '%s' "$INPUT" | jq -r '.prompt // ""' 2>/dev/null) || PROMPT=""
PROMPT_TRIMMED=$(printf '%s' "$PROMPT" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')
[ -z "$PROMPT_TRIMMED" ] && exit 0

case "$PROMPT_TRIMMED" in
    /goal) exit 0 ;;
    /goal[[:space:]]*) exit 0 ;;
esac

write_pause
log "auto-pause" "user prompt submitted"

jq -n '{
  hookSpecificOutput: {
    hookEventName: "UserPromptSubmit",
    additionalContext: "[goal auto-paused due to user input — run /goal resume to continue pursuing]"
  }
}'
