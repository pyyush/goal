#!/usr/bin/env bash
# .claude/hooks/goal-prompt.sh
#
# UserPromptSubmit hook for /goal — opt-in auto-pause.
#
# Subscription-first default: this hook does NOTHING unless you opt in.
# The goal keeps moving across user prompts; the model interleaves your
# input with goal continuation and the loop survives /clear and auto-
# compaction transparently.
#
# Opt in to Codex-style auto-pause-on-input by exporting:
#   export GOAL_AUTOPAUSE_ON_PROMPT=1
#
# Resolves goal state by walking up from $PWD. Requires bash 3.2+, jq.

set -euo pipefail

[ "${GOAL_AUTOPAUSE_ON_PROMPT:-0}" = "1" ] || exit 0

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

log() {
    {
        printf '{"ts":"%s","pid":%d,"hook":"prompt","event":"%s","note":%s}\n' \
            "$(date -u +%FT%TZ)" "$$" "$1" \
            "$(printf '%s' "${2:-}" | jq -Rs . 2>/dev/null || printf '""')"
    } >> "$LOG_FILE" 2>/dev/null || true
}

write_pause() {
    local now tmp
    now=$(date -u +%FT%TZ)
    tmp=$(mktemp "$GOAL_ROOT/.claude/goal.json.XXXXXX") || return 0
    if jq --arg ts "$now" \
         '.status = "paused"
          | .updated_at = $ts
          | .history = ((.history // []) + [{ts: $ts, action: "auto-pause", note: "user submitted new prompt"}])' \
         "$GOAL_FILE" > "$tmp" 2>/dev/null; then
        mv "$tmp" "$GOAL_FILE"
    else
        rm -f "$tmp"
    fi
}

INPUT=$(cat || printf '')
INPUT=${INPUT:-\{\}}

[ -L "$GOAL_FILE" ] && exit 0

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
