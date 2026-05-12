#!/usr/bin/env bash
# scripts/smoke-phase-1-migration.sh
#
# T3: Migration smoke test.
#
# Verifies the v1 → v2 migration path:
#   1. Creates a v1 fixture (.claude/goal.json only, no .goal/).
#   2. Triggers migration via goalctl (which calls goalctl_migrate_if_needed).
#   3. Asserts:
#      - .goal/state.json exists and is valid JSON.
#      - schema_version == 2.
#      - lineage[0] is populated with agent="claude-code", model="unknown",
#        summary="migrated from v1".
#      - .claude/MIGRATED_TO_GOAL marker file exists.
#      - .claude/goal.json is still in place (v1 compat).
#   4. Re-runs goalctl status to confirm v2 state is readable.
#   5. Also tests GOAL_DISABLE_MIGRATION=1 escape hatch.
#
# Run from repo root:
#   ./scripts/smoke-phase-1-migration.sh
#
# Exit codes:
#   0  all checks passed
#   1+ specific check that failed

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

GOALCTL="$REPO_ROOT/bin/goalctl"
TMP=$(mktemp -d -t goal-migrate-smoke-XXXXXX)
trap 'rm -rf "$TMP"' EXIT

green() { printf '\033[32m%s\033[0m\n' "$*"; }
red()   { printf '\033[31m%s\033[0m\n' "$*"; }
say()   { printf '  %s\n' "$*"; }

step() {
    printf '\n[%s] %s\n' "$(date -u +%H:%M:%S)" "$1"
}

# ---- 1. Prereqs -------------------------------------------------------------

step "1. Prereqs"
command -v jq >/dev/null   || { red "FAIL: jq not installed"; exit 1; }
[ -x "$GOALCTL" ]          || { red "FAIL: $GOALCTL not executable"; exit 1; }
say "jq $(jq --version) ✓"

# ---- 2. Build v1 fixture ----------------------------------------------------

step "2. Build v1 fixture (.claude/goal.json only)"
mkdir -p "$TMP/.claude"
V1_ID=$(uuidgen 2>/dev/null | tr 'A-Z' 'a-z' || printf 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')
NOW=$(date -u +%FT%TZ)
cat > "$TMP/.claude/goal.json" <<FIXTURE
{
  "goal_id": "$V1_ID",
  "objective": "migration smoke test objective",
  "status": "pursuing",
  "created_at": "$NOW",
  "updated_at": "$NOW",
  "token_budget": null,
  "tokens_used": 42,
  "tick_count": 3,
  "pursuing_seconds": 120,
  "pursuing_since": "$NOW",
  "history": [
    {"ts": "$NOW", "action": "create", "note": "v1 fixture"}
  ]
}
FIXTURE
say "v1 fixture written: $TMP/.claude/goal.json"

# ---- 3. Confirm no .goal/ yet -----------------------------------------------

step "3. Confirm .goal/ does not exist before migration"
[ ! -d "$TMP/.goal" ] || { red "FAIL: .goal/ already exists before migration"; exit 2; }
say ".goal/ absent ✓"

# ---- 4. Trigger migration via goalctl status --------------------------------

step "4. Trigger migration via 'goalctl --root \$TMP status'"
"$GOALCTL" --root "$TMP" status >/dev/null

# ---- 5. Assert .goal/state.json exists and is valid JSON -------------------

step "5. Assert .goal/state.json exists and is valid JSON"
[ -f "$TMP/.goal/state.json" ] || {
    red "FAIL: .goal/state.json not created by migration"
    ls -la "$TMP/.goal/" 2>/dev/null || echo "(.goal/ dir missing)"
    exit 3
}
jq empty "$TMP/.goal/state.json" 2>/dev/null || {
    red "FAIL: .goal/state.json is not valid JSON"
    cat "$TMP/.goal/state.json"
    exit 3
}
say ".goal/state.json exists and valid ✓"

# ---- 6. Assert schema_version == 2 ------------------------------------------

step "6. Assert schema_version == 2"
SV=$(jq -r '.schema_version // "missing"' "$TMP/.goal/state.json")
[ "$SV" = "2" ] || { red "FAIL: schema_version expected 2, got '$SV'"; exit 4; }
say "schema_version=2 ✓"

# ---- 7. Assert lineage[0] is populated correctly ----------------------------

step "7. Assert lineage[0] is populated"
LINEAGE_AGENT=$(jq -r '.lineage[0].agent // "missing"' "$TMP/.goal/state.json")
LINEAGE_MODEL=$(jq -r '.lineage[0].model // "missing"' "$TMP/.goal/state.json")
LINEAGE_SUMMARY=$(jq -r '.lineage[0].summary // "missing"' "$TMP/.goal/state.json")
LINEAGE_TURNS=$(jq -r '.lineage[0].turns // "missing"' "$TMP/.goal/state.json")
LINEAGE_TOKENS=$(jq -r '.lineage[0].tokens // "missing"' "$TMP/.goal/state.json")

[ "$LINEAGE_AGENT" = "claude-code" ] || {
    red "FAIL: lineage[0].agent expected 'claude-code', got '$LINEAGE_AGENT'"
    exit 5
}
[ "$LINEAGE_MODEL" = "unknown" ] || {
    red "FAIL: lineage[0].model expected 'unknown', got '$LINEAGE_MODEL'"
    exit 5
}
[ "$LINEAGE_SUMMARY" = "migrated from v1" ] || {
    red "FAIL: lineage[0].summary expected 'migrated from v1', got '$LINEAGE_SUMMARY'"
    exit 5
}
[ "$LINEAGE_TURNS" = "3" ] || {
    red "FAIL: lineage[0].turns expected 3 (from tick_count), got '$LINEAGE_TURNS'"
    exit 5
}
[ "$LINEAGE_TOKENS" = "42" ] || {
    red "FAIL: lineage[0].tokens expected 42 (from tokens_used), got '$LINEAGE_TOKENS'"
    exit 5
}
say "lineage[0].agent=$LINEAGE_AGENT ✓"
say "lineage[0].model=$LINEAGE_MODEL ✓"
say "lineage[0].summary=$LINEAGE_SUMMARY ✓"
say "lineage[0].turns=$LINEAGE_TURNS ✓"
say "lineage[0].tokens=$LINEAGE_TOKENS ✓"

# ---- 8. Assert v3 live-time fields are populated -----------------------------

step "8. Assert v3 live-time fields populated"
for field in time_used_seconds observed_at active_turn_started_at tokens_used_observed_at; do
    VALUE=$(jq -r --arg field "$field" '.[$field] // "missing"' "$TMP/.goal/state.json")
    [ "$VALUE" != "missing" ] || {
        red "FAIL: migrated state missing $field"
        exit 6
    }
done
[ "$(jq -r '.time_used_seconds' "$TMP/.goal/state.json")" = "120" ] || {
    red "FAIL: time_used_seconds should preserve pursuing_seconds=120"
    exit 6
}
say "v3 live-time fields present ✓"

# ---- 9. Assert marker file present ------------------------------------------

step "9. Assert .claude/MIGRATED_TO_GOAL marker file present"
[ -f "$TMP/.claude/MIGRATED_TO_GOAL" ] || {
    red "FAIL: .claude/MIGRATED_TO_GOAL marker not written"
    exit 7
}
MARKER_CONTENT=$(cat "$TMP/.claude/MIGRATED_TO_GOAL")
[ -n "$MARKER_CONTENT" ] || { red "FAIL: marker file is empty"; exit 7; }
say "marker file: $MARKER_CONTENT ✓"

# ---- 10. Assert .claude/goal.json still present (v1 compat) -----------------

step "10. Assert .claude/goal.json still in place (v1 compat)"
[ -f "$TMP/.claude/goal.json" ] || {
    red "FAIL: .claude/goal.json was deleted after migration (must be kept per §12)"
    exit 8
}
say ".claude/goal.json still present ✓"

# ---- 11. goalctl status reads v2 file correctly -----------------------------

step "11. goalctl status reads v2 goal correctly"
STATUS_JSON=$("$GOALCTL" --root "$TMP" status --json)
OBJ=$(printf '%s' "$STATUS_JSON" | jq -r '.objective // "missing"')
STAT=$(printf '%s' "$STATUS_JSON" | jq -r '.status // "missing"')
[ "$OBJ" = "migration smoke test objective" ] || {
    red "FAIL: status --json objective mismatch: '$OBJ'"
    exit 9
}
[ "$STAT" = "pursuing" ] || {
    red "FAIL: status --json status mismatch: '$STAT'"
    exit 9
}
say "status --json objective='$OBJ' ✓"
say "status --json status='$STAT' ✓"

# ---- 12. goal_id preserved across migration ---------------------------------

step "12. Assert goal_id preserved after migration"
MIGRATED_ID=$(jq -r '.goal_id' "$TMP/.goal/state.json")
[ "$MIGRATED_ID" = "$V1_ID" ] || {
    red "FAIL: goal_id changed during migration (expected $V1_ID, got $MIGRATED_ID)"
    exit 10
}
say "goal_id=$MIGRATED_ID (preserved) ✓"

# ---- 13. GOAL_DISABLE_MIGRATION=1 escape hatch ------------------------------

step "13. Test GOAL_DISABLE_MIGRATION=1 escape hatch"
TMP2=$(mktemp -d -t goal-migrate-smoke-disable-XXXXXX)
trap 'rm -rf "$TMP" "$TMP2"' EXIT
mkdir -p "$TMP2/.claude"
V1_ID2=$(uuidgen 2>/dev/null | tr 'A-Z' 'a-z' || printf 'ffffffff-ffff-ffff-ffff-ffffffffffff')
NOW2=$(date -u +%FT%TZ)
cat > "$TMP2/.claude/goal.json" <<FIXTURE2
{
  "goal_id": "$V1_ID2",
  "objective": "disable migration test",
  "status": "pursuing",
  "created_at": "$NOW2",
  "updated_at": "$NOW2",
  "token_budget": null,
  "tokens_used": 0,
  "tick_count": 0,
  "pursuing_seconds": 0,
  "pursuing_since": "$NOW2",
  "history": []
}
FIXTURE2

GOAL_DISABLE_MIGRATION=1 "$GOALCTL" --root "$TMP2" status --json >/dev/null || {
    red "FAIL: goalctl status failed with GOAL_DISABLE_MIGRATION=1"
    exit 11
}
if [ -d "$TMP2/.goal" ]; then
    red "FAIL: GOAL_DISABLE_MIGRATION=1 should have prevented .goal/ creation"
    exit 11
fi
say "GOAL_DISABLE_MIGRATION=1: .goal/ not created ✓"

# ---- 14. MCP server sees v2 state after migration ---------------------------

step "14. MCP server reads v2 state (tools/list + get_goal)"
export GOAL_ROOT="$TMP"
MCP_OUT=$(
  printf '%s\n%s\n' \
    '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}' \
    '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_goal","arguments":{}}}' \
  | (node "$REPO_ROOT/mcp/dist/goal-server.js" 2>/dev/null \
     || npx --prefix "$REPO_ROOT/mcp" tsx "$REPO_ROOT/mcp/goal-server.ts" 2>/dev/null)
)
printf '%s' "$MCP_OUT" | grep -q "migration smoke test objective" || {
    red "FAIL: MCP get_goal didn't return the migrated objective"
    printf '%s\n' "$MCP_OUT" | head -20
    exit 12
}
say "MCP get_goal reads migrated v2 state ✓"

green "ALL MIGRATION SMOKE CHECKS PASSED"
