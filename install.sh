#!/usr/bin/env bash
# install.sh — install /goal command + hooks for Claude Code.
#
# NOTE: For a richer interactive install that also builds the MCP server and
# patches ~/.claude.json, run `bin/goal-setup` instead. This script still works
# for minimal hooks-only setups, and is kept for backwards compatibility.
#
# Usage:
#   ./install.sh              # interactive — prompts for scope
#   ./install.sh user         # install to ~/.claude/ (applies to all projects)
#   ./install.sh project      # install to ./.claude/ (current directory only)
#
# Requires: bash 3.2+, jq.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"

# ---- offer the richer wizard, if available --------------------------------

if [ -x "$REPO_DIR/bin/goal-setup" ] && [ -t 0 ] && [ -t 1 ] && [ "${GOAL_SETUP_NOPROMPT:-0}" != 1 ]; then
    printf 'A richer interactive installer is available: bin/goal-setup\n'
    printf 'It builds the MCP server and patches ~/.claude.json in one step.\n'
    printf 'Delegate to bin/goal-setup? [Y/n] '
    read -r __ans || __ans=""
    case "${__ans:-Y}" in
        y|Y|yes|YES|"")
            exec "$REPO_DIR/bin/goal-setup" "$@"
            ;;
        *)
            printf 'Continuing with the minimal install.sh flow.\n'
            ;;
    esac
fi

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

mkdir -p "$TARGET/commands" "$TARGET/hooks" "$HOME/.claude/goal-sessions"
cp "$REPO_DIR/goal.md" "$TARGET/commands/goal.md"
cp "$REPO_DIR/hooks/"*.sh "$TARGET/hooks/"
chmod +x "$TARGET/hooks/"*.sh
mkdir -p "$TARGET/bin"
cp "$REPO_DIR/bin/goal-statusline-install" "$TARGET/bin/goal-statusline-install"
chmod +x "$TARGET/bin/goal-statusline-install"
printf 'Installed command + hook files to %s/\n' "$TARGET"

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

# ---- statusline setup ------------------------------------------------------
# Additive wiring: install a wrapper that runs whatever status line you already
# have and appends the /goal cockpit line below it. Your status line is never
# replaced — only the statusLine.command pointer is re-pointed, and the old
# value is preserved as the wrapper's inner command. The installer also adds a
# SessionStart hook so the goal line survives a future /statusline.

printf '\n--- Statusline setup ---\n'
if [ -x "$TARGET/bin/goal-statusline-install" ]; then
    SL_FLAG=--user
    [ "$SCOPE" = project ] && SL_FLAG=--project
    bash "$TARGET/bin/goal-statusline-install" --audit "$SL_FLAG" 2>/dev/null | sed 's/^/  /'
    printf '\nWire the goal cockpit into your status line? It is additive — your\n'
    printf 'existing status line is preserved (run with --audit any time). [Y/n] '
    read -r __sl || __sl=""
    case "${__sl:-Y}" in
        y|Y|yes|YES|"")
            bash "$TARGET/bin/goal-statusline-install" "$SL_FLAG" || true ;;
        *)
            printf 'Skipped. Run "%s/bin/goal-statusline-install" whenever you want it.\n' "$TARGET" ;;
    esac
else
    printf 'goal-statusline-install missing — skipping status line setup.\n'
fi

# ---- project-scope .gitignore ----------------------------------------------

if [ "$SCOPE" = project ] && [ -d .git ]; then
    for pat in '.goal/' '.claude/goal.json' '.claude/goal-hook.log' '.claude/goal.pause' '.claude/goal-baseline-*' '.claude/MIGRATED_TO_GOAL'; do
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
  /goal:goal status
  /goal:goal pause | resume | clear

See README.md for configuration (GOAL_AUTOPAUSE_ON_PROMPT, GOAL_STRIKE_LIMIT,
GOAL_RELAY_LIMIT_PER_HOUR, etc.) and the threat model.
NOTE
