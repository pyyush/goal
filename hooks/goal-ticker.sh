#!/usr/bin/env bash
# Spawn the v3 goal-ticker daemon on SessionStart and PreToolUse[Task].

set -euo pipefail

INPUT=$(cat || printf '{}')
INPUT=${INPUT:-\{\}}
CWD=$(printf '%s' "$INPUT" | jq -r '.cwd // ""' 2>/dev/null || printf '')
[ -n "$CWD" ] || CWD="$PWD"

ROOT="$CWD"
while [ "$ROOT" != "/" ] && [ "$ROOT" != "$HOME" ] && [ -n "$ROOT" ]; do
    [ -f "$ROOT/.goal/state.json" ] && break
    ROOT=$(dirname "$ROOT")
done
[ -f "$ROOT/.goal/state.json" ] || exit 0

STATUS=$(jq -r '.status // ""' "$ROOT/.goal/state.json" 2>/dev/null || printf '')
[ "$STATUS" = "pursuing" ] || exit 0

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TICKER="$SCRIPT_DIR/bin/goal-ticker"
[ -x "$TICKER" ] || TICKER="$HOME/.claude/bin/goal-ticker"
[ -x "$TICKER" ] || exit 0

if [ -w /dev/tty ]; then
    nohup node "$TICKER" --root "$ROOT" >/dev/tty 2>/dev/null &
else
    nohup node "$TICKER" --root "$ROOT" >/dev/null 2>&1 &
fi
exit 0
