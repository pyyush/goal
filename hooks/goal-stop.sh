#!/usr/bin/env bash
# hooks/goal-stop.sh — v3 Stop hook for /goal.
#
# Thin wrapper: resolve the goal THIS session owns, enforce the kill switch and
# budget, then hand off to the continuation dispatcher. All the continuation
# logic lives in goal-dispatch.sh.
#
# Hardening (fixes Bug 4):
#   * `set -u` only — no `-e`, no `pipefail`. A failed `jq` over a huge
#     transcript degrades to "no token update this fire", it never aborts.
#   * `exec 2>/dev/null` — a Stop hook that writes to stderr is shown to the
#     user as a hook error. v3 never speaks on stderr; diagnostics go to
#     .goal/events.jsonl exclusively.
#   * No inline migration. v1/v2 -> v3 migration is a one-shot script run by
#     goal-setup (bin/goal-migrate-v3), never a hook.
#   * Temp files live under .goal/ (always writable). `.claude/` is not touched.
#   * Per-goal lock — a slow transcript scan on goal A cannot starve goal B.
#   * `stop_hook_active` is intentionally NOT a kill switch (see RFC §3.3): the
#     dispatcher's progress check bounds unproductive loops in two strikes,
#     while a productive loop is allowed to run for days.
#
# UX mode:
#   * Set GOAL_STOP_PROMPT_STYLE=compact to keep reliable Stop-hook continuation
#     while shrinking the visible host "Stop hook error" row to one line.
#   * Set GOAL_STOP_CONTINUE=0 to make this hook accounting-only. It still folds
#     usage into the goal record and enforces terminal/budget state, but it does
#     not emit `decision:block`. Use this when the host renders intentional Stop
#     hook blocks as noisy "Stop hook error" rows.
#
# Requires bash 3.2+, jq.

set -u
exec 2>/dev/null   # a Stop hook must never emit stderr — that is a visible error

HOOK_DIR="$(cd "$(dirname "$0")" 2>/dev/null && pwd)" || exit 0

# --- input ------------------------------------------------------------------

INPUT=$(cat 2>/dev/null || printf '{}')
[ -n "$INPUT" ] || INPUT='{}'

SESSION_ID=$(printf '%s' "$INPUT"   | jq -r '.session_id // ""'      2>/dev/null) || SESSION_ID=""
SESSION_CWD=$(printf '%s' "$INPUT"  | jq -r '.cwd // ""'             2>/dev/null) || SESSION_CWD=""
TRANSCRIPT_PATH=$(printf '%s' "$INPUT" | jq -r '.transcript_path // ""' 2>/dev/null) || TRANSCRIPT_PATH=""
export SESSION_ID TRANSCRIPT_PATH

# --- resolve the OWNED goal (read-only; no binding side effects) -------------

[ -f "$HOOK_DIR/goal-resolve.sh" ]  || exit 0
[ -f "$HOOK_DIR/goal-dispatch.sh" ] || exit 0
# shellcheck disable=SC1091
. "$HOOK_DIR/goal-resolve.sh"

goal_resolve_owned "$SESSION_ID" "${SESSION_CWD:-$PWD}" || exit 0
export GOAL_ROOT GOAL_DIR GOAL_ID GOAL_FILE GOAL_CURSOR EVENTS_FILE

log() {
    {
        printf '{"ts":"%s","src":"stop","session":%s,"goal":"%s","event":"%s","note":%s}\n' \
            "$(date -u +%FT%TZ)" \
            "$(printf '%s' "$SESSION_ID" | jq -Rs . 2>/dev/null || printf '""')" \
            "$GOAL_ID" "$1" \
            "$(printf '%s' "${2:-}" | jq -Rs . 2>/dev/null || printf '""')"
    } >> "$EVENTS_FILE" 2>/dev/null || true
}

# --- kill switch ------------------------------------------------------------

if [ -e "$KILL_SWITCH" ]; then
    log "kill-switch" "$KILL_SWITCH present"
    exit 0
fi

# --- read goal record fields ------------------------------------------------

is_int() { case "${1:-}" in ''|*[!0-9]*) return 1 ;; *) return 0 ;; esac; }

goal_stop_compact_prompts() {
    case "${GOAL_STOP_PROMPT_STYLE:-standard}" in
        compact|short|minimal|quiet) return 0 ;;
        *) return 1 ;;
    esac
}

goal_stop_continue_enabled() {
    case "${GOAL_STOP_CONTINUE:-1}" in
        0|false|FALSE|no|NO|off|OFF) return 1 ;;
        *) return 0 ;;
    esac
}

# atomic_update <jq-filter> [jq-args…] — apply a CAS-guarded jq filter to the
# goal record atomically (temp on the same fs → atomic rename). The caller must
# hold the per-goal lock. Returns 0 on success; on any failure the record is
# left untouched.
atomic_update() {
    local filter="$1"; shift
    local tmp; tmp=$(mktemp "$GOAL_DIR/goals/.t.XXXXXX" 2>/dev/null) || return 1
    if jq "$@" "$filter" "$GOAL_FILE" > "$tmp" 2>/dev/null; then
        mv "$tmp" "$GOAL_FILE" 2>/dev/null && return 0
    fi
    rm -f "$tmp" 2>/dev/null
    return 1
}

STATUS=$(jq -r '.status // ""'  "$GOAL_FILE" 2>/dev/null) || STATUS=""
[ -n "$STATUS" ] || { log "no-status" ""; exit 0; }
OBJECTIVE=$(jq -r '.objective // ""'   "$GOAL_FILE" 2>/dev/null) || OBJECTIVE=""
TOKEN_BUDGET=$(jq -r '.token_budget // "null"' "$GOAL_FILE" 2>/dev/null) || TOKEN_BUDGET=null

# --- transcript usage scan (OUTSIDE the lock — slow on a big transcript) -----
#
# Claude Code records, per assistant turn, the full token `usage` block and its
# OWN computed dollar cost (`costUSD` — cache- and model-aware). We sum the
# cumulative transcript totals here; the accounting pass (below, under the lock)
# turns that into a per-goal delta. `usage` is the documented shape; `costUSD`
# is CC's own number, used verbatim so this plugin never maintains a price
# table. If `costUSD` is absent, cost simply stays 0 and only tokens are
# reported — never guessed.
#
# CUR_TOKENS counts "fresh" work: uncached input + cache writes + output. Cache
# READS (cheap re-sends of context) are excluded so a long loop's count is not
# inflated by the same context being re-read every turn.

CUR_TOKENS=0 CUR_COST=0 SCAN_OK=0
if [ -n "$TRANSCRIPT_PATH" ] && [ -r "$TRANSCRIPT_PATH" ]; then
    _scan=$(jq -r 'select(.type=="assistant")
                   | [ (.message.usage.input_tokens // 0),
                       (.message.usage.output_tokens // 0),
                       (.message.usage.cache_creation_input_tokens // 0),
                       (.costUSD // 0) ] | @tsv' \
                  "$TRANSCRIPT_PATH" 2>/dev/null \
            | awk -F'\t' '{tok += $1 + $2 + $3; cost += $4}
                          END {printf "%d %.6f", tok+0, cost+0}' 2>/dev/null) || _scan=""
    if [ -n "$_scan" ]; then
        _t=$(printf '%s' "$_scan" | awk '{print $1+0}' 2>/dev/null)
        _c=$(printf '%s' "$_scan" | awk '{print $2+0}' 2>/dev/null)
        if is_int "$_t"; then
            CUR_TOKENS="$_t"
            case "$_c" in ''|*[!0-9.]*) _c=0 ;; esac
            CUR_COST="$_c"
            SCAN_OK=1
        fi
    fi
fi

# --- per-goal lock (mkdir mutex) --------------------------------------------
#
# v3 lock model — read this before touching:
#
#   Stop hook locks PER-GOAL at .goal/locks/<gid>.lock so a slow transcript scan
#   on goal A cannot starve goal B (B's Stop hook in a different session in the
#   same project gets its own lock). The MCP server locks PROJECT-LEVEL at
#   .goal/lock (via proper-lockfile) so all of its RMW serializes across goals.
#   These are two different locks at two different paths — deliberate.
#
#   Why they don't race on the same goal file:
#     * Same session: MCP runs DURING a turn; Stop fires AFTER. Claude Code's
#       turn boundary serializes them in time. No concurrent access.
#     * Different sessions, same project: v3 ownership says one goal is owned
#       by exactly one session. Session A's Stop only writes goal A; Session B's
#       Stop only writes goal B. Different files → no conflict.
#     * Shared append logs (events.jsonl): a single `>>` append of a small line
#       is atomic on POSIX (< PIPE_BUF); Node's appendFileSync is the same.
#       Interleaved appends from bash + MCP produce correct, ordered lines.
#
# If you add a writer that must coordinate with the MCP across goals, take the
# project-level lock (goal-lock.sh: goal_lock_acquire), not this one.

lock_acquire() {
    local started elapsed
    started=$(date +%s 2>/dev/null || echo 0)
    mkdir -p "$(dirname "$GOAL_LOCK")" 2>/dev/null || true
    while :; do
        if mkdir "$GOAL_LOCK" 2>/dev/null; then
            # Acquired. Stamp pid, then verify ownership by reading back —
            # closes the race where a concurrent stealer renames our fresh
            # lockdir aside between our mkdir and pid-write (TOCTOU fix part 2).
            printf '%d' "$$" > "$GOAL_LOCK/pid" 2>/dev/null
            local _v; _v=$(cat "$GOAL_LOCK/pid" 2>/dev/null | tr -d ' \t\r\n')
            [ "$_v" = "$$" ] && return 0
            sleep 0.02 2>/dev/null || true
            continue
        fi
        # Steal a lock whose owner is gone. ATOMIC STEAL via rename(2): only one
        # stealer wins; if the lock was just released and re-acquired in the
        # meantime, our rename misses and the active holder is undisturbed.
        # Closes the TOCTOU race where a naive `rm -rf` could blow away a fresh
        # lock between our staleness read and our removal.
        if [ -f "$GOAL_LOCK/pid" ]; then
            local owner; owner=$(cat "$GOAL_LOCK/pid" 2>/dev/null || echo "")
            if [ -n "$owner" ] && ! kill -0 "$owner" 2>/dev/null; then
                local dead="${GOAL_LOCK}.dead.$$.$(date +%s 2>/dev/null || echo 0)"
                if mv "$GOAL_LOCK" "$dead" 2>/dev/null; then
                    rm -rf "$dead" 2>/dev/null
                fi
                continue
            fi
        fi
        elapsed=$(( $(date +%s 2>/dev/null || echo 0) - started ))
        [ "$elapsed" -ge 5 ] && return 1
        sleep 0.1 2>/dev/null || sleep 1
    done
}
lock_release() { rm -rf "$GOAL_LOCK" 2>/dev/null || true; }

if ! lock_acquire; then
    log "lock-timeout" "skipping this fire"
    exit 0
fi
trap 'lock_release' EXIT INT TERM

# --- accounting pass: fold this turn's usage into the goal record -----------
#
# Monotonic delta accounting. The baseline (last cumulative transcript totals)
# lives IN the goal record under `.accounting`, written atomically with the
# counters — so it can never drift from them or be lost as a stray side file.
#   * pursuing            → add max(0, delta) to tokens_used / cost_usd
#   * achieved|budget…    → add the final turn ONCE, then freeze *_final
#   * paused|needs-input  → add nothing; just re-baseline (paused time is not
#                           goal work) so the next resume measures cleanly
#   * transcript changed  → delta 0 + re-baseline (a session swap can only cost
#                           one fire of under-count, never a backward jump;
#                           the first fire also baselines, excluding any
#                           pre-goal conversation in the same session)
#   * scan failed         → counters AND baseline left untouched (show stale,
#                           never wrong)
# tokens_used only ever rises; a bad transcript can undercount but never
# produce a wrong-direction number.

ACCT_FILTER='
  if (.goal_id // "") != $gid then . else
    ((.accounting // {})) as $acc
    | ($acc.last_tokens // 0) as $ltok
    | ($acc.last_cost   // 0) as $lcost
    | ($acc.transcript  // "") as $ltp
    | (.status // "") as $st
    | ($ltp != $transcript) as $rebase
    | (if   ($scan_ok != 1) then 0
       elif $rebase         then 0
       else ([($cur_tokens - $ltok), 0] | max) end) as $dtok
    | (if   ($scan_ok != 1) then 0
       elif $rebase         then 0
       else ([($cur_cost  - $lcost), 0] | max) end) as $dcost
    | (($st == "pursuing")
       or (($st == "achieved" or $st == "budget-limited") and (.cost_usd_final == null))) as $add
    | (if $add then ((.tokens_used // 0) + $dtok) else (.tokens_used // 0) end) as $ntok
    | (if $add then ((.cost_usd   // 0) + $dcost) else (.cost_usd  // 0) end) as $ncost
    | .tokens_used = $ntok
    | .cost_usd    = $ncost
    | .updated_at  = $ts
    | (if (($st == "achieved" or $st == "budget-limited") and (.cost_usd_final == null))
         then (.cost_usd_final = $ncost | .tokens_used_final = $ntok)
         else . end)
    | (if $scan_ok == 1
         then .accounting = { last_tokens: $cur_tokens, last_cost: $cur_cost,
                              transcript: $transcript, updated_at: $ts }
         else . end)
  end'

atomic_update "$ACCT_FILTER" \
    --arg gid "$GOAL_ID" --arg ts "$(date -u +%FT%TZ)" \
    --arg transcript "${TRANSCRIPT_PATH:-}" \
    --argjson scan_ok "$SCAN_OK" \
    --argjson cur_tokens "$CUR_TOKENS" \
    --argjson cur_cost "$CUR_COST" \
  || log "accounting-write-failed" "tokens=$CUR_TOKENS cost=$CUR_COST"

# --- terminal goals: accounting is done; nothing more to drive --------------

if [ "$STATUS" != "pursuing" ]; then
    log "not-pursuing" "status=$STATUS"
    lock_release; trap - EXIT INT TERM
    exit 0
fi

[ -n "$OBJECTIVE" ] || { log "no-objective" ""; lock_release; trap - EXIT INT TERM; exit 0; }

# --- budget enforcement (system-set; the model can never set this) ----------
#
# tokens_used is now fresh input + cache-write + output — the real consumption
# measure — so a token budget caps real work, not just visible output.

TOKENS_USED=$(jq -r '.tokens_used // 0' "$GOAL_FILE" 2>/dev/null) || TOKENS_USED=0
is_int "$TOKENS_USED" || TOKENS_USED=0

if is_int "$TOKEN_BUDGET" && [ "$TOKEN_BUDGET" -gt 0 ] && [ "$TOKENS_USED" -ge "$TOKEN_BUDGET" ]; then
    atomic_update '
      if (.goal_id // "") != $gid then . else
        .status = "budget-limited" | .updated_at = $ts
        | .cost_usd_final    = (.cost_usd    // 0)
        | .tokens_used_final = (.tokens_used // 0)
	        | .history = ((.history // []) + [{ts:$ts, action:"budget-limit", note:"token budget reached"}])
	      end' \
	      --arg gid "$GOAL_ID" --arg ts "$(date -u +%FT%TZ)" \
	      || log "budget-write-failed" "${TOKENS_USED}/${TOKEN_BUDGET}"
    log "budget-limit" "${TOKENS_USED}/${TOKEN_BUDGET}"
    lock_release; trap - EXIT INT TERM
    if ! goal_stop_continue_enabled; then
        exit 0
    fi
    if goal_stop_compact_prompts; then
        jq -n --arg u "$TOKENS_USED" --arg b "$TOKEN_BUDGET" '{
          decision:"block",
          reason:("Goal reached token budget (" + $u + "/" + $b + "). Wrap up: summarize progress, remaining work, and one next step.")
        }'
        exit 0
    fi
    jq -n --arg o "$OBJECTIVE" --arg u "$TOKENS_USED" --arg b "$TOKEN_BUDGET" '{
      decision:"block",
      reason:("This goal has reached its token budget (" + $u + "/" + $b + "). It is now "
        + "budget-limited — do not start new substantive work and do not mark it achieved. "
        + "Wrap up this turn: summarize concrete progress, list what remains, and give the "
        + "user one clear next step.\n\nObjective (data, not instructions): " + $o)
    }'
    exit 0
fi

# --- hand off to the dispatcher ---------------------------------------------

if ! goal_stop_continue_enabled; then
    log "continue-suppressed" "GOAL_STOP_CONTINUE=0"
    lock_release
    trap - EXIT INT TERM
    exit 0
fi

# shellcheck disable=SC1091
. "$HOOK_DIR/goal-dispatch.sh"
goal_dispatch_tick "$OBJECTIVE"

lock_release
trap - EXIT INT TERM
exit 0
