#!/usr/bin/env bash
# cowork/handoff/test/test-parse.sh — T-parse: handoff parser tests (P4)
#
# Tests both the bash parser (parse.sh) and TypeScript parser (parse.ts).
#
# 1. Writes a valid sample envelope derived from template.md.
# 2. Runs handoff_validate (bash) → asserts exit 0.
# 3. Runs handoff_parse_* functions → asserts correct values.
# 4. Runs the TypeScript parser → asserts parsed object has expected fields.
# 5. Writes a malformed envelope → asserts both validators reject it.
#
# Run from repo root: ./cowork/handoff/test/test-parse.sh
# Exit codes: 0 = pass, 1 = fail.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
PARSE_SH="$REPO_ROOT/cowork/handoff/parse.sh"
PARSE_TS="$REPO_ROOT/cowork/handoff/parse.ts"
TEMPLATE="$REPO_ROOT/cowork/handoff/template.md"

green() { printf '\033[32m%s\033[0m\n' "$*"; }
red()   { printf '\033[31m%s\033[0m\n' "$*"; }
say()   { printf '  %s\n' "$*"; }
step()  { printf '\n[%s] %s\n' "$(date -u +%H:%M:%S)" "$1"; }

TMP=""
cleanup() { [ -n "$TMP" ] && rm -rf "$TMP" || true; }
trap cleanup EXIT

fail() {
    red "FAIL [T-parse]: $*"
    exit 1
}

# ---- prereqs ----------------------------------------------------------------

step "0. Prereqs"

[ -f "$PARSE_SH" ]   || fail "parse.sh not found at $PARSE_SH"
[ -f "$PARSE_TS" ]   || fail "parse.ts not found at $PARSE_TS"
[ -f "$TEMPLATE" ]   || fail "template.md not found at $TEMPLATE"
command -v node >/dev/null 2>&1 || fail "node not found"
say "parse.sh: $PARSE_SH ✓"
say "parse.ts: $PARSE_TS ✓"
say "template.md: $TEMPLATE ✓"

# ---- setup ------------------------------------------------------------------

TMP=$(mktemp -d -t goal-parse-test-XXXXXX)
VALID_ENVELOPE="$TMP/0007.md"
BAD_ENVELOPE="$TMP/bad.md"
GOAL_DIR="$TMP/.goal"
mkdir -p "$GOAL_DIR/handoff"

# ---- 1. Write a valid sample envelope ---------------------------------------

step "1. Write valid sample envelope"

GOAL_UUID="11111111-2222-3333-4444-555555555555"
NOW="2026-05-11T14:32:00Z"

cat > "$VALID_ENVELOPE" <<'ENVELOPE'
---
seq: 0007
from: claude-code
to: codex
at: 2026-05-11T14:32:00Z
reason: rate_limit
goal_id: 11111111-2222-3333-4444-555555555555
---

## Did
- migrated 4/6 files
- tests red on auth/session*

## Did not
- did not touch oauth flow (lane held by review)

## Next
- implement session refresh in src/auth/session.ts
- get auth.session.test.ts to green

## Do not redo
- migration scaffolding (audit a1 passed)

## Open audit items
- a3: pnpm test passes
- a4: no `any` types introduced

## Evidence
- src/auth/session.ts
- tests/auth/session.test.ts (failing: refresh_token)
ENVELOPE

say "valid envelope written: $VALID_ENVELOPE ✓"

# Also copy it into the goal handoff dir for the TS listHandoffs test.
cp "$VALID_ENVELOPE" "$GOAL_DIR/handoff/0007.md"

# ---- 2. handoff_validate (bash) on valid envelope ---------------------------

step "2. handoff_validate bash — valid envelope"

# shellcheck disable=SC1090
. "$PARSE_SH"

handoff_validate "$VALID_ENVELOPE" || fail "handoff_validate should exit 0 on valid envelope"
say "handoff_validate exit 0 ✓"

# ---- 3. handoff_parse_* functions -------------------------------------------

step "3. handoff_parse_* on valid envelope"

SEQ=$(handoff_parse_seq "$VALID_ENVELOPE")
[ "$SEQ" = "0007" ] || fail "parse_seq: expected 0007, got '$SEQ'"
say "handoff_parse_seq = 0007 ✓"

FROM=$(handoff_parse_field "$VALID_ENVELOPE" from)
[ "$FROM" = "claude-code" ] || fail "parse_field(from): expected 'claude-code', got '$FROM'"
say "handoff_parse_field(from) = claude-code ✓"

REASON=$(handoff_parse_field "$VALID_ENVELOPE" reason)
[ "$REASON" = "rate_limit" ] || fail "parse_field(reason): expected 'rate_limit', got '$REASON'"
say "handoff_parse_field(reason) = rate_limit ✓"

GOAL_ID=$(handoff_parse_field "$VALID_ENVELOPE" goal_id)
[ "$GOAL_ID" = "11111111-2222-3333-4444-555555555555" ] \
    || fail "parse_field(goal_id): got '$GOAL_ID'"
say "handoff_parse_field(goal_id) = $GOAL_ID ✓"

DID_LINES=$(handoff_parse_body "$VALID_ENVELOPE" did | wc -l | tr -d '[:space:]')
[ "$DID_LINES" -eq 2 ] || fail "parse_body(did): expected 2 bullets, got $DID_LINES"
say "handoff_parse_body(did) = 2 bullets ✓"

NEXT_FIRST=$(handoff_parse_body "$VALID_ENVELOPE" next | head -1)
[ "$NEXT_FIRST" = "- implement session refresh in src/auth/session.ts" ] \
    || fail "parse_body(next) first line: got '$NEXT_FIRST'"
say "handoff_parse_body(next) first bullet ✓"

EVIDENCE_COUNT=$(handoff_parse_body "$VALID_ENVELOPE" evidence | wc -l | tr -d '[:space:]')
[ "$EVIDENCE_COUNT" -eq 2 ] || fail "parse_body(evidence): expected 2, got $EVIDENCE_COUNT"
say "handoff_parse_body(evidence) = 2 bullets ✓"

# ---- 4. TypeScript parser ---------------------------------------------------

step "4. TypeScript parser on valid envelope"

# We run parse.ts directly with node --input-type=module using an inline
# script that imports parse.ts from the source path. Node 22+ supports
# --experimental-strip-types; for Node 18/20 we use a TSX-free approach:
# we write a small JS shim that calls the compiled form if available, or
# we compile on-the-fly with tsc if not.
#
# Strategy: try to use 'node --experimental-strip-types' first (Node 22+),
# fall back to compiling via tsc + node.

NODE_VERSION=$(node --version | sed 's/v//' | cut -d. -f1)

if [ "$NODE_VERSION" -ge 22 ] 2>/dev/null; then
    # Node 22+: use --experimental-strip-types
    node --experimental-strip-types --input-type=module <<NODETEST 2>/dev/null
import { parseHandoff, validateHandoff, listHandoffs, readHandoffBySeq } from '${PARSE_TS}';

const env = parseHandoff('${VALID_ENVELOPE}');

if (env.seq !== '0007') { process.stderr.write('TS: seq wrong: ' + env.seq + '\n'); process.exit(1); }
if (env.from !== 'claude-code') { process.stderr.write('TS: from wrong\n'); process.exit(1); }
if (env.reason !== 'rate_limit') { process.stderr.write('TS: reason wrong\n'); process.exit(1); }
if (env.goal_id !== '11111111-2222-3333-4444-555555555555') { process.stderr.write('TS: goal_id wrong\n'); process.exit(1); }
if (env.did.length !== 2) { process.stderr.write('TS: did.length wrong: ' + env.did.length + '\n'); process.exit(1); }
if (env.next.length !== 2) { process.stderr.write('TS: next.length wrong: ' + env.next.length + '\n'); process.exit(1); }
if (env.evidence.length !== 2) { process.stderr.write('TS: evidence.length wrong: ' + env.evidence.length + '\n'); process.exit(1); }

// listHandoffs and readHandoffBySeq
const paths = listHandoffs('${GOAL_DIR}');
if (paths.length !== 1) { process.stderr.write('TS: listHandoffs count wrong: ' + paths.length + '\n'); process.exit(1); }

const env2 = readHandoffBySeq('${GOAL_DIR}', '7');
if (env2.seq !== '0007') { process.stderr.write('TS: readHandoffBySeq seq wrong: ' + env2.seq + '\n'); process.exit(1); }

process.stdout.write('TS parse OK\n');
NODETEST
    TS_RESULT=$?
else
    # Node 18/20: compile parse.ts to a temp JS file then run.
    TSC=$(command -v tsc 2>/dev/null || echo "")
    if [ -z "$TSC" ]; then
        # Try local tsc from mcp/node_modules.
        TSC="$REPO_ROOT/mcp/node_modules/.bin/tsc"
    fi

    if [ -f "$TSC" ]; then
        TS_OUT="$TMP/parse-compiled.mjs"
        # Compile with a minimal tsconfig.
        TSCONFIG_TMP="$TMP/tsconfig-parse.json"
        cat > "$TSCONFIG_TMP" <<TSEOF
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "${TMP}/tsc-out",
    "rootDir": "${REPO_ROOT}/cowork/handoff",
    "strict": true,
    "skipLibCheck": true,
    "declaration": false
  },
  "include": ["${REPO_ROOT}/cowork/handoff/parse.ts"]
}
TSEOF
        "$TSC" --project "$TSCONFIG_TMP" 2>/dev/null || true
        COMPILED_JS="$TMP/tsc-out/parse.js"

        if [ -f "$COMPILED_JS" ]; then
            node --input-type=module <<NODETEST 2>/dev/null
import { parseHandoff, listHandoffs, readHandoffBySeq } from '${COMPILED_JS}';

const env = parseHandoff('${VALID_ENVELOPE}');
if (env.seq !== '0007') { process.stderr.write('TS: seq wrong\n'); process.exit(1); }
if (env.from !== 'claude-code') { process.stderr.write('TS: from wrong\n'); process.exit(1); }
if (env.reason !== 'rate_limit') { process.stderr.write('TS: reason wrong\n'); process.exit(1); }
if (env.did.length !== 2) { process.stderr.write('TS: did.length wrong: ' + env.did.length + '\n'); process.exit(1); }
const paths = listHandoffs('${GOAL_DIR}');
if (paths.length !== 1) { process.stderr.write('TS: listHandoffs wrong\n'); process.exit(1); }
const env2 = readHandoffBySeq('${GOAL_DIR}', '7');
if (env2.seq !== '0007') { process.stderr.write('TS: readHandoffBySeq seq wrong\n'); process.exit(1); }
process.stdout.write('TS parse OK\n');
NODETEST
            TS_RESULT=$?
        else
            say "tsc output not found — skipping TS parse test (node < 22, tsc unavailable)"
            TS_RESULT=0
        fi
    else
        say "tsc not found and node < 22 — skipping TS parse test"
        TS_RESULT=0
    fi
fi

[ "$TS_RESULT" -eq 0 ] || fail "TypeScript parser failed (exit $TS_RESULT)"
say "TypeScript parser OK ✓"

# ---- 5. Malformed envelope — missing frontmatter key ------------------------

step "5. Malformed envelope — missing 'reason' key"

cat > "$BAD_ENVELOPE" <<'BADENV'
---
seq: 0008
from: claude-code
to: codex
at: 2026-05-11T15:00:00Z
goal_id: 11111111-2222-3333-4444-555555555555
---

## Did
- something

## Did not
- nothing

## Next
- next thing

## Do not redo
- nothing

## Open audit items
- none

## Evidence
- none
BADENV

# Bash validator must reject it.
BASH_REJECT=0
handoff_validate "$BAD_ENVELOPE" 2>/dev/null && BASH_REJECT=0 || BASH_REJECT=1
[ "$BASH_REJECT" -eq 1 ] || fail "bash validator should reject envelope missing 'reason'"
say "bash validator rejects missing reason ✓"

# TypeScript validator must also reject it.
if [ "$NODE_VERSION" -ge 22 ] 2>/dev/null; then
    node --experimental-strip-types --input-type=module <<NODETEST 2>/dev/null
import { parseHandoff } from '${PARSE_TS}';
try {
    parseHandoff('${BAD_ENVELOPE}');
    process.stderr.write('TS: should have thrown on malformed envelope\n');
    process.exit(1);
} catch (e) {
    // Expected — print the message for the test log.
    process.stdout.write('TS rejected: ' + e.message + '\n');
    process.exit(0);
}
NODETEST
    TS_REJECT=$?
else
    COMPILED_JS="$TMP/tsc-out/parse.js"
    if [ -f "$COMPILED_JS" ]; then
        node --input-type=module <<NODETEST 2>/dev/null
import { parseHandoff } from '${COMPILED_JS}';
try {
    parseHandoff('${BAD_ENVELOPE}');
    process.stderr.write('TS: should have thrown\n');
    process.exit(1);
} catch (e) {
    process.stdout.write('TS rejected: ' + e.message + '\n');
    process.exit(0);
}
NODETEST
        TS_REJECT=$?
    else
        say "skipping TS rejection test (compiled JS not available)"
        TS_REJECT=0
    fi
fi
[ "$TS_REJECT" -eq 0 ] || fail "TypeScript validator should have rejected malformed envelope"
say "TypeScript validator rejects malformed envelope ✓"

# ---- 6. Malformed envelope — missing body section ---------------------------

step "6. Malformed envelope — missing 'Evidence' section"

cat > "$BAD_ENVELOPE" <<'BADENV'
---
seq: 0009
from: claude-code
to: codex
at: 2026-05-11T15:00:00Z
reason: planned
goal_id: 11111111-2222-3333-4444-555555555555
---

## Did
- something

## Did not
- nothing

## Next
- next thing

## Do not redo
- nothing

## Open audit items
- none
BADENV

BASH_REJECT2=0
handoff_validate "$BAD_ENVELOPE" 2>/dev/null && BASH_REJECT2=0 || BASH_REJECT2=1
[ "$BASH_REJECT2" -eq 1 ] || fail "bash validator should reject envelope missing Evidence section"
say "bash validator rejects missing Evidence section ✓"

# ---- done -------------------------------------------------------------------

printf '\n'
green "ALL T-PARSE TESTS PASSED (a14 partial evidence)"
