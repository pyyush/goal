#!/usr/bin/env bash
# statusline.sh — bundled statusLine script for Claude Code.
#
# Segments (separated by " | "):
#   model | cwd | context% | rate-limits (if present) | goal (if active)
#
# Reads JSON session data from stdin (see https://code.claude.com/docs/en/statusline).
# Designed to be installed at ~/.claude/statusline.sh and wired via:
#   { "statusLine": { "type": "command", "command": "bash $HOME/.claude/statusline.sh" } }
#
# Requires: bash 3.2+, jq.

set -u

# Read all stdin once.
input=$(cat)

# Helpers ---------------------------------------------------------------------

j() { printf '%s' "$input" | jq -r "$1 // empty" 2>/dev/null; }

# ANSI colors (named so terminals can theme them).
DIM=$'\033[2m'; RESET=$'\033[0m'
CYAN=$'\033[36m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; RED=$'\033[31m'
MAGENTA=$'\033[35m'

segments=()

# Model -----------------------------------------------------------------------
model=$(j '.model.display_name')
[ -n "$model" ] && segments+=("$model")

# CWD (basename, with worktree hint if applicable) ----------------------------
cwd=$(j '.workspace.current_dir')
[ -z "$cwd" ] && cwd=$(j '.cwd')
if [ -n "$cwd" ]; then
    dir="${cwd##*/}"
    wt=$(j '.worktree.name')
    if [ -n "$wt" ]; then
        segments+=("${CYAN}${dir}${RESET}${DIM}@${wt}${RESET}")
    else
        segments+=("${CYAN}${dir}${RESET}")
    fi
fi

# Context window % ------------------------------------------------------------
ctx=$(j '.context_window.used_percentage')
if [ -n "$ctx" ]; then
    # Strip decimals.
    ctx_int=${ctx%.*}
    if [ "$ctx_int" -ge 80 ] 2>/dev/null; then
        color=$RED
    elif [ "$ctx_int" -ge 50 ] 2>/dev/null; then
        color=$YELLOW
    else
        color=$GREEN
    fi
    segments+=("${color}${ctx_int}% ctx${RESET}")
fi

# Rate limits (Pro/Max only — may be absent) ----------------------------------
fmt_reset() {
    # $1 = unix epoch seconds. Print "(in 3m)" / "(in 1h12m)" / "(in 2d)".
    local now diff h m d
    now=$(date +%s)
    diff=$(( $1 - now ))
    [ "$diff" -le 0 ] && { printf '(resetting)'; return; }
    if [ "$diff" -lt 3600 ]; then
        m=$(( diff / 60 ))
        printf '(in %dm)' "$m"
    elif [ "$diff" -lt 86400 ]; then
        h=$(( diff / 3600 ))
        m=$(( (diff % 3600) / 60 ))
        if [ "$m" -gt 0 ]; then printf '(in %dh%dm)' "$h" "$m"
        else printf '(in %dh)' "$h"; fi
    else
        d=$(( diff / 86400 ))
        h=$(( (diff % 86400) / 3600 ))
        if [ "$h" -gt 0 ]; then printf '(in %dd%dh)' "$d" "$h"
        else printf '(in %dd)' "$d"; fi
    fi
}

rl5=$(j '.rate_limits.five_hour.used_percentage')
rl7=$(j '.rate_limits.seven_day.used_percentage')
if [ -n "$rl5" ] || [ -n "$rl7" ]; then
    parts=()
    if [ -n "$rl5" ]; then
        v=${rl5%.*}
        if [ "$v" -ge 90 ] 2>/dev/null; then c=$RED
        elif [ "$v" -ge 70 ] 2>/dev/null; then c=$YELLOW
        else c=$DIM; fi
        reset_at=$(j '.rate_limits.five_hour.resets_at')
        hint=""
        if [ -n "$reset_at" ] && [ "$v" -ge 70 ] 2>/dev/null; then
            hint=" $(fmt_reset "$reset_at")"
        fi
        parts+=("${c}5h:${v}%${hint}${RESET}")
    fi
    if [ -n "$rl7" ]; then
        v=${rl7%.*}
        if [ "$v" -ge 90 ] 2>/dev/null; then c=$RED
        elif [ "$v" -ge 70 ] 2>/dev/null; then c=$YELLOW
        else c=$DIM; fi
        parts+=("${c}7d:${v}%${RESET}")
    fi
    # Join rate-limit parts with " · "
    (IFS=$'\x1f'; rl_joined="${parts[*]}")
    rl_joined="${parts[*]}"
    # Re-join with the middle-dot separator.
    rl_display=""
    for p in "${parts[@]}"; do
        if [ -z "$rl_display" ]; then rl_display="$p"
        else rl_display="$rl_display ${DIM}·${RESET} $p"; fi
    done
    segments+=("$rl_display")
fi

# Goal (only emits when an active goal exists) --------------------------------
if [ -x "$HOME/.claude/hooks/goal-statusline.sh" ]; then
    sid=$(j '.session_id')
    goal_seg=$(printf '%s' "$input" | bash "$HOME/.claude/hooks/goal-statusline.sh" "$cwd" "$sid" 2>/dev/null || true)
    [ -n "$goal_seg" ] && segments+=("$goal_seg")
fi

# Output ----------------------------------------------------------------------
sep=" ${DIM}|${RESET} "
out=""
for s in "${segments[@]}"; do
    if [ -z "$out" ]; then out="$s"
    else out="$out$sep$s"; fi
done
printf '%s' "$out"
