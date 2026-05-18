#!/usr/bin/env bash
# Regression coverage for the shell preambles embedded in goal.md.
#
# The slash command is evaluated by the user's interactive shell. On zsh, a bare
# unmatched *.json glob aborts before /goal can create or bind a goal. This test
# runs the actual embedded snippets under zsh so that failure mode stays fixed.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
GOAL_MD="$ROOT/goal.md"

green() { printf '\033[32m%s\033[0m\n' "$*"; }
red() { printf '\033[31m%s\033[0m\n' "$*"; }
fail() { red "FAIL [goal-md-preamble]: $*"; exit 1; }

if ! command -v zsh >/dev/null 2>&1; then
    printf 'SKIP [goal-md-preamble]: zsh not installed\n'
    exit 0
fi

extract_bang() {
    local prefix="$1"
    awk -v prefix="$prefix" '
        index($0, prefix) == 1 {
            line = $0
            sub(/^!`/, "", line)
            sub(/`$/, "", line)
            print line
            found = 1
            exit
        }
        END { if (!found) exit 1 }
    ' "$GOAL_MD"
}

DISCOVERY_CMD=$(extract_bang '!`d=')
SESSION_CMD=$(extract_bang '!`sid=')

TMP=$(mktemp -d -t goal-md-preamble-XXXXXX)
trap 'rm -rf "$TMP"' EXIT

PROJECT="$TMP/workspace"
HOME_DIR="$TMP/home"
mkdir -p "$PROJECT/.goal/goals" "$HOME_DIR/.claude/projects"

DISCOVERY_ERR="$TMP/discovery.err"
DISCOVERY_OUT=$(HOME="$HOME_DIR" zsh -fc "cd '$PROJECT'; $DISCOVERY_CMD" 2>"$DISCOVERY_ERR") || {
    cat "$DISCOVERY_ERR" >&2
    fail "current-goal discovery command failed under zsh"
}

if grep -q 'no matches found' "$DISCOVERY_ERR"; then
    cat "$DISCOVERY_ERR" >&2
    fail "current-goal discovery still expands an empty *.json glob"
fi
printf '%s\n' "$DISCOVERY_OUT" | grep -qx "GOAL_ROOT=$PROJECT" ||
    fail "current-goal discovery did not find the empty v3 goal root"

SLUG=$(printf '%s' "$PROJECT" | tr '/' '-')
TRANSCRIPTS="$HOME_DIR/.claude/projects/$SLUG"
mkdir -p "$TRANSCRIPTS"
: > "$TRANSCRIPTS/old-session.jsonl"
sleep 1
: > "$TRANSCRIPTS/current-session.jsonl"

SESSION_OUT=$(HOME="$HOME_DIR" CLAUDE_CODE_SESSION_ID= CLAUDE_SESSION_ID= GOAL_SESSION_ID= zsh -fc "cd '$PROJECT'; $SESSION_CMD") ||
    fail "session discovery command failed under zsh"
[ "$SESSION_OUT" = "SESSION_ID=current-session" ] ||
    fail "session discovery should infer newest transcript id, got: $SESSION_OUT"

SESSION_ENV_OUT=$(HOME="$HOME_DIR" CLAUDE_CODE_SESSION_ID=env-session CLAUDE_SESSION_ID= GOAL_SESSION_ID= zsh -fc "cd '$PROJECT'; $SESSION_CMD") ||
    fail "session discovery command failed with env session id"
[ "$SESSION_ENV_OUT" = "SESSION_ID=env-session" ] ||
    fail "environment session id should win over transcript inference, got: $SESSION_ENV_OUT"

green "ALL GOAL.MD PREAMBLE CHECKS PASSED"
