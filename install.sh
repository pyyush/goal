#!/usr/bin/env bash
# install.sh — install /goal command + hooks for Claude Code.
#
# Usage:
#   ./install.sh              # interactive — prompts for scope
#   ./install.sh user         # install to ~/.claude/ (applies to all projects)
#   ./install.sh project      # install to ./.claude/ (current directory only)
#
# Requires: bash 3.2+, jq.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"

# ---- args / prompt ---------------------------------------------------------

case "${1:-}" in
    user)    SCOPE=user ;;
    project) SCOPE=project ;;
    -h|--help)
        sed -n '2,9p' "$0" | sed 's/^# \?//'
        exit 0
        ;;
    "")
        printf 'Install scope?\n'
        printf '  1) user (~/.claude/ — applies to every project) [default]\n'
        printf '  2) project (./.claude/ — this directory only)\n'
        printf 'Choice [1]: '
        read -r choice
        case "${choice:-1}" in
            1) SCOPE=user ;;
            2) SCOPE=project ;;
            *) printf 'invalid choice\n' >&2; exit 1 ;;
        esac
        ;;
    *)  printf 'usage: ./install.sh [user|project]\n' >&2; exit 1 ;;
esac

# ---- prereqs ---------------------------------------------------------------

if ! command -v jq >/dev/null 2>&1; then
    printf 'error: jq is required. Install with: brew install jq (macOS) or apt-get install jq (Linux)\n' >&2
    exit 1
fi

if ! command -v bash >/dev/null 2>&1; then
    printf 'error: bash is required\n' >&2
    exit 1
fi

# ---- target paths ----------------------------------------------------------

case "$SCOPE" in
    user)
        TARGET="$HOME/.claude"
        HOOK_CMD_PREFIX="bash \$HOME/.claude/hooks/"
        ;;
    project)
        TARGET="./.claude"
        HOOK_CMD_PREFIX="bash .claude/hooks/"
        ;;
esac

# ---- copy files ------------------------------------------------------------

mkdir -p "$TARGET/commands" "$TARGET/hooks"
cp "$REPO_DIR/goal.md" "$TARGET/commands/goal.md"
cp "$REPO_DIR/hooks/"*.sh "$TARGET/hooks/"
chmod +x "$TARGET/hooks/"*.sh
printf 'Installed command + 4 hooks to %s/\n' "$TARGET"

# ---- settings.json merge ---------------------------------------------------

SETTINGS="$TARGET/settings.json"

if [ ! -f "$SETTINGS" ]; then
    if [ "$SCOPE" = user ]; then
        sed 's|bash .claude/hooks/|bash $HOME/.claude/hooks/|g' "$REPO_DIR/settings.json.example" > "$SETTINGS"
    else
        cp "$REPO_DIR/settings.json.example" "$SETTINGS"
    fi
    printf 'Created %s with hook registrations.\n' "$SETTINGS"
else
    TMP=$(mktemp)
    jq --arg p "$HOOK_CMD_PREFIX" '
        .hooks //= {}
        | .hooks.Stop //= []
        | .hooks.Notification //= []
        | .hooks.UserPromptSubmit //= []
        | (.hooks.Stop |=
            if any(.[]?; .hooks[0].command == ($p + "goal-stop.sh"))
            then . else . + [{hooks: [{type: "command", command: ($p + "goal-stop.sh")}]}] end)
        | (.hooks.Notification |=
            if any(.[]?; .hooks[0].command == ($p + "goal-notify.sh"))
            then . else . + [{hooks: [{type: "command", command: ($p + "goal-notify.sh")}]}] end)
        | (.hooks.UserPromptSubmit |=
            if any(.[]?; .hooks[0].command == ($p + "goal-prompt.sh"))
            then . else . + [{hooks: [{type: "command", command: ($p + "goal-prompt.sh")}]}] end)
    ' "$SETTINGS" > "$TMP"

    if diff -q "$SETTINGS" "$TMP" >/dev/null 2>&1; then
        printf 'Hooks already registered in %s — nothing to merge.\n' "$SETTINGS"
        rm "$TMP"
    else
        printf '\nProposed changes to %s:\n' "$SETTINGS"
        # diff exits 1 when there are differences — don't let pipefail kill us.
        { diff -u "$SETTINGS" "$TMP" || true; } | sed 's/^/  /'
        printf '\nApply? [y/N]: '
        read -r ok || ok=""
        case "${ok:-N}" in
            y|Y|yes|YES)
                BACKUP="$SETTINGS.bak.$(date +%s)"
                cp "$SETTINGS" "$BACKUP"
                mv "$TMP" "$SETTINGS"
                printf 'Merged. Backup at %s\n' "$BACKUP"
                ;;
            *)
                rm "$TMP"
                printf 'Skipped. Re-run install.sh or merge settings.json.example manually.\n'
                ;;
        esac
    fi
fi

# ---- project-scope .gitignore ----------------------------------------------

if [ "$SCOPE" = project ] && [ -d .git ]; then
    for pat in '.claude/goal.json' '.claude/goal-hook.log' '.claude/goal.pause'; do
        if [ ! -f .gitignore ] || ! grep -qxF "$pat" .gitignore 2>/dev/null; then
            printf '%s\n' "$pat" >> .gitignore
            printf 'Added %s to .gitignore\n' "$pat"
        fi
    done
fi

# ---- final notes -----------------------------------------------------------

cat <<'NOTE'

Install complete. Restart Claude Code (CLI or desktop) to pick up the hooks.

Try it:
  /goal Refactor the auth module to use the new session API; run tests
  /goal status
  /goal pause | resume | clear

Optional — add a goal segment to your status line by appending to your
existing statusLine command (~/.claude/statusline-command.sh):

  if [ -x "$HOME/.claude/hooks/goal-statusline.sh" ]; then
    goal_seg=$(bash "$HOME/.claude/hooks/goal-statusline.sh" "$cwd" 2>/dev/null)
    [ -n "$goal_seg" ] && segments+=("$goal_seg")
  fi

See README.md for configuration (GOAL_MAX_TICKS, GOAL_AUTOPAUSE_ON_PROMPT,
etc.) and the threat model.
NOTE
