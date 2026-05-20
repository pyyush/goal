#!/usr/bin/env bash
# cowork/bridge/test/test-lanes.sh — T6: Lane lease tests (P5)
#
# Audit item: a8 — Lane lease tests T6 pass.
#
# Tests:
#   1. TTL expiry releases lease (lazy prune on next read).
#   2. Stale heartbeat releases lease (holder's heartbeat older than GOAL_HEARTBEAT_TTL_MS).
#   3. Renewal extends TTL (same holder, same glob → updates acquired_at).
#   4. Conflict detection: two different holders on overlapping globs.
#   5. Non-overlapping globs don't conflict.
#
# Run from repo root: ./cowork/bridge/test/test-lanes.sh
# Exit codes: 0 = pass, 1 = fail.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
GOALCTL="$REPO_ROOT/bin/goalctl"

green() { printf '\033[32m%s\033[0m\n' "$*"; }
red()   { printf '\033[31m%s\033[0m\n' "$*"; }
say()   { printf '  %s\n' "$*"; }
step()  { printf '\n[%s] %s\n' "$(date -u +%H:%M:%S)" "$1"; }

TMP=""
cleanup() { [ -n "$TMP" ] && rm -rf "$TMP" || true; }
trap cleanup EXIT

fail() {
    red "FAIL [T6-lanes]: $*"
    [ -n "${TMP:-}" ] && [ -f "$TMP/.goal/lanes.json" ] && \
        printf '\n--- lanes.json ---\n' && cat "$TMP/.goal/lanes.json" || true
    exit 1
}

# ---- prereqs ----------------------------------------------------------------

step "0. Prereqs"
command -v node >/dev/null || fail "node not installed"
command -v jq   >/dev/null || fail "jq not installed"
say "node $(node --version) · jq $(jq --version) ✓"

# ---- setup ------------------------------------------------------------------

TMP=$(mktemp -d -t goal-lanes-test-XXXXXX)
GOAL_DIR="$TMP/.goal"
AGENTS_DIR="$GOAL_DIR/agents"
mkdir -p "$GOAL_DIR/goals" "$GOAL_DIR/handoff" "$AGENTS_DIR"

# Write a minimal v3 goal record so goalctl resolves root.
NOW=$(date -u +%FT%TZ)
GOAL_UUID="aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
STATE_FILE="$GOAL_DIR/goals/$GOAL_UUID.json"
cat > "$STATE_FILE.tmp" <<EOF
{
  "schema_version": 2,
  "goal_id": "$GOAL_UUID",
  "objective": "lane test",
  "status": "pursuing",
  "created_at": "$NOW",
  "updated_at": "$NOW",
  "current": { "agent": null, "session": null, "since": null },
  "compat": ["claude-code"],
  "roles": { "lead": null, "build": null, "review": null },
  "lineage": [],
  "budget": null,
  "audit": null,
  "handoff_head": null,
  "queued_until": null,
  "token_budget": null,
  "tokens_used": 0,
  "tick_count": 0,
  "pursuing_seconds": 0,
  "pursuing_since": "$NOW",
  "history": []
}
EOF
mv "$STATE_FILE.tmp" "$STATE_FILE"

# Node claim script (shared with concurrency test).
CLAIM_SCRIPT="$TMP/claim-lane.mjs"
cat > "$CLAIM_SCRIPT" <<'NODEJS'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, renameSync, rmdirSync, readdirSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { randomUUID } from 'crypto';

const [,, goalDir, glob, holder, ttl] = process.argv;
const lanesFile = join(goalDir, 'lanes.json');
const lockDir = join(goalDir, 'lock');
const agentsDir = join(goalDir, 'agents');
// Heartbeat TTL: default 15000ms. Check GOAL_HEARTBEAT_TTL_MS env.
const HB_TTL_MS = parseInt(process.env.GOAL_HEARTBEAT_TTL_MS || '15000', 10);

const deadline = Date.now() + 5000;
let lockAcquired = false;
while (Date.now() < deadline) {
  try { mkdirSync(lockDir, { recursive: false }); lockAcquired = true; break; }
  catch (e) {
    if (e.code !== 'EEXIST') { process.exit(2); }
    await new Promise(r => setTimeout(r, 20 + Math.random() * 30));
  }
}
if (!lockAcquired) { process.stderr.write('lock timeout\n'); process.exit(1); }

// Glob-to-regex: char-by-char to avoid substitution-order bugs.
function globToRE(g) {
  let p = '^';
  let i = 0;
  while (i < g.length) {
    const ch = g[i];
    if (ch === '*') {
      if (g[i+1] === '*') { p += '.*'; i += 2; if (g[i] === '/') i++; }
      else { p += '[^/]*'; i++; }
    } else if (ch === '?') { p += '[^/]'; i++; }
    else if (/[.+^${}()|[\]\\]/.test(ch)) { p += '\\' + ch; i++; }
    else { p += ch; i++; }
  }
  p += '$';
  return new RegExp(p);
}
function sample(g) {
  return g.replace(/\*\*\//g,'a/b/').replace(/\*\*/g,'a/b').replace(/\*/g,'x').replace(/\?/g,'y');
}

// Check if a holder's heartbeat is stale.
function isHolderHeartbeatStale(holderName) {
  try {
    // Look for <holderName>.json in agents dir.
    const hbFile = join(agentsDir, `${holderName}.json`);
    const hb = JSON.parse(readFileSync(hbFile, 'utf8'));
    const hbAt = hb.heartbeat_at ? Date.parse(hb.heartbeat_at) : NaN;
    if (Number.isFinite(hbAt) && Date.now() - hbAt > HB_TTL_MS) return true;
    return false;
  } catch (_) {
    return false; // No heartbeat file = unknown; don't evict.
  }
}

let result = null;

try {
  let data;
  try { data = JSON.parse(readFileSync(lanesFile, 'utf8')); }
  catch (_) { data = { leases: [] }; }
  if (!data.leases) data.leases = [];

  // Prune: TTL-expired leases AND stale-heartbeat leases.
  const now = Date.now();
  data.leases = data.leases.filter(l => {
    // TTL expiry.
    const acq = Date.parse(l.acquired_at);
    if (Number.isFinite(acq) && now - acq > l.ttl_seconds * 1000) return false;
    // Stale heartbeat eviction.
    if (isHolderHeartbeatStale(l.holder)) return false;
    return true;
  });

  // Check for same-holder renewal (same holder AND same glob).
  const existing = data.leases.find(l => l.holder === holder && l.glob === glob);
  if (existing) {
    existing.acquired_at = new Date().toISOString().replace(/\.\d{3}Z$/,'Z');
    existing.ttl_seconds = parseInt(ttl||'600',10);
    const dir = dirname(lanesFile);
    const tmpDir = mkdtempSync(join(dir, '.tmp-lanes-'));
    const tmp = join(tmpDir, 'lanes.json');
    writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
    renameSync(tmp, lanesFile);
    try { rmdirSync(tmpDir); } catch(_) {}
    result = JSON.stringify({ ok: true, lease_id: existing.lease_id, renewed: true });
  } else {
    // Conflict check.
    const reA = globToRE(glob);
    const sA = sample(glob);
    let conflictLease = null;
    for (const l of data.leases) {
      if (l.holder === holder) continue;
      const sB = sample(l.glob);
      const reB = globToRE(l.glob);
      if (reA.test(sB) || reB.test(sA)) { conflictLease = l; break; }
    }

    if (conflictLease) {
      result = JSON.stringify({ ok: false, conflict_with: conflictLease.lease_id });
    } else {
      const leaseId = randomUUID();
      data.leases.push({ lease_id: leaseId, glob, holder, acquired_at: new Date().toISOString().replace(/\.\d{3}Z$/,'Z'), ttl_seconds: parseInt(ttl||'600',10), reason: 'test' });
      const dir = dirname(lanesFile);
      const tmpDir = mkdtempSync(join(dir, '.tmp-lanes-'));
      const tmp = join(tmpDir, 'lanes.json');
      writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
      renameSync(tmp, lanesFile);
      try { rmdirSync(tmpDir); } catch(_) {}
      result = JSON.stringify({ ok: true, lease_id: leaseId });
    }
  }
} finally {
  // Always release lock (process.exit inside try skips finally in Node.js).
  try { rmdirSync(lockDir); } catch (_) {}
}

// Write result after lock is released.
process.stdout.write(result + '\n');
NODEJS

# Helper: initialize lanes.json.
init_lanes() { printf '{"leases":[]}\n' > "$GOAL_DIR/lanes.json"; }

# Helper: set a lease with custom acquired_at (for TTL test).
write_lease_with_age() {
    local _glob="$1" _holder="$2" _ttl="$3" _age_s="$4"
    local _lease_id
    _lease_id=$(node -e "const {randomUUID}=require('crypto');process.stdout.write(randomUUID())")
    local _acquired_at
    _acquired_at=$(node -e "process.stdout.write(new Date(Date.now() - ${_age_s}*1000).toISOString().replace(/\\.\\d{3}Z\$/,'Z'))")
    jq --arg lid "$_lease_id" --arg glob "$_glob" --arg holder "$_holder" \
       --argjson ttl "$_ttl" --arg acq "$_acquired_at" \
       '.leases += [{ lease_id: $lid, glob: $glob, holder: $holder, acquired_at: $acq, ttl_seconds: $ttl, reason: "test" }]' \
       "$GOAL_DIR/lanes.json" > "$GOAL_DIR/lanes.json.tmp" && \
       mv "$GOAL_DIR/lanes.json.tmp" "$GOAL_DIR/lanes.json"
    printf '%s' "$_lease_id"
}

# ============================================================================
# TEST 1: TTL expiry — lease with TTL=1s, age=2s should be pruned on next read
# ============================================================================

step "1. TTL expiry: lease with ttl=1s and age=2s is pruned on next claim attempt"

init_lanes
EXPIRED_ID=$(write_lease_with_age "src/auth/**" "agent-a" "1" "2")
say "Written expired lease: $EXPIRED_ID (ttl=1s, age=2s)"

# Verify it's present before pruning.
PRE_COUNT=$(jq '.leases | length' "$GOAL_DIR/lanes.json")
[ "$PRE_COUNT" -eq 1 ] || fail "Expected 1 lease before prune, got $PRE_COUNT"

# Now attempt to claim the same glob from a different holder — should succeed
# (prune first, then claim).
CLAIM1=$(node "$CLAIM_SCRIPT" "$GOAL_DIR" "src/auth/**" "agent-b" "600" 2>/dev/null)
CLAIM1_OK=$(printf '%s' "$CLAIM1" | jq -r '.ok') || fail "claim result not JSON"
[ "$CLAIM1_OK" = "true" ] || fail "Claim should succeed after TTL expiry, got: $CLAIM1"
say "Claim succeeded after TTL expiry ✓ (expired lease pruned)"

POST_COUNT=$(jq '.leases | length' "$GOAL_DIR/lanes.json")
[ "$POST_COUNT" -eq 1 ] || fail "Expected 1 lease (new one) after prune+claim, got $POST_COUNT"
REMAINING_ID=$(jq -r '.leases[0].lease_id' "$GOAL_DIR/lanes.json")
[ "$REMAINING_ID" != "$EXPIRED_ID" ] || fail "Old expired lease was not replaced"
say "Old lease pruned, new lease present ✓"

# ============================================================================
# TEST 2: Stale heartbeat — lease holder's heartbeat > GOAL_HEARTBEAT_TTL_MS
# ============================================================================

step "2. Stale heartbeat: lease evicted when holder heartbeat is stale"

init_lanes

# Write a lease for agent-stale.
STALE_ID=$(write_lease_with_age "src/stale/**" "agent-stale" "600" "0")
say "Written lease for agent-stale: $STALE_ID"

# Write a STALE heartbeat for agent-stale (older than 15s default TTL).
mkdir -p "$AGENTS_DIR"
STALE_HB=$(node -e "process.stdout.write(new Date(Date.now() - 20000).toISOString().replace(/\\.\\d{3}Z\$/,'Z'))")
printf '{"agent_id":"agent-stale","runner":"mock","pid":9999,"session":null,"role":null,"started_at":"%s","heartbeat_at":"%s"}\n' \
    "$NOW" "$STALE_HB" > "$AGENTS_DIR/agent-stale.json"
say "Wrote stale heartbeat for agent-stale (age=20s > default 15s TTL)"

# Try to claim the same glob from a different agent with short heartbeat TTL.
CLAIM2=$(GOAL_HEARTBEAT_TTL_MS=15000 node "$CLAIM_SCRIPT" "$GOAL_DIR" "src/stale/**" "agent-fresh" "600" 2>/dev/null)
CLAIM2_OK=$(printf '%s' "$CLAIM2" | jq -r '.ok') || fail "claim2 result not JSON"
[ "$CLAIM2_OK" = "true" ] || fail "Claim should succeed after stale heartbeat eviction, got: $CLAIM2"
say "Claim succeeded after stale heartbeat eviction ✓"

REMAINING_ID2=$(jq -r '.leases[0].lease_id' "$GOAL_DIR/lanes.json")
[ "$REMAINING_ID2" != "$STALE_ID" ] || fail "Stale lease was not evicted"
say "Stale lease evicted, new lease for agent-fresh ✓"

# ============================================================================
# TEST 3: Renewal — same holder, same glob updates acquired_at
# ============================================================================

step "3. Renewal: same holder+glob extends acquired_at"

init_lanes

# Initial claim.
CLAIM3=$(node "$CLAIM_SCRIPT" "$GOAL_DIR" "src/renew/**" "agent-renew" "60" 2>/dev/null)
CLAIM3_OK=$(printf '%s' "$CLAIM3" | jq -r '.ok')
[ "$CLAIM3_OK" = "true" ] || fail "Initial claim failed: $CLAIM3"
ORIG_LEASE=$(printf '%s' "$CLAIM3" | jq -r '.lease_id')
ORIG_ACQ=$(jq -r '.leases[0].acquired_at' "$GOAL_DIR/lanes.json")
say "Initial claim: lease=$ORIG_LEASE acquired_at=$ORIG_ACQ"

# Brief pause so time progresses.
sleep 1

# Renewal claim (same holder+glob, longer TTL).
CLAIM3B=$(node "$CLAIM_SCRIPT" "$GOAL_DIR" "src/renew/**" "agent-renew" "600" 2>/dev/null)
CLAIM3B_OK=$(printf '%s' "$CLAIM3B" | jq -r '.ok')
CLAIM3B_RENEWED=$(printf '%s' "$CLAIM3B" | jq -r '.renewed // false')
[ "$CLAIM3B_OK" = "true" ] || fail "Renewal claim failed: $CLAIM3B"
# Verify same lease_id (renewal, not new).
RENEWED_LEASE=$(printf '%s' "$CLAIM3B" | jq -r '.lease_id')
[ "$RENEWED_LEASE" = "$ORIG_LEASE" ] || fail "Renewal should return same lease_id (got $RENEWED_LEASE vs $ORIG_LEASE)"
say "Renewal returned same lease_id ✓"

# Verify acquired_at changed.
NEW_ACQ=$(jq -r '.leases[0].acquired_at' "$GOAL_DIR/lanes.json")
[ "$NEW_ACQ" != "$ORIG_ACQ" ] || fail "Renewal should update acquired_at (still: $ORIG_ACQ)"
say "Renewal updated acquired_at: $ORIG_ACQ → $NEW_ACQ ✓"

# Verify TTL extended.
NEW_TTL=$(jq -r '.leases[0].ttl_seconds' "$GOAL_DIR/lanes.json")
[ "$NEW_TTL" -eq 600 ] || fail "Renewal should update ttl_seconds to 600 (got $NEW_TTL)"
say "TTL extended to 600s ✓"

# Still only 1 lease.
LEASE_COUNT3=$(jq '.leases | length' "$GOAL_DIR/lanes.json")
[ "$LEASE_COUNT3" -eq 1 ] || fail "Renewal should not add duplicate lease (got $LEASE_COUNT3)"
say "No duplicate lease after renewal ✓"

# ============================================================================
# TEST 4: Conflict detection — different holders, overlapping globs
# ============================================================================

step "4. Conflict: different holders, overlapping globs"

init_lanes

# agent-x claims src/shared/**
CLAIM4A=$(node "$CLAIM_SCRIPT" "$GOAL_DIR" "src/shared/**" "agent-x" "600" 2>/dev/null)
[ "$(printf '%s' "$CLAIM4A" | jq -r '.ok')" = "true" ] || fail "First claim failed: $CLAIM4A"
say "agent-x claimed src/shared/** ✓"

# agent-y tries src/shared/module.ts (subset of src/shared/**) — should conflict.
CLAIM4B=$(node "$CLAIM_SCRIPT" "$GOAL_DIR" "src/shared/module.ts" "agent-y" "600" 2>/dev/null)
CLAIM4B_OK=$(printf '%s' "$CLAIM4B" | jq -r '.ok')
[ "$CLAIM4B_OK" = "false" ] || fail "Overlapping glob should conflict (got ok=true): $CLAIM4B"
CONFLICT_ID=$(printf '%s' "$CLAIM4B" | jq -r '.conflict_with')
[ -n "$CONFLICT_ID" ] || fail "conflict_with should be set"
say "Correctly detected conflict ✓ (conflict_with=$CONFLICT_ID)"

# ============================================================================
# TEST 5: Non-overlapping globs don't conflict
# ============================================================================

step "5. Non-conflict: different holders, non-overlapping globs"

init_lanes

# agent-m claims src/auth/**
CLAIM5A=$(node "$CLAIM_SCRIPT" "$GOAL_DIR" "src/auth/**" "agent-m" "600" 2>/dev/null)
[ "$(printf '%s' "$CLAIM5A" | jq -r '.ok')" = "true" ] || fail "Claim 5A failed: $CLAIM5A"

# agent-n claims src/billing/** (non-overlapping)
CLAIM5B=$(node "$CLAIM_SCRIPT" "$GOAL_DIR" "src/billing/**" "agent-n" "600" 2>/dev/null)
CLAIM5B_OK=$(printf '%s' "$CLAIM5B" | jq -r '.ok')
[ "$CLAIM5B_OK" = "true" ] || fail "Non-overlapping glob should succeed (got: $CLAIM5B)"
say "Non-overlapping globs: both claims succeed ✓"

LEASE_COUNT5=$(jq '.leases | length' "$GOAL_DIR/lanes.json")
[ "$LEASE_COUNT5" -eq 2 ] || fail "Expected 2 leases for non-overlapping, got $LEASE_COUNT5"
say "2 leases in lanes.json ✓"

# ============================================================================
# TEST 6: goalctl lanes and lanes release integration
# ============================================================================

step "6. goalctl lanes and lanes release integration"

init_lanes
CLAIM6=$(node "$CLAIM_SCRIPT" "$GOAL_DIR" "src/integration/**" "agent-int" "600" 2>/dev/null)
CLAIM6_ID=$(printf '%s' "$CLAIM6" | jq -r '.lease_id')
[ -n "$CLAIM6_ID" ] || fail "Claim 6 failed"

# goalctl lanes should show it.
LIST_OUT=$("$GOALCTL" --root "$TMP" lanes --json 2>/dev/null)
LIST_COUNT=$(jq '.leases | length' <<<"$LIST_OUT")
[ "$LIST_COUNT" -eq 1 ] || fail "goalctl lanes should show 1 lease, got $LIST_COUNT"
say "goalctl lanes shows 1 lease ✓"

# goalctl lanes release.
RELEASE_OUT=$("$GOALCTL" --root "$TMP" lanes release "$CLAIM6_ID" --json 2>/dev/null)
RELEASE_OK=$(jq -r '.ok' <<<"$RELEASE_OUT")
[ "$RELEASE_OK" = "true" ] || fail "goalctl lanes release failed: $RELEASE_OUT"
say "goalctl lanes release succeeded ✓"

FINAL_COUNT=$(jq '.leases | length' "$GOAL_DIR/lanes.json")
[ "$FINAL_COUNT" -eq 0 ] || fail "Expected 0 leases after release, got $FINAL_COUNT"
say "Lane released, 0 leases remaining ✓"

printf '\n'
green "ALL T6 LANE LEASE TESTS PASSED (a8 evidence)"
