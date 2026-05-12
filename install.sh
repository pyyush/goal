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
cp "$REPO_DIR/bin/goal-ticker" "$TARGET/bin/goal-ticker"
chmod +x "$TARGET/bin/goal-ticker"
printf 'Installed command + hook files + goal-ticker to %s/\n' "$TARGET"

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
        | .hooks.SessionStart //= []
        | .hooks.PreToolUse //= []
        | .hooks.Stop //= []
        | .hooks.Notification //= []
        | .hooks.UserPromptSubmit //= []
        | (.hooks.SessionStart |=
            if any(.[]?; .hooks[0].command == ($p + "goal-ticker.sh"))
            then . else . + [{hooks: [{type: "command", command: ($p + "goal-ticker.sh")}]}] end)
        | (.hooks.PreToolUse |=
            if any(.[]?; (.matcher // "") == "Task" and .hooks[0].command == ($p + "goal-ticker.sh"))
            then . else . + [{matcher: "Task", hooks: [{type: "command", command: ($p + "goal-ticker.sh")}]}] end)
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
#
# Three cases:
#   A) No statusLine configured  → offer to install bundled statusline
#   B) Existing script-based statusLine → keep / append goal segment / replace / diff
#   C) Existing inline-command statusLine → keep / replace only (no script to patch)

STATUSLINE_SRC="$REPO_DIR/statusline.sh"
case "$SCOPE" in
    user)    STATUSLINE_DST="$HOME/.claude/statusline.sh"
             STATUSLINE_CMD='bash $HOME/.claude/statusline.sh' ;;
    project) STATUSLINE_DST="./.claude/statusline.sh"
             STATUSLINE_CMD='bash .claude/statusline.sh' ;;
esac

read -r -d '' GOAL_SNIPPET <<'SNIP' || true

# --- goal segment (added by the goal plugin) ---
if [ -x "$HOME/.claude/hooks/goal-statusline.sh" ]; then
    __goal_seg=$(printf '%s' "${input:-}" | bash "$HOME/.claude/hooks/goal-statusline.sh" "${cwd:-}" "${sid:-}" 2>/dev/null || true)
    [ -n "$__goal_seg" ] && printf ' | %s' "$__goal_seg"
fi
SNIP

install_bundled_statusline() {
    cp "$STATUSLINE_SRC" "$STATUSLINE_DST"
    chmod +x "$STATUSLINE_DST"
    local TMP
    TMP=$(mktemp)
    jq --arg cmd "$STATUSLINE_CMD" '.statusLine = {type: "command", command: $cmd}' "$SETTINGS" > "$TMP"
    mv "$TMP" "$SETTINGS"
    printf 'Installed bundled statusline at %s and wired it in settings.json.\n' "$STATUSLINE_DST"
}

EXISTING_STATUSLINE=""
if [ -f "$SETTINGS" ]; then
    EXISTING_STATUSLINE=$(jq -r '.statusLine.command // empty' "$SETTINGS" 2>/dev/null)
fi

printf '\n--- Statusline setup ---\n'

if [ -z "$EXISTING_STATUSLINE" ]; then
    cat <<EOF
No statusLine is currently configured.

The bundled statusline shows:
  model | cwd | context% | rate-limits (Pro/Max) | goal (when active)

Options:
  [Y] install the bundled statusline
  [n] skip — don't touch statusline (goal segment won't render)
  [l] skip for now; print the goal-segment snippet so I can add it later
EOF
    printf 'Choice [Y/n/l]: '
    read -r choice || choice=""
    case "${choice:-Y}" in
        y|Y|yes|YES|"")  install_bundled_statusline ;;
        l|L)             printf '\nPaste this near the end of your future statusline script:\n%s\n' "$GOAL_SNIPPET" ;;
        *)               printf 'Skipped statusline setup.\n' ;;
    esac
else
    EXISTING_SCRIPT=""
    candidate=$(printf '%s' "$EXISTING_STATUSLINE" | sed "s|\$HOME|$HOME|g; s|~|$HOME|g" | awk '{for (i=1;i<=NF;i++) if ($i ~ /\.sh$/) { print $i; exit }}')
    if [ -n "$candidate" ] && [ -f "$candidate" ]; then
        EXISTING_SCRIPT="$candidate"
    fi

    printf 'Detected existing statusLine:\n  %s\n' "$EXISTING_STATUSLINE"
    [ -n "$EXISTING_SCRIPT" ] && printf '  (script: %s)\n' "$EXISTING_SCRIPT"
    printf '\nOptions:\n'
    printf '  [k] keep yours as-is (recommended if customized)\n'
    [ -n "$EXISTING_SCRIPT" ] && printf '  [a] append goal segment to your script (non-destructive)\n'
    printf '  [r] replace with the bundled statusline (backs yours up)\n'
    printf '  [s] show diff between yours and the bundled one\n'

    while :; do
        printf 'Choice [k]: '
        read -r choice || choice=""
        case "${choice:-k}" in
            k|K|"")
                printf 'Kept your statusline unchanged.\n'
                break ;;
            a|A)
                if [ -z "$EXISTING_SCRIPT" ]; then
                    printf 'No script file to patch — your statusLine uses an inline command.\nSnippet to paste manually:\n%s\n' "$GOAL_SNIPPET"
                    break
                fi
                if grep -q 'goal-statusline.sh' "$EXISTING_SCRIPT" 2>/dev/null; then
                    printf 'Goal segment already present in %s — nothing to append.\n' "$EXISTING_SCRIPT"
                    break
                fi
                printf '\nWill append this to %s:\n%s\n\nProceed? [y/N]: ' "$EXISTING_SCRIPT" "$GOAL_SNIPPET"
                read -r ok || ok=""
                case "${ok:-N}" in
                    y|Y|yes|YES)
                        BACKUP="$EXISTING_SCRIPT.bak.$(date +%s)"
                        cp "$EXISTING_SCRIPT" "$BACKUP"
                        printf '%s\n' "$GOAL_SNIPPET" >> "$EXISTING_SCRIPT"
                        printf 'Appended. Backup at %s\n' "$BACKUP" ;;
                    *)  printf 'Skipped — no changes made.\n' ;;
                esac
                break ;;
            r|R)
                if [ -n "$EXISTING_SCRIPT" ]; then
                    BACKUP="$EXISTING_SCRIPT.bak.$(date +%s)"
                    cp "$EXISTING_SCRIPT" "$BACKUP"
                    printf 'Backed up existing script to %s\n' "$BACKUP"
                fi
                install_bundled_statusline
                break ;;
            s|S)
                if [ -n "$EXISTING_SCRIPT" ]; then
                    printf '\n--- diff (yours → bundled) ---\n'
                    { diff -u "$EXISTING_SCRIPT" "$STATUSLINE_SRC" || true; } | sed 's/^/  /'
                else
                    printf '\nYour statusLine is an inline command; no script to diff.\nBundled statusline preview:\n'
                    sed 's/^/  /' "$STATUSLINE_SRC" | head -40
                fi
                continue ;;
            *)
                printf 'Invalid choice.\n'
                continue ;;
        esac
    done
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
  /goal status
  /goal pause | resume | clear

See README.md for configuration (GOAL_MAX_TICKS, GOAL_AUTOPAUSE_ON_PROMPT,
etc.) and the threat model.
NOTE
