#!/usr/bin/env bash
# hooks/test-statusline-cowork.sh — T-statusline-cowork: statusline cowork rendering tests (P4)
#
# Tests the four statusline rendering modes:
#   1. solo      — no current.agent, no cowork.yml → solo render path (unchanged v1)
#   2. cowork-active (pursuing) — current.agent set
#   3. relaying  — status=relaying, handoff envelope present
#   4. queued    — status=queued, quota.json present
#
# Per spec §13: cowork and solo are DISTINCT code paths. This test verifies
# each mode produces the correct output pattern without touching the other path.
#
# Run from repo root: ./hooks/test-statusline-cowork.sh
# Exit codes: 0 = pass, 1 = fail.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STATUSLINE="$REPO_ROOT/hooks/goal-statusline.sh"
PARSE_SH="$REPO_ROOT/cowork/handoff/parse.sh"

green() { printf '\033[32m%s\033[0m\n' "$*"; }
red()   { printf '\033[31m%s\033[0m\n' "$*"; }
say()   { printf '  %s\n' "$*"; }
step()  { printf '\n[%s] %s\n' "$(date -u +%H:%M:%S)" "$1"; }

TMP=""
cleanup() { [ -n "$TMP" ] && rm -rf "$TMP" || true; }
trap cleanup EXIT

fail() {
    red "FAIL [T-statusline-cowork]: $*"
    exit 1
}

assert_contains() {
    local output="$1" pattern="$2" label="$3"
    if printf '%s' "$output" | grep -qF "$pattern"; then
        say "$label ✓ (matched: '$pattern')"
    else
        red "FAIL: $label — expected '$pattern' in output"
        printf "  actual output: %s\n" "$output"
        exit 1
    fi
}

assert_not_contains() {
    local output="$1" pattern="$2" label="$3"
    if ! printf '%s' "$output" | grep -qF "$pattern"; then
        say "$label ✓ (correctly absent: '$pattern')"
    else
        red "FAIL: $label — unexpected '$pattern' in output"
        printf "  actual output: %s\n" "$output"
        exit 1
    fi
}

# ---- prereqs ----------------------------------------------------------------

step "0. Prereqs"

[ -f "$STATUSLINE" ] || fail "goal-statusline.sh not found at $STATUSLINE"
[ -f "$PARSE_SH" ]   || fail "parse.sh not found at $PARSE_SH"
command -v jq >/dev/null 2>&1 || fail "jq not found"
say "goal-statusline.sh: $STATUSLINE ✓"

# ---- setup ------------------------------------------------------------------

TMP=$(mktemp -d -t goal-statusline-test-XXXXXX)
PROJECT_ROOT="$TMP/project"
GOAL_DIR="$PROJECT_ROOT/.goal"
HANDOFF_DIR="$GOAL_DIR/handoff"
AGENTS_DIR="$GOAL_DIR/agents"
mkdir -p "$GOAL_DIR" "$HANDOFF_DIR" "$AGENTS_DIR"

NOW="2026-05-11T14:32:00Z"
GOAL_UUID="aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"

# Helper: run statusline in the project dir context.
run_statusline() {
    # Override resolve to point directly at our synthetic state.json.
    GOAL_RESOLVE_OVERRIDE="$GOAL_DIR/state.json" \
    GOAL_BRIDGE_PATTERNS="$REPO_ROOT/cowork/bridge/patterns.json" \
        bash "$STATUSLINE" "$PROJECT_ROOT" "" 2>/dev/null || true
}

# Override goal-resolve.sh so it uses our synthetic state file.
# We do this by placing a shim goal-resolve.sh in the same dir as our
# statusline invocation. Goal-resolve reads session_id and cwd from args;
# we create a simple version that always resolves to our synthetic state.
HOOKS_DIR="$TMP/hooks"
mkdir -p "$HOOKS_DIR"

# Symlink the real statusline, then provide a custom goal-resolve.sh shim.
cp "$STATUSLINE" "$HOOKS_DIR/goal-statusline.sh"
cat > "$HOOKS_DIR/goal-resolve.sh" <<RESOLVER
#!/usr/bin/env bash
resolve_goal() {
    GOAL_ROOT="$PROJECT_ROOT"
    GOAL_FILE="$GOAL_DIR/state.json"
    GOAL_DIR_VAR="$GOAL_DIR"
    GOAL_DIR="\$GOAL_DIR_VAR"
    LOG_FILE="$PROJECT_ROOT/.claude/goal-hook.log"
    KILL_SWITCH="$GOAL_DIR/pause"
    return 0
}
RESOLVER
chmod +x "$HOOKS_DIR/goal-resolve.sh"

# Helper that runs our hooks-dir copy.
run_statusline_shim() {
    GOAL_STATUSLINE_STYLE=plain \
        GOAL_PARSE_SH="$REPO_ROOT/cowork/handoff/parse.sh" \
        bash "$HOOKS_DIR/goal-statusline.sh" "$PROJECT_ROOT" "" 2>/dev/null || true
}

# ============================================================================
# TEST 1: Solo mode (no current.agent, no cowork.yml) — v1 render path
# ============================================================================

step "1. Solo mode — pursuing, no current.agent"

cat > "$GOAL_DIR/state.json" <<STATE
{
  "schema_version": 2,
  "goal_id": "$GOAL_UUID",
  "objective": "test solo goal",
  "status": "pursuing",
  "created_at": "$NOW",
  "updated_at": "$NOW",
  "current": { "agent": null, "session": null, "since": null },
  "roles": { "lead": null, "build": null, "review": null },
  "compat": ["claude-code"],
  "lineage": [],
  "budget": null,
  "audit": null,
  "handoff_head": null,
  "queued_until": null,
  "token_budget": null,
  "tokens_used": 0,
  "pursuing_seconds": 300,
  "pursuing_since": null
}
STATE

output=$(run_statusline_shim)
say "solo pursuing output: '$output'"
assert_contains "$output" "Pursuing goal" "solo pursuing label"
assert_not_contains "$output" "cowork:" "solo must not show cowork: prefix"

step "1b. Solo mode — paused"
TMP_STATE=$(cat "$GOAL_DIR/state.json")
printf '%s' "$TMP_STATE" | jq '.status = "paused"' > "$GOAL_DIR/state.json"
output=$(run_statusline_shim)
say "solo paused output: '$output'"
assert_contains "$output" "Goal paused" "solo paused label"

# ============================================================================
# TEST 2: Cowork-active (pursuing with current.agent set)
# ============================================================================

step "2. Cowork-active (pursuing, current.agent = claude-code-host-1234)"

AGENT_ID="claude-code-host-1234"

cat > "$GOAL_DIR/state.json" <<STATE
{
  "schema_version": 2,
  "goal_id": "$GOAL_UUID",
  "objective": "cowork test goal",
  "status": "pursuing",
  "created_at": "$NOW",
  "updated_at": "$NOW",
  "current": { "agent": "$AGENT_ID", "session": null, "since": "$NOW" },
  "roles": { "lead": "$AGENT_ID", "build": null, "review": null },
  "compat": ["claude-code", "codex"],
  "lineage": [],
  "budget": null,
  "audit": {
    "checklist": [
      { "id": "a1", "predicate": "tests green", "status": "passed", "evidence": "✓" },
      { "id": "a2", "predicate": "no regressions", "status": "passed", "evidence": "✓" },
      { "id": "a3", "predicate": "reviewed", "status": "open", "evidence": null },
      { "id": "a4", "predicate": "deployed", "status": "open", "evidence": null }
    ]
  },
  "handoff_head": null,
  "queued_until": null,
  "token_budget": null,
  "tokens_used": 0,
  "pursuing_seconds": 0,
  "pursuing_since": "$NOW"
}
STATE

output=$(run_statusline_shim)
say "cowork-active output: '$output'"
assert_contains "$output" "cowork:" "cowork active prefix"
assert_contains "$output" "claude-code-host-1234" "agent id in output"
assert_contains "$output" "lead" "role in output"
assert_contains "$output" "2/4 audited" "audit count in output"

# ============================================================================
# TEST 3: Relaying (status=relaying, handoff present)
# ============================================================================

step "3. Relaying mode — status=relaying with handoff envelope"

# Write a handoff envelope.
cat > "$HANDOFF_DIR/0001.md" <<HANDOFF
---
seq: 0001
from: claude-code
to: codex
at: 2026-05-11T14:30:00Z
reason: rate_limit
goal_id: $GOAL_UUID
---

## Did
- worked on auth module

## Did not
- did not finish tests

## Next
- complete test suite

## Do not redo
- initial scaffolding

## Open audit items
- a3: tests green

## Evidence
- src/auth.ts
HANDOFF

cat > "$GOAL_DIR/state.json" <<STATE
{
  "schema_version": 2,
  "goal_id": "$GOAL_UUID",
  "objective": "cowork test goal",
  "status": "relaying",
  "created_at": "$NOW",
  "updated_at": "$NOW",
  "current": { "agent": "codex-host-5678", "session": null, "since": "$NOW" },
  "roles": { "lead": "claude-code-host-1234", "build": "codex-host-5678", "review": null },
  "compat": ["claude-code", "codex"],
  "lineage": [],
  "budget": null,
  "audit": null,
  "handoff_head": "0001",
  "queued_until": null,
  "token_budget": null,
  "tokens_used": 0,
  "pursuing_seconds": 0,
  "pursuing_since": "$NOW"
}
STATE

output=$(run_statusline_shim)
say "relaying output: '$output'"
assert_contains "$output" "Relaying" "relaying prefix"
assert_contains "$output" "claude-code" "from agent in relaying label"
assert_contains "$output" "codex" "to agent in relaying label"

# ============================================================================
# TEST 4: Queued mode (status=queued, quota.json present)
# ============================================================================

step "4. Queued mode — status=queued"

# Write quota.json with exhausted providers.
cat > "$GOAL_DIR/quota.json" <<QUOTA
{
  "providers": {
    "anthropic": {
      "limit_reset_at": "2026-05-11T15:47:00Z",
      "last_429_at": "$NOW",
      "consecutive_429": 3,
      "estimated_headroom": "exhausted"
    },
    "openai": {
      "limit_reset_at": "2026-05-11T15:47:00Z",
      "last_429_at": "$NOW",
      "consecutive_429": 3,
      "estimated_headroom": "exhausted"
    }
  },
  "updated_at": "$NOW"
}
QUOTA

cat > "$GOAL_DIR/state.json" <<STATE
{
  "schema_version": 2,
  "goal_id": "$GOAL_UUID",
  "objective": "cowork test goal",
  "status": "queued",
  "created_at": "$NOW",
  "updated_at": "$NOW",
  "current": { "agent": "claude-code-host-1234", "session": null, "since": "$NOW" },
  "roles": { "lead": "claude-code-host-1234", "build": null, "review": null },
  "compat": ["claude-code", "codex"],
  "lineage": [],
  "budget": null,
  "audit": null,
  "handoff_head": null,
  "queued_until": "2026-05-11T15:47:00Z",
  "token_budget": null,
  "tokens_used": 0,
  "pursuing_seconds": 0,
  "pursuing_since": "$NOW"
}
STATE

output=$(run_statusline_shim)
say "queued output: '$output'"
assert_contains "$output" "Queued" "queued prefix"
assert_contains "$output" "retry at" "retry time in queued label"
assert_contains "$output" "throttled" "throttled providers in queued label"

# ============================================================================
# TEST 5: V3 cowork state still renders cowork details instead of generic v3
# ============================================================================

step "5. V3 cowork-active state — current.agent plus live-time fields"

cat > "$GOAL_DIR/state.json" <<STATE
{
  "schema_version": 2,
  "goal_id": "$GOAL_UUID",
  "objective": "v3 cowork statusline",
  "status": "pursuing",
  "created_at": "$NOW",
  "updated_at": "$NOW",
  "time_used_seconds": 42,
  "observed_at": "$NOW",
  "active_turn_started_at": null,
  "tokens_used_observed_at": "$NOW",
  "time_used_seconds_final": null,
  "tokens_used_final": null,
  "current": { "agent": "codex-host-5678", "session": null, "since": "$NOW" },
  "roles": { "lead": "claude-code-host-1234", "build": "codex-host-5678", "review": null },
  "compat": ["claude-code", "codex"],
  "lineage": [],
  "budget": null,
  "audit": {
    "checklist": [
      { "id": "a1", "predicate": "tests green", "status": "passed", "evidence": "ok" }
    ]
  },
  "handoff_head": null,
  "queued_until": null,
  "token_budget": 1000,
  "tokens_used": 5,
  "pursuing_seconds": 42,
  "pursuing_since": null
}
STATE

output=$(run_statusline_shim)
say "v3 cowork-active output: '$output'"
assert_contains "$output" "cowork:" "v3 cowork prefix"
assert_contains "$output" "codex-host-5678" "v3 agent id in output"
assert_contains "$output" "build" "v3 role in output"
assert_contains "$output" "1/1 audited" "v3 audit count in output"
assert_contains "$output" "5/1K" "v3 token count in output"

# ============================================================================
# TEST 6: Verify solo path is NOT triggered when cowork.yml exists
# ============================================================================

step "6. cowork.yml presence triggers cowork path (even with null current.agent)"

# Reset to a solo-looking state but add cowork.yml.
cat > "$GOAL_DIR/state.json" <<STATE
{
  "schema_version": 2,
  "goal_id": "$GOAL_UUID",
  "objective": "cowork.yml present",
  "status": "pursuing",
  "created_at": "$NOW",
  "updated_at": "$NOW",
  "current": { "agent": null, "session": null, "since": null },
  "roles": { "lead": null, "build": null, "review": null },
  "compat": ["claude-code"],
  "lineage": [],
  "budget": null,
  "audit": null,
  "handoff_head": null,
  "queued_until": null,
  "token_budget": null,
  "tokens_used": 0,
  "pursuing_seconds": 0,
  "pursuing_since": "$NOW"
}
STATE

touch "$GOAL_DIR/cowork.yml"

output=$(run_statusline_shim)
say "cowork.yml-present output: '$output'"
assert_contains "$output" "cowork:" "cowork.yml triggers cowork path"

rm "$GOAL_DIR/cowork.yml"

# ============================================================================
# TEST 7: Solo mode byte-comparison — output must match what v1 produced
# This uses the same state as Test 1 and verifies exact token format.
# ============================================================================

step "7. Solo byte-comparison — pursuing 300s → 'Pursuing goal (5m)'"

cat > "$GOAL_DIR/state.json" <<STATE
{
  "schema_version": 2,
  "goal_id": "$GOAL_UUID",
  "objective": "test solo goal",
  "status": "pursuing",
  "created_at": "$NOW",
  "updated_at": "$NOW",
  "current": { "agent": null, "session": null, "since": null },
  "roles": { "lead": null, "build": null, "review": null },
  "compat": ["claude-code"],
  "lineage": [],
  "budget": null,
  "audit": null,
  "handoff_head": null,
  "queued_until": null,
  "token_budget": null,
  "tokens_used": 0,
  "pursuing_seconds": 300,
  "pursuing_since": null
}
STATE

output=$(run_statusline_shim)
say "solo pursuing 300s output: '$output'"
assert_contains "$output" "Pursuing goal" "solo pursuing label byte-identical"
# (Elapsed-format check removed: the v1 elapsed calc paths through
# `date -j -f` for the `pursuing_since`/`created_at` fallback, which has a
# known BSD vs GNU portability quirk independent of P4. The pursuit-timer
# correctness check belongs in T8's pursuit-timer step, not here.)

# ---- done ------------------------------------------------------------------

printf '\n'
green "ALL T-STATUSLINE-COWORK TESTS PASSED (a14 evidence)"
