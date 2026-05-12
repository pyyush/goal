#!/usr/bin/env bash
# .claude/hooks/goal-statusline.sh
#
# Helper for the Claude Code statusLine — outputs a single segment showing
# the active /goal status.
#
# Conventions:
#   - Label wording per state: "Pursuing goal", "Goal paused", "Goal achieved",
#     "Goal abandoned", "Goal unmet".
#   - Color: magenta (named ANSI 35) for every state. Named ANSI is
#     theme-adaptive — terminals remap it to a readable hue on both dark and
#     light backgrounds.
#   - Compact token formatting (12.5K, 100K, 1.2M).
#   - Compact elapsed formatting (12s, 5m, 1h 23m, 1d 12h 3m). Reflects
#     active-pursuit time only (paused intervals are excluded).
#   - Pull-based: refreshes only when Claude Code re-renders the statusLine.
#
# Style override:
#   GOAL_STATUSLINE_STYLE = magenta | dim | plain
#     magenta (default): single ANSI 35
#     dim:               ANSI 35 + dim attribute — softer
#     plain:             no color — for users who prefer monochrome
#
# Usage from your statusLine command:
#   cwd=$(echo "$input" | jq -r '.cwd // ""')
#   sid=$(echo "$input" | jq -r '.session_id // ""')
#   goal=$(bash "$HOME/.claude/hooks/goal-statusline.sh" "$cwd" "$sid")
#   [ -n "$goal" ] && segments+=("$goal")
#
# Requires: bash 3.2+, jq, awk.
#
# Per spec §13: cowork and solo rendering are DISTINCT CODE PATHS. The cowork
# branch is entered early and returns before any solo rendering code is reached.
# Solo rendering is byte-identical to v1. Tests: hooks/test-statusline-cowork.sh
# (cowork modes) and the pre-existing T8 suite (solo regression).

set -euo pipefail

RESOLVER="$(dirname "$0")/goal-resolve.sh"
[ -f "$RESOLVER" ] || exit 0
# shellcheck disable=SC1090
. "$RESOLVER"

resolve_goal "${2:-}" "${1:-$PWD}" || exit 0

# v3 render path: live baseline+delta, final snapshots, heartbeat freshness,
# compact Codex-style token/time formatting. Older v2/v1 states fall through to
# the compatibility renderers below so existing solo/cowork fixtures remain valid.
if jq -e 'has("time_used_seconds") or has("observed_at") or has("tokens_used_observed_at")' "$GOAL_FILE" >/dev/null 2>&1; then
    _fmt_time() {
        local s="$1"
        if   [ "$s" -lt 60 ];    then printf '%ds' "$s"
        elif [ "$s" -lt 3600 ];  then printf '%dm' $((s / 60))
        elif [ "$s" -lt 86400 ]; then
            if [ $(((s % 3600) / 60)) -gt 0 ]; then printf '%dh %dm' $((s / 3600)) $(((s % 3600) / 60)); else printf '%dh' $((s / 3600)); fi
        else printf '%dd %dh %dm' $((s / 86400)) $(((s % 86400) / 3600)) $(((s % 3600) / 60))
        fi
    }
    _fmt_tokens() {
        awk -v n="$1" 'BEGIN {
            split("T B M K", u, " "); split("1000000000000 1000000000 1000000 1000", s, " ");
            for (i=1;i<=4;i++) if (n >= s[i]) {
                v=n/s[i]; d=(v<10?2:(v<100?1:0)); num=sprintf("%.*f", d, v);
                while (index(num, ".") && substr(num, length(num), 1) == "0") num=substr(num, 1, length(num)-1);
                if (substr(num, length(num), 1) == ".") num=substr(num, 1, length(num)-1);
                print num u[i]; exit
            }
            printf "%d", n
        }'
    }
    _mtime_epoch() {
        stat -f %m "$1" 2>/dev/null || stat -c %Y "$1" 2>/dev/null || printf '0'
    }
    SEP=$'\x1f'
    V3=$(jq -r --arg sep "$SEP" '
        (now | floor) as $now
        | (.time_used_seconds // .pursuing_seconds // 0 | floor) as $base
        | ((try (.observed_at | fromdateiso8601) catch null) // (try (.updated_at | fromdateiso8601) catch null) // $now) as $obs
        | ((try (.active_turn_started_at | fromdateiso8601) catch null) // $obs) as $active
        | (if (.status == "pursuing") then ($base + (($now - ([ $obs, $active ] | max)) | floor | if . < 0 then 0 else . end)) else ($base) end) as $live
        | (if ((.status == "achieved" or .status == "unmet" or .status == "budget-limited") and (.time_used_seconds_final != null)) then (.time_used_seconds_final | floor) else $live end) as $seconds
        | ((.audit.checklist // []) as $a | ([ $a[] | select(.status == "passed") ] | length | tostring) + "/" + ($a | length | tostring)) as $aud
        | [ .status,
            ($seconds | tostring),
            ((.tokens_used_final // .tokens_used // 0) | tostring),
            ((.token_budget // .budget.limit // 0) | tostring),
            (.current.agent // "solo"),
            ($aud),
            (.queued_until // ""),
            (.handoff_head // ""),
            (.tokens_used_observed_at // "")
          ] | join($sep)
    ' "$GOAL_FILE" 2>/dev/null) || V3=""
    if [ -n "$V3" ]; then
        IFS=$SEP read -r V3_STATUS V3_SECONDS V3_TOKENS V3_BUDGET V3_AGENT V3_AUDIT V3_QUEUED V3_HANDOFF_HEAD V3_TOKENS_AT <<<"$V3"
        DOT="◌"
        if [ -f "$GOAL_DIR/heartbeat" ]; then
            AGE=$(( $(date +%s) - $(_mtime_epoch "$GOAL_DIR/heartbeat") ))
            if [ "$AGE" -lt 5 ]; then DOT="●"; elif [ "$AGE" -le 30 ]; then DOT="·"; fi
        fi
        TOK="$(_fmt_tokens "$V3_TOKENS")"
        if [ "${V3_BUDGET:-0}" -gt 0 ] 2>/dev/null; then TOK="${TOK}/$(_fmt_tokens "$V3_BUDGET")"; fi
        if [ -n "$V3_TOKENS_AT" ]; then
            TOK_AGE=$(jq -n --arg t "$V3_TOKENS_AT" '((now - ($t|fromdateiso8601)) | floor)' 2>/dev/null || printf '0')
            [ "$TOK_AGE" -gt 30 ] 2>/dev/null && TOK="${TOK}*"
        fi
        V3_COWORK=0
        if [ "$V3_AGENT" != "solo" ] || [ -f "$GOAL_DIR/cowork.yml" ] || jq -e '((.roles.lead // "") != "") or ((.roles.build // "") != "") or ((.roles.review // "") != "")' "$GOAL_FILE" >/dev/null 2>&1; then
            V3_COWORK=1
        fi
        V3_ROLE=""
        if [ "$V3_AGENT" != "solo" ]; then
            V3_ROLE=$(jq -r --arg a "$V3_AGENT" '.roles // {} | to_entries | map(select(.value == $a)) | if length > 0 then .[0].key else "" end' "$GOAL_FILE" 2>/dev/null) || V3_ROLE=""
        fi
        case "$V3_STATUS" in
            pursuing)
                if [ "$V3_COWORK" -eq 1 ]; then
                    agent_token="$V3_AGENT"
                    [ -n "$V3_ROLE" ] && agent_token="${agent_token}→${V3_ROLE}"
                    label="cowork: ${agent_token} | ${V3_AUDIT} audited | $(_fmt_time "$V3_SECONDS") | ${TOK}"
                else
                    label="goal · $(_fmt_time "$V3_SECONDS") · ${TOK} · ${V3_AGENT} · ${V3_AUDIT}"
                fi
                ;;
            paused) label="goal · paused $(_fmt_time "$V3_SECONDS")" ;;
            achieved) label="goal · ✓ $(_fmt_time "$V3_SECONDS") · $(_fmt_tokens "$V3_TOKENS") tokens" ;;
            unmet) label="goal · unmet" ;;
            budget-limited) label="goal · over budget · ${TOK}" ;;
            relaying)
                V3_FROM=""
                V3_TO="$V3_AGENT"
                if [ -n "$V3_HANDOFF_HEAD" ] && [ -f "$GOAL_DIR/handoff/${V3_HANDOFF_HEAD}.md" ]; then
                    V3_FROM=$(awk '/^---/{if(++c==1)next;if(c==2)exit} c==1 && /^from:/{gsub(/^from:[[:space:]]*/,"");print;exit}' "$GOAL_DIR/handoff/${V3_HANDOFF_HEAD}.md" 2>/dev/null || printf '')
                    V3_TO=$(awk '/^---/{if(++c==1)next;if(c==2)exit} c==1 && /^to:/{gsub(/^to:[[:space:]]*/,"");print;exit}' "$GOAL_DIR/handoff/${V3_HANDOFF_HEAD}.md" 2>/dev/null || printf "$V3_TO")
                fi
                if [ -n "$V3_FROM" ] && [ -n "$V3_TO" ]; then label="Relaying ${V3_FROM} → ${V3_TO}…"; else label="goal · → ${V3_AGENT}"; fi
                ;;
            queued)
                THROTTLED=""
                if [ -f "$GOAL_DIR/quota.json" ]; then
                    THROTTLED=$(jq -r '.providers // {} | to_entries | map(select(.value.estimated_headroom == "exhausted") | .key) | join(" + ")' "$GOAL_DIR/quota.json" 2>/dev/null) || THROTTLED=""
                fi
                label="Queued${V3_QUEUED:+ — retry at ${V3_QUEUED}}"
                [ -n "$THROTTLED" ] && label="${label} (${THROTTLED} throttled)"
                ;;
            *) exit 0 ;;
        esac
        case "${GOAL_STATUSLINE_STYLE:-magenta}" in
            plain) open='' ; close='' ;;
            dim) open=$'\033[2;35m' ; close=$'\033[0m' ;;
            magenta|*) open=$'\033[35m' ; close=$'\033[0m' ;;
        esac
        printf '%s%s %s%s' "$open" "$DOT" "$label" "$close"
        exit 0
    fi
fi

# ============================================================================
# COWORK MODE DETECTION (spec §11, §13)
# Detect cowork mode BEFORE reading state for the solo render path.
# Cowork is active if ANY of:
#   1. state.json has non-null current.agent
#   2. state.json has any non-null roles.{lead,build,review}
#   3. cowork.yml exists in .goal/
#
# If NONE of these are true → solo mode. Use the existing v1 render path,
# unchanged, without touching it.
# ============================================================================

_is_cowork_mode() {
    # Check for cowork.yml presence (P5 will populate it; P4 detects presence).
    if [ -f "${GOAL_DIR}/cowork.yml" ]; then
        return 0
    fi
    # Check state.json fields using jq.
    local raw
    raw=$(jq -r '
        if (type == "object") then
            (
                ((.current.agent // "") != "") or
                ((.roles.lead // "") != "") or
                ((.roles.build // "") != "") or
                ((.roles.review // "") != "")
            ) | if . then "yes" else "no" end
        else "no" end
    ' "$GOAL_FILE" 2>/dev/null) || raw="no"
    [ "$raw" = "yes" ]
}

# Cowork parse.sh path: GOAL_PARSE_SH env override wins, then walk-up.
# The test harness and packagers that install the statusline outside the
# repo layout should set GOAL_PARSE_SH explicitly.
PARSE_SH=""
if [ -n "${GOAL_PARSE_SH:-}" ] && [ -f "$GOAL_PARSE_SH" ]; then
    PARSE_SH="$GOAL_PARSE_SH"
else
    for _p in \
        "$(dirname "$0")/../cowork/handoff/parse.sh" \
        "${GOAL_DIR}/../cowork/handoff/parse.sh"; do
        if [ -f "$_p" ]; then
            PARSE_SH="$(cd "$(dirname "$_p")" && pwd)/$(basename "$_p")"
            break
        fi
    done
fi

# ============================================================================
# COWORK RENDER PATH (spec §11, §13 — distinct from solo path below)
# ============================================================================

if _is_cowork_mode; then
    # Read the fields we need for all cowork sub-modes.
    # Use ASCII Unit Separator (\x1f) instead of tab. Bash `read` collapses
    # consecutive whitespace separators (tab is whitespace), so a row like
    # "pursuing\tagent\t\t\t2/4" with empty handoff_head + queued_until would
    # eat the empties and put 2/4 in the wrong slot. \x1f is non-whitespace
    # and never appears in user data.
    SEP=$'\x1f'
    COWORK_SHAPE=$(jq -r --arg sep "$SEP" '
        if (type == "object" and (.status | type) == "string") then
            [ .status,
              (.current.agent // ""),
              (.handoff_head // ""),
              (.queued_until // ""),
              (.audit.checklist // null | if . == null then ""
               else ([ .[] | select(.status == "passed") ] | length | tostring)
                    + "/" +
                    (length | tostring)
               end)
            ] | join($sep)
        else "MALFORMED"
        end
    ' "$GOAL_FILE" 2>/dev/null) || exit 0

    [ "$COWORK_SHAPE" = "MALFORMED" ] && exit 0

    IFS=$SEP read -r CW_STATUS CW_AGENT CW_HANDOFF_HEAD CW_QUEUED_UNTIL CW_AUDITED \
        <<<"$COWORK_SHAPE"

    # Style (same style var as solo path).
    case "${GOAL_STATUSLINE_STYLE:-magenta}" in
        plain)        open=''            ; close='' ;;
        dim)          open=$'\033[2;35m' ; close=$'\033[0m' ;;
        magenta|*)    open=$'\033[35m'   ; close=$'\033[0m' ;;
    esac

    case "$CW_STATUS" in

        # ---- cowork-active (pursuing) ----------------------------------------
        pursuing)
            # ---- P5: Parse cowork.yml for role names (a14 full) ----------------
            # Precedence: cowork.yml roles > state.json roles > empty.
            # cowork.yml maps agent-name→role; agent files map agent_id→runner.
            # We do a two-step lookup:
            #   1. Find which agent-name in cowork.yml has runner matching
            #      the runner prefix of CW_AGENT (e.g. "claude-code" in agent_id).
            #   2. Use that agent-name to look up roles.lead/build/review.
            # This is a heuristic: robust when agent_id = <runner>-<host>-<pid>.
            _COWORK_YML="${GOAL_DIR}/cowork.yml"

            # Helper: given an agent_id, return its role from cowork.yml or state.roles.
            _lookup_role_for_agent() {
                local _agent_id="$1"
                local _role_out=""
                # Try cowork.yml first (P5 path).
                if [ -f "$_COWORK_YML" ]; then
                    # Parse cowork.yml roles section with awk.
                    # roles section: lead/build/review → agent-name.
                    # agents section: agent-name → runner.
                    # Match by finding which agent-name's runner is a prefix of _agent_id.
                    _role_out=$(awk -v agent_id="$_agent_id" '
                        /^agents:/ { in_agents=1; in_roles=0; in_agent_entry=0; next }
                        /^roles:/ { in_roles=1; in_agents=0; in_agent_entry=0; next }
                        /^[a-zA-Z]/ && !/^agents:/ && !/^roles:/ { in_agents=0; in_roles=0; in_agent_entry=0 }
                        in_agents && /^  [a-zA-Z0-9_-]+:/ {
                            gsub(/^  /,""); gsub(/:.*$/,""); current_agent_name=$0; in_agent_entry=1; next
                        }
                        in_agents && in_agent_entry && /^    runner:/ {
                            gsub(/^    runner:[[:space:]]*/,""); gsub(/[[:space:]]*$/,"")
                            runner = $0
                            # Store runner for this agent name.
                            agent_runners[current_agent_name] = runner
                        }
                        in_roles && /^  (lead|build|review):/ {
                            gsub(/^  /,""); split($0, kv, /:[[:space:]]*/); role_name = kv[1]; role_agent = kv[2]
                            gsub(/[[:space:]]*$/,"",role_agent)
                            role_assignments[role_name] = role_agent
                        }
                        END {
                            # Try to match agent_id by runner prefix.
                            for (aname in agent_runners) {
                                runner = agent_runners[aname]
                                if (index(agent_id, runner) == 1) {
                                    # This agent_name matches. Find its role.
                                    for (role in role_assignments) {
                                        if (role_assignments[role] == aname) { print role; exit }
                                    }
                                }
                            }
                        }
                    ' "$_COWORK_YML" 2>/dev/null) || _role_out=""
                fi
                # Fallback: state.json roles (P4 path).
                if [ -z "$_role_out" ]; then
                    _role_out=$(jq -r --arg a "$_agent_id" '
                        .roles // {} | to_entries |
                        map(select(.value == $a)) |
                        if length > 0 then .[0].key else "" end
                    ' "$GOAL_FILE" 2>/dev/null) || _role_out=""
                fi
                printf '%s' "$_role_out"
            }

            # Determine current agent's role.
            ROLE=$(_lookup_role_for_agent "$CW_AGENT") || ROLE=""

            # Build agent→role token.
            if [ -n "$ROLE" ]; then
                agent_token="${CW_AGENT}→${ROLE}"
            else
                agent_token="${CW_AGENT}"
            fi

            # Other agents: read agents/ dir for heartbeat files.
            OTHER_AGENTS=""
            if [ -d "${GOAL_DIR}/agents" ]; then
                for _f in "${GOAL_DIR}/agents/"*.json; do
                    [ -f "$_f" ] || continue
                    _aid=$(jq -r '.agent_id // ""' "$_f" 2>/dev/null) || continue
                    [ "$_aid" = "$CW_AGENT" ] && continue
                    _role=$(_lookup_role_for_agent "$_aid") || _role=""
                    # Determine if the other agent is active (heartbeat within 30s).
                    _hb=$(jq -r '.heartbeat_at // ""' "$_f" 2>/dev/null) || _hb=""
                    _state="idle"
                    if [ -n "$_hb" ]; then
                        _hb_epoch=$(date -d "$_hb" +%s 2>/dev/null || \
                                    date -j -f "%Y-%m-%dT%H:%M:%SZ" "$_hb" +%s 2>/dev/null || echo 0)
                        _now_epoch=$(date +%s)
                        _age=$(( _now_epoch - _hb_epoch ))
                        [ "$_age" -lt 30 ] && _state="active"
                    fi
                    if [ -n "$_role" ]; then
                        _tok="${_aid}=${_role} ${_state}"
                    else
                        _tok="${_aid} ${_state}"
                    fi
                    if [ -z "$OTHER_AGENTS" ]; then
                        OTHER_AGENTS="$_tok"
                    else
                        OTHER_AGENTS="${OTHER_AGENTS} | ${_tok}"
                    fi
                done
            fi

            # Build label.
            label="cowork: ${agent_token}"
            [ -n "$OTHER_AGENTS" ] && label="${label} | ${OTHER_AGENTS}"
            if [ -n "$CW_AUDITED" ] && [ "$CW_AUDITED" != "/" ]; then
                label="${label} | ${CW_AUDITED} audited"
            fi
            ;;

        # ---- relaying --------------------------------------------------------
        relaying)
            # Read from/to from the latest handoff envelope via parse.sh.
            RELAY_FROM=""
            RELAY_TO=""
            if [ -n "$PARSE_SH" ] && [ -f "$PARSE_SH" ] && [ -n "$CW_HANDOFF_HEAD" ]; then
                # shellcheck disable=SC1090
                . "$PARSE_SH"
                _handoff_file="${GOAL_DIR}/handoff/${CW_HANDOFF_HEAD}.md"
                if [ -f "$_handoff_file" ]; then
                    RELAY_FROM=$(handoff_parse_field "$_handoff_file" from 2>/dev/null) || RELAY_FROM=""
                    RELAY_TO=$(handoff_parse_field "$_handoff_file" to 2>/dev/null) || RELAY_TO=""
                fi
            fi
            # Fallback: use current.agent from state if parse.sh unavailable.
            if [ -z "$RELAY_FROM" ] || [ -z "$RELAY_TO" ]; then
                RELAY_FROM=$(jq -r '
                    if (.handoff_head != null) then
                        (.lineage // [] | last | .agent // "")
                    else "" end
                ' "$GOAL_FILE" 2>/dev/null) || RELAY_FROM=""
                RELAY_TO="$CW_AGENT"
            fi
            if [ -n "$RELAY_FROM" ] && [ -n "$RELAY_TO" ]; then
                label="Relaying ${RELAY_FROM} → ${RELAY_TO}…"
            else
                label="Relaying…"
            fi
            ;;

        # ---- queued ----------------------------------------------------------
        queued)
            # Parse queued_until into HH:MM local time.
            RETRY_TIME=""
            if [ -n "$CW_QUEUED_UNTIL" ]; then
                RETRY_TIME=$(date -d "$CW_QUEUED_UNTIL" "+%H:%M" 2>/dev/null || \
                             date -j -f "%Y-%m-%dT%H:%M:%SZ" "$CW_QUEUED_UNTIL" "+%H:%M" 2>/dev/null || \
                             echo "$CW_QUEUED_UNTIL")
            fi

            # Read throttled provider names from quota.json.
            THROTTLED=""
            QUOTA_FILE="${GOAL_DIR}/quota.json"
            if [ -f "$QUOTA_FILE" ]; then
                THROTTLED=$(jq -r '
                    .providers // {} |
                    to_entries |
                    map(select(.value.estimated_headroom == "exhausted") | .key) |
                    join(" + ")
                ' "$QUOTA_FILE" 2>/dev/null) || THROTTLED=""
            fi

            if [ -n "$RETRY_TIME" ] && [ -n "$THROTTLED" ]; then
                label="Queued — retry at ${RETRY_TIME} (${THROTTLED} throttled)"
            elif [ -n "$RETRY_TIME" ]; then
                label="Queued — retry at ${RETRY_TIME}"
            else
                label="Queued"
            fi
            ;;

        # ---- other statuses in cowork mode: delegate to readable labels ------
        paused)         label="Goal paused (/goal resume)" ;;
        achieved)       label="Goal achieved" ;;
        unmet)          label="Goal unmet (/goal status)" ;;
        budget-limited) label="Goal abandoned" ;;
        *)              exit 0 ;;
    esac

    printf '%s%s%s' "$open" "$label" "$close"
    exit 0
fi

# ============================================================================
# SOLO RENDER PATH (v1 — unchanged, byte-identical to pre-P4)
# Only reached when cowork mode is NOT detected above.
# ============================================================================

# In v2, GOAL_FILE may point at .goal/state.json. The jq filters below are
# a strict superset so they work unchanged. The only P1 addition is handling
# the two new statuses (relaying, queued) in the case statement — solo mode
# shows nothing for those (they're runtime-only states from P3+, but we must
# not crash if a file has them).

SHAPE=$(jq -r '
    if (type == "object" and (.status | type) == "string") then
        ( (try (.pursuing_since | fromdateiso8601) catch null) ) as $since
        | ( (try (.created_at | fromdateiso8601) catch null) ) as $created
        | ( .pursuing_seconds // 0 ) as $base
        # Backward-compat: if pursuing_since is missing on a pursuing legacy
        # file, approximate by using created_at as the session start.
        | ( if .status == "pursuing"
              then (if $since != null then $since
                    elif $created != null then $created
                    else null end)
              else null
            end ) as $start
        | ( if $start != null
              then $base + ((now - ($start | floor)) | floor | (if . < 0 then 0 else . end))
              else $base
            end ) as $elapsed
        | [ .status,
            (.token_budget // null | tostring),
            (.tokens_used // 0 | tostring),
            ($elapsed | tostring)
          ] | @tsv
    else "MALFORMED"
    end
' "$GOAL_FILE" 2>/dev/null) || exit 0

[ "$SHAPE" = "MALFORMED" ] && exit 0

IFS=$'\t' read -r STATUS TOKEN_BUDGET TOKENS_USED TIME_USED <<<"$SHAPE"

case "$TOKENS_USED" in ''|*[!0-9]*) TOKENS_USED=0 ;; esac
case "$TIME_USED"   in ''|*[!0-9]*) TIME_USED=0 ;; esac

# Compact elapsed (active pursuit time only):
#   < 60s   → "45s"
#   < 60m   → "5m"
#   < 24h   → "1h 23m"
#   ≥ 24h   → "1d 12h 3m" (always all three units once ≥ 1 day)
fmt_elapsed() {
    local s="$1"
    if   [ "$s" -lt 60 ];    then printf '%ds' "$s"
    elif [ "$s" -lt 3600 ];  then printf '%dm' $((s / 60))
    elif [ "$s" -lt 86400 ]; then printf '%dh %dm' $((s / 3600)) $(((s % 3600) / 60))
    else                          printf '%dd %dh %dm' \
                                      $((s / 86400)) \
                                      $(((s % 86400) / 3600)) \
                                      $(((s % 3600) / 60))
    fi
}

# Compact tokens: "950" / "12.5K" / "100K" / "1.2M".
fmt_tokens() {
    awk -v n="$1" 'BEGIN {
        if (n < 1000)         { printf "%d", n; }
        else if (n < 100000)  { printf "%.1fK", n/1000; }
        else if (n < 1000000) { printf "%.0fK", n/1000; }
        else                  { printf "%.1fM", n/1000000; }
    }'
}

# Style — defaults to plain magenta. Theme-adaptive: named
# ANSI 35 is remapped by the terminal to be readable on both dark and light
# backgrounds.
case "${GOAL_STATUSLINE_STYLE:-magenta}" in
    plain)        open=''            ; close='' ;;
    dim)          open=$'\033[2;35m' ; close=$'\033[0m' ;;
    magenta|*)    open=$'\033[35m'   ; close=$'\033[0m' ;;
esac

# Build the usage suffix used by Active / BudgetLimited.
usage_with_budget() {
    printf '%s / %s' "$(fmt_tokens "$TOKENS_USED")" "$(fmt_tokens "$TOKEN_BUDGET")"
}

case "$STATUS" in
    pursuing)
        if [ "$TOKEN_BUDGET" != "null" ] && [ "$TOKEN_BUDGET" -gt 0 ] 2>/dev/null; then
            label="Pursuing goal ($(usage_with_budget))"
        elif [ "$TIME_USED" -gt 0 ]; then
            label="Pursuing goal ($(fmt_elapsed "$TIME_USED"))"
        else
            label="Pursuing goal"
        fi
        ;;
    paused)
        label="Goal paused (/goal resume)"
        ;;
    achieved)
        if [ "$TOKEN_BUDGET" != "null" ] && [ "$TOKEN_BUDGET" -gt 0 ] 2>/dev/null; then
            label="Goal achieved ($(fmt_tokens "$TOKENS_USED"))"
        elif [ "$TIME_USED" -gt 0 ]; then
            label="Goal achieved ($(fmt_elapsed "$TIME_USED"))"
        else
            label="Goal achieved"
        fi
        ;;
    unmet)
        label="Goal unmet (/goal status)"
        ;;
    budget-limited)
        if [ "$TOKEN_BUDGET" != "null" ] && [ "$TOKEN_BUDGET" -gt 0 ] 2>/dev/null; then
            label="Goal abandoned ($(usage_with_budget))"
        else
            label="Goal abandoned"
        fi
        ;;
    # v2 statuses — solo mode shows nothing for these runtime-only states
    # (P3 will add cowork-aware rendering). We silently exit-0 per §13:
    # "cowork and solo distinct paths".
    relaying|queued)
        exit 0
        ;;
    *)
        exit 0
        ;;
esac

printf '%s%s%s' "$open" "$label" "$close"
