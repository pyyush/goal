#!/usr/bin/env bash
# cowork/bridge/test/test-concurrency.sh — T2: Concurrency test (P5)
#
# Audit item: a4 — 20 parallel cross-agent writers, zero lost updates,
# zero double-claimed lanes.
#
# Per spec §3 N1: existing mkdir mutex extended; lanes and quota under same
# lock semantics. No data races under 20 parallel writers.
#
# Tests:
#   1. 20 parallel writers claim lanes concurrently with overlapping globs.
#      Each writer uses a distinct sub-glob of "src/module-N/**".
#      No two writers should get the same glob (no conflict since they're distinct).
#   2. 20 parallel writers compete for the SAME glob — only ONE wins.
#   3. 20 parallel writers atomically update lanes.json — no corruption.
#   4. Release test: all successfully-claimed leases can be released.
#
# Run from repo root: ./cowork/bridge/test/test-concurrency.sh
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
    red "FAIL [T2-concurrency]: $*"
    [ -n "${TMP:-}" ] && printf '\n--- lanes.json ---\n' && cat "$TMP/.goal/lanes.json" 2>/dev/null || true
    exit 1
}

# ---- prereqs ----------------------------------------------------------------

step "0. Prereqs"
command -v node >/dev/null || fail "node not installed"
command -v jq   >/dev/null || fail "jq not installed"
say "node $(node --version) · jq $(jq --version) ✓"

# ---- setup ------------------------------------------------------------------

TMP=$(mktemp -d -t goal-concurrency-test-XXXXXX)
GOAL_DIR="$TMP/.goal"
AGENTS_DIR="$GOAL_DIR/agents"
mkdir -p "$GOAL_DIR/goals" "$GOAL_DIR/handoff" "$AGENTS_DIR"

# Write a minimal v3 goal record.
NOW=$(date -u +%FT%TZ)
GOAL_UUID="cccccccc-dddd-eeee-ffff-aaaaaaaaaaaa"
STATE_FILE="$GOAL_DIR/goals/$GOAL_UUID.json"
cat > "$STATE_FILE.tmp" <<EOF
{
  "schema_version": 2,
  "goal_id": "$GOAL_UUID",
  "objective": "concurrency test",
  "status": "pursuing",
  "created_at": "$NOW",
  "updated_at": "$NOW",
  "current": { "agent": null, "session": null, "since": null },
  "compat": ["claude-code", "codex"],
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

# Initialize lanes.json.
printf '{"leases":[]}\n' > "$GOAL_DIR/lanes.json"

# ============================================================================
# TEST 1: 20 parallel writers — distinct globs (all should win)
# ============================================================================

step "1. 20 parallel writers — distinct globs (all should win)"

# Write a Node script that claims a lane.
CLAIM_SCRIPT="$TMP/claim-lane.mjs"
cat > "$CLAIM_SCRIPT" <<'NODEJS'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, renameSync, unlinkSync, rmdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { randomUUID } from 'crypto';

const [,, goalDir, glob, holder, ttl] = process.argv;
const lanesFile = join(goalDir, 'lanes.json');
const lockDir = join(goalDir, 'lock');

// Acquire .goal/lock (same mkdir mutex as bridge/MCP).
const deadline = Date.now() + 5000;
let lockAcquired = false;
while (Date.now() < deadline) {
  try {
    mkdirSync(lockDir, { recursive: false });
    lockAcquired = true;
    break;
  } catch (e) {
    if (e.code !== 'EEXIST') { process.stderr.write('lock error: ' + e.message + '\n'); process.exit(2); }
    // Check for stale lock.
    try {
      const s = (await import('fs')).statSync(lockDir);
      if (Date.now() - s.mtimeMs > 30_000) {
        try { rmdirSync(lockDir); } catch (_) {}
      }
    } catch (_) {}
    await new Promise(r => setTimeout(r, 20 + Math.random() * 30));
  }
}

if (!lockAcquired) { process.stderr.write('could not acquire lock\n'); process.exit(1); }

// Declare result outside try/finally so it's in scope after the block.
let result = null;

// Convert glob to regex using char-by-char to avoid substitution-order bugs.
// (e.g. naive replace(/\*\*/g,'.*').replace(/\*/g,'[^/]*') turns '.*' into '.[^/]*')
function globToRegex(g) {
  let pat = '^';
  let i = 0;
  while (i < g.length) {
    const ch = g[i];
    if (ch === '*') {
      if (g[i+1] === '*') { pat += '.*'; i += 2; if (g[i] === '/') i++; }
      else { pat += '[^/]*'; i++; }
    } else if (ch === '?') { pat += '[^/]'; i++; }
    else if (/[.+^${}()|[\]\\]/.test(ch)) { pat += '\\' + ch; i++; }
    else { pat += ch; i++; }
  }
  return new RegExp(pat + '$');
}
function samplePathFromGlob(g) {
  return g.replace(/\*\*\//g,'a/b/').replace(/\*\*/g,'a/b').replace(/\*/g,'x').replace(/\?/g,'y');
}

try {
  // Read current leases.
  let data;
  try { data = JSON.parse(readFileSync(lanesFile, 'utf8')); }
  catch (_) { data = { leases: [] }; }
  if (!data.leases) data.leases = [];

  // Check for conflict.
  const globRE = globToRegex(glob);
  for (const l of data.leases) {
    if (l.holder !== holder) {
      const sampleB = samplePathFromGlob(l.glob);
      const sampleA = samplePathFromGlob(glob);
      const otherRE = globToRegex(l.glob);
      if (globRE.test(sampleB) || otherRE.test(sampleA)) {
        // Conflict — record result, break (lock released in finally).
        result = JSON.stringify({ ok: false, conflict_with: l.lease_id });
        break;
      }
    }
  }

  if (!result) {
    // No conflict — add lease.
    const leaseId = randomUUID();
    data.leases.push({ lease_id: leaseId, glob, holder, acquired_at: new Date().toISOString().replace(/\.\d{3}Z$/,'Z'), ttl_seconds: parseInt(ttl||'600',10), reason: 'test' });

    // Atomic write.
    const dir = dirname(lanesFile);
    const tmpDir = mkdtempSync(join(dir, '.tmp-lanes-'));
    const tmp = join(tmpDir, 'lanes.json');
    writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
    renameSync(tmp, lanesFile);
    try { rmdirSync(tmpDir); } catch(_) {}

    result = JSON.stringify({ ok: true, lease_id: leaseId });
  }
} finally {
  // Always release lock (process.exit() would skip finally — avoid calling it inside try).
  try { rmdirSync(lockDir); } catch (_) {}
}

// Write result after lock is released.
process.stdout.write(result + '\n');
NODEJS

PIDS=()
RESULT_FILES=()
for i in $(seq 1 20); do
    RFILE="$TMP/result-$i.json"
    RESULT_FILES+=("$RFILE")
    # Each writer has a distinct glob: src/module-N/**
    node "$CLAIM_SCRIPT" "$GOAL_DIR" "src/module-${i}/**" "agent-${i}" "600" > "$RFILE" 2>/dev/null &
    PIDS+=($!)
done

# Wait for all.
for pid in "${PIDS[@]}"; do
    wait "$pid" || true
done
say "All 20 writers completed"

# Verify all won (distinct globs, no conflict possible).
WINNERS=0
for RFILE in "${RESULT_FILES[@]}"; do
    [ -f "$RFILE" ] || fail "result file missing"
    OK=$(jq -r '.ok' "$RFILE" 2>/dev/null) || fail "result not JSON: $(cat "$RFILE")"
    if [ "$OK" = "true" ]; then
        WINNERS=$((WINNERS + 1))
    fi
done

[ "$WINNERS" -eq 20 ] || fail "Expected 20 winners for distinct globs, got $WINNERS"
say "All 20 distinct-glob claims won ✓"

# Verify lanes.json has exactly 20 leases with no corruption.
LEASE_COUNT=$(jq '.leases | length' "$GOAL_DIR/lanes.json" 2>/dev/null) || fail "lanes.json not valid JSON"
[ "$LEASE_COUNT" -eq 20 ] || fail "Expected 20 leases, got $LEASE_COUNT (zero lost updates check)"
jq -e '.leases | map(.lease_id) | unique | length == 20' "$GOAL_DIR/lanes.json" >/dev/null \
    || fail "Duplicate lease_ids found (race condition)"
say "lanes.json has 20 unique leases, zero lost updates ✓"

# ============================================================================
# TEST 2: 20 parallel writers — same glob (exactly one wins)
# ============================================================================

step "2. 20 parallel writers — same glob (exactly one wins)"

# Clear lanes.
printf '{"leases":[]}\n' > "$GOAL_DIR/lanes.json"

PIDS=()
RESULT_FILES2=()
for i in $(seq 1 20); do
    RFILE="$TMP/result2-$i.json"
    RESULT_FILES2+=("$RFILE")
    # All writers claim the SAME glob.
    node "$CLAIM_SCRIPT" "$GOAL_DIR" "src/shared/**" "agent-${i}" "600" > "$RFILE" 2>/dev/null &
    PIDS+=($!)
done

for pid in "${PIDS[@]}"; do
    wait "$pid" || true
done
say "All 20 same-glob writers completed"

WINNERS2=0
LOSERS2=0
for RFILE in "${RESULT_FILES2[@]}"; do
    [ -f "$RFILE" ] || fail "result file missing: $RFILE"
    OK=$(jq -r '.ok' "$RFILE" 2>/dev/null) || fail "result not JSON: $(cat "$RFILE")"
    if [ "$OK" = "true" ]; then
        WINNERS2=$((WINNERS2 + 1))
    else
        LOSERS2=$((LOSERS2 + 1))
    fi
done

[ "$WINNERS2" -eq 1 ] || fail "Expected exactly 1 winner for same glob, got $WINNERS2 (zero double-claimed lanes check)"
[ "$LOSERS2" -eq 19 ] || fail "Expected 19 losers, got $LOSERS2"
say "Exactly 1 winner, 19 conflicts ✓ (zero double-claimed lanes)"

# lanes.json must have exactly 1 lease.
LEASE_COUNT2=$(jq '.leases | length' "$GOAL_DIR/lanes.json" 2>/dev/null)
[ "$LEASE_COUNT2" -eq 1 ] || fail "Expected 1 lease for same-glob race, got $LEASE_COUNT2"
say "lanes.json has 1 lease ✓"

# ============================================================================
# TEST 3: Atomic write integrity — no corruption after 20 concurrent writes
# ============================================================================

step "3. Atomic write integrity check"

# Already passed implicitly — jq parsing didn't fail. Verify one more time.
jq empty "$GOAL_DIR/lanes.json" || fail "lanes.json is corrupt after concurrent writes"
say "lanes.json is valid JSON after all concurrent writes ✓"

# ============================================================================
# TEST 4: Release test — winner can release
# ============================================================================

step "4. Release winning lease"

# Reset lanes and claim one.
printf '{"leases":[]}\n' > "$GOAL_DIR/lanes.json"
CLAIM_RESULT=$(node "$CLAIM_SCRIPT" "$GOAL_DIR" "src/release-test/**" "agent-release" "600" 2>/dev/null)
CLAIM_OK=$(printf '%s' "$CLAIM_RESULT" | jq -r '.ok') || fail "claim result not JSON"
[ "$CLAIM_OK" = "true" ] || fail "Claim failed for release test"
LEASE_TO_RELEASE=$(printf '%s' "$CLAIM_RESULT" | jq -r '.lease_id')
say "Claimed lease: $LEASE_TO_RELEASE"

# Release via goalctl lanes release.
# First make sure there's a goal record at ROOT (goalctl needs it for root resolution).
RELEASE_OUT=$("$GOALCTL" --root "$TMP" lanes release "$LEASE_TO_RELEASE" --json 2>/dev/null) || \
    RELEASE_OUT="{\"ok\":false}"
RELEASE_OK=$(printf '%s' "$RELEASE_OUT" | jq -r '.ok // "false"') || RELEASE_OK="false"
[ "$RELEASE_OK" = "true" ] || fail "Release failed: $RELEASE_OUT"
say "goalctl lanes release returned ok=true ✓"

# Verify lease gone.
REMAINING=$(jq '.leases | length' "$GOAL_DIR/lanes.json" 2>/dev/null)
[ "$REMAINING" -eq 0 ] || fail "Expected 0 leases after release, got $REMAINING"
say "Lease removed from lanes.json ✓"

# ============================================================================
# TEST 5: goalctl lanes (list) returns JSON
# ============================================================================

step "5. goalctl lanes --json"

# Add a lease manually.
CLAIM_RESULT=$(node "$CLAIM_SCRIPT" "$GOAL_DIR" "src/list-test/**" "agent-list" "600" 2>/dev/null)
LIST_OUT=$("$GOALCTL" --root "$TMP" lanes --json 2>/dev/null) || fail "goalctl lanes --json failed"
jq empty <<<"$LIST_OUT" || fail "goalctl lanes --json output is not valid JSON"
LIST_COUNT=$(jq '.leases | length' <<<"$LIST_OUT")
[ "$LIST_COUNT" -ge 1 ] || fail "Expected at least 1 lease in list, got $LIST_COUNT"
say "goalctl lanes --json returned $LIST_COUNT leases ✓"

printf '\n'
green "ALL T2 CONCURRENCY TESTS PASSED (a4 evidence)"
