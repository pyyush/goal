#!/usr/bin/env bash
# .claude/hooks/goal-prompt.sh
#
# UserPromptSubmit hook for /goal — auto-pauses an active goal when the user
# submits a non-/goal prompt. Mirrors the spirit of Codex's pause-on-interrupt
# behavior: your input takes priority over the loop, and the goal is paused
# (not abandoned) so you can resume it explicitly.
#
# Optional. Skip this hook if you prefer your input to be treated as
# refinement during pursuit rather than an interrupt.
#
# Requires: bash 3.2+, jq.

set -euo pipefail

GOAL_FILE=".claude/goal.json"
LOG_FILE=".claude/goal-hook.log"

log() {
    [ -d .claude ] || return 0
    {
        printf '{"ts":"%s","pid":%d,"hook":"prompt","event":"%s","note":%s}\n' \
            "$(date -u +%FT%TZ)" "$$" "$1" \
            "$(printf '%s' "${2:-}" | jq -Rs . 2>/dev/null || printf '""')"
    } >> "$LOG_FILE" 2>/dev/null || true
}

write_pause() {
    local now tmp
    now=$(date -u +%FT%TZ)
    [ -d .claude ] || return 0
    tmp=$(mktemp ".claude/goal.json.XXXXXX") || return 0
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

# Refuse to follow symlinks.
[ -L "$GOAL_FILE" ] && exit 0

[ -f "$GOAL_FILE" ] || exit 0

STATUS=$(jq -r '.status // ""' "$GOAL_FILE" 2>/dev/null) || STATUS=""
[ "$STATUS" = "pursuing" ] || exit 0

PROMPT=$(printf '%s' "$INPUT" | jq -r '.prompt // ""' 2>/dev/null) || PROMPT=""

# Trim leading/trailing whitespace.
PROMPT_TRIMMED=$(printf '%s' "$PROMPT" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')

# Skip on empty/whitespace-only prompt — don't auto-pause spurious submits.
[ -z "$PROMPT_TRIMMED" ] && exit 0

# Don't auto-pause when user is invoking /goal itself — that's intentional
# lifecycle control. Match exactly `/goal` or `/goal <args>`, not `/goalish`.
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
