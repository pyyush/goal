#!/usr/bin/env bash
# .claude/hooks/goal-prompt.sh
#
# UserPromptSubmit hook: auto-pauses an active /goal when the user submits
# a new prompt. Matches Codex behavior — your input takes priority over the
# loop, and an interrupt pauses (rather than abandons) the goal.
#
# Optional. Skip this hook if you prefer your input to be treated as
# refinement during pursuit rather than an interrupt.
#
# Requires: bash, jq.

set -euo pipefail

INPUT=$(cat)

GOAL_FILE=".claude/goal.json"
[ -f "$GOAL_FILE" ] || exit 0

STATUS=$(jq -r '.status // ""' "$GOAL_FILE")
[ "$STATUS" = "pursuing" ] || exit 0

# Don't auto-pause when the user is invoking /goal itself — that's
# intentional control of the lifecycle.
PROMPT=$(echo "$INPUT" | jq -r '.prompt // .user_prompt // ""')
case "$PROMPT" in
    /goal*) exit 0 ;;
esac

NOW=$(date -u +%FT%TZ)
TMP=$(mktemp)
jq --arg ts "$NOW" \
   '.status = "paused"
    | .updated_at = $ts
    | .history += [{"ts": $ts, "action": "auto-pause", "note": "user submitted new prompt"}]' \
   "$GOAL_FILE" > "$TMP" && mv "$TMP" "$GOAL_FILE"

# Tell Claude what just happened so it doesn't pursue stale goal context.
jq -n '{
  hookSpecificOutput: {
    hookEventName: "UserPromptSubmit",
    additionalContext: "[goal auto-paused due to user input — run /goal resume to continue pursuing]"
  }
}'
