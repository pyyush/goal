// v3-handshake.mjs — the integration test that catches the bug fixed in
// "fix(mcp): v3 session-scoped on-disk layout + migration".
//
// What it asserts: MCP create_goal writes records the bash resolver can find.
// Concretely:
//   1. Spawn the MCP server with GOAL_ROOT=tmpdir and CLAUDE_SESSION_ID=sid.
//   2. Call create_goal.
//   3. Source hooks/goal-resolve.sh and run goal_resolve_owned <sid> <root>.
//   4. Assert it sets GOAL_ID equal to the gid the MCP returned.
//   5. Assert the bundled statusline helper renders a non-empty line for the
//      owning session and an empty line for any other session.
//   6. Migration regression: drop a v2 .goal/state.json into a second tmpdir,
//      call get_goal, assert the file was migrated to .goal/goals/<gid>.json
//      and the legacy state.json was removed.
//
// Exits non-zero on the first assertion that disagrees.

import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const serverPath = resolve(here, "..", "dist", "goal-server.js");
const resolverPath = join(repoRoot, "hooks", "goal-resolve.sh");
const statuslinePath = join(repoRoot, "hooks", "goal-statusline.sh");

if (!existsSync(serverPath)) {
  console.error(`handshake: build output missing at ${serverPath}; run \`npx tsc\` first`);
  process.exit(2);
}
if (!existsSync(resolverPath)) {
  console.error(`handshake: hooks/goal-resolve.sh not found at ${resolverPath}`);
  process.exit(2);
}

let nextId = 1;
function rpc(child, pending, method, params = {}) {
  const id = nextId++;
  const msg = { jsonrpc: "2.0", id, method, params };
  return new Promise((resolveP, rejectP) => {
    pending.set(id, { resolve: resolveP, reject: rejectP });
    child.stdin.write(JSON.stringify(msg) + "\n");
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        rejectP(new Error(`rpc timeout: ${method} id=${id}`));
      }
    }, 5000);
  });
}

function spawnServer(env) {
  const child = spawn(process.execPath, [serverPath], {
    env: { ...process.env, ...env, GOAL_MCP_DEBUG: "1" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderrBuf = "";
  child.stderr.on("data", (b) => { stderrBuf += b.toString("utf8"); });
  let stdoutBuf = "";
  const pending = new Map();
  child.stdout.on("data", (chunk) => {
    stdoutBuf += chunk.toString("utf8");
    let nl;
    while ((nl = stdoutBuf.indexOf("\n")) !== -1) {
      const line = stdoutBuf.slice(0, nl).trim();
      stdoutBuf = stdoutBuf.slice(nl + 1);
      if (!line) continue;
      let msg; try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id !== undefined && pending.has(msg.id)) {
        const { resolve: r } = pending.get(msg.id);
        pending.delete(msg.id);
        r(msg);
      }
    }
  });
  return { child, pending, stderr: () => stderrBuf };
}

async function initialize(handle) {
  await rpc(handle.child, handle.pending, "initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "v3-handshake", version: "0.0.0" },
  });
  handle.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
}

function bashResolve(sid, root) {
  // Source the resolver and report what it set. Exits 0 if owned, 1 otherwise.
  const script = `
set -u
. "${resolverPath}"
if goal_resolve_owned "${sid}" "${root}" 2>/dev/null; then
  printf '{"owned":true,"goal_id":"%s","goal_file":"%s","goal_lock":"%s"}\\n' \\
    "$GOAL_ID" "$GOAL_FILE" "$GOAL_LOCK"
else
  printf '{"owned":false}\\n'
fi
`;
  const out = execFileSync("bash", ["-c", script], { encoding: "utf8" });
  return JSON.parse(out.trim());
}

function bashStatusline(sid, root) {
  if (!existsSync(statuslinePath)) return "";
  const out = execFileSync(
    "bash", [statuslinePath, root, sid],
    { encoding: "utf8", env: { ...process.env, GOAL_STATUSLINE_STYLE: "plain" } },
  );
  return out;
}

const failures = [];
function expect(cond, msg) { if (!cond) { failures.push(msg); console.error("  FAIL: " + msg); } else { console.error("  ok:   " + msg); } }

async function step1_freshCreate() {
  console.error("\n[1] fresh create_goal → bash resolver finds the same gid");
  const root = mkdtempSync(join(tmpdir(), "v3-handshake-"));
  const sid = "sess-" + Math.random().toString(36).slice(2, 10);
  const handle = spawnServer({ GOAL_ROOT: root, CLAUDE_SESSION_ID: sid });
  try {
    await initialize(handle);
    const res = await rpc(handle.child, handle.pending, "tools/call", {
      name: "create_goal",
      arguments: { objective: "v3 handshake test goal" },
    });
    expect(!res.result?.isError, `create_goal succeeded (got ${res.result?.content?.[0]?.text})`);
    const gid = JSON.parse(res.result.content[0].text).goal_id;

    // On-disk: record at goals/<gid>.json + pointer at sessions/<sid>
    expect(existsSync(join(root, ".goal", "goals", `${gid}.json`)),
           `record exists at .goal/goals/${gid}.json`);
    expect(existsSync(join(root, ".goal", "sessions", sid)),
           `session pointer exists at .goal/sessions/${sid}`);
    expect(!existsSync(join(root, ".goal", "state.json")),
           "legacy v2 state.json absent (regression guard)");

    // Bash resolver agrees
    const r = bashResolve(sid, root);
    expect(r.owned === true, "bash goal_resolve_owned returns success for the owning session");
    expect(r.goal_id === gid, `bash sets GOAL_ID=${gid} (got ${r.goal_id})`);
    expect(r.goal_file === join(root, ".goal", "goals", `${gid}.json`),
           `bash sets GOAL_FILE to v3 path (got ${r.goal_file})`);
    expect(r.goal_lock === join(root, ".goal", "locks", `${gid}.lock`),
           `bash sets GOAL_LOCK to per-goal path (got ${r.goal_lock})`);

    // Bash resolver returns nothing for an unrelated session in the same project
    const other = bashResolve("stranger-" + Math.random().toString(36).slice(2, 6), root);
    expect(other.owned === false, "bash returns unowned for a session without a pointer");

    // Statusline renders for the owner, blank for the stranger
    const slOwner = bashStatusline(sid, root);
    const slStranger = bashStatusline("stranger-sess", root);
    expect(slOwner.length > 0, `statusline renders for owner: ${JSON.stringify(slOwner.slice(0, 80))}`);
    expect(slStranger.length === 0, `statusline is empty for stranger (got ${JSON.stringify(slStranger.slice(0, 80))})`);
  } finally {
    handle.child.kill("SIGTERM");
  }
}

async function step2_v2Migration() {
  console.error("\n[2] v2 state.json → v3 forward migration");
  const root = mkdtempSync(join(tmpdir(), "v3-handshake-mig-"));
  const sid = "sess-" + Math.random().toString(36).slice(2, 10);
  mkdirSync(join(root, ".goal"), { recursive: true });

  // Drop a v2 record that the MCP should pick up and migrate.
  const v2Gid = "11111111-2222-3333-4444-555555555555";
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const v2 = {
    schema_version: 2,
    goal_id: v2Gid,
    objective: "pre-existing v2 goal awaiting migration",
    status: "pursuing",
    created_at: now,
    updated_at: now,
    token_budget: null,
    tokens_used: 0,
    tick_count: 0,
    pursuing_seconds: 0,
    pursuing_since: now,
    time_used_seconds: 0,
    observed_at: now,
    active_turn_started_at: now,
    tokens_used_observed_at: now,
    time_used_seconds_final: null,
    tokens_used_final: null,
    history: [{ ts: now, action: "create", note: "pre-existing v2 fixture" }],
  };
  writeFileSync(join(root, ".goal", "state.json"), JSON.stringify(v2, null, 2) + "\n");

  // get_goal in a different session (no pointer) should still resolve via
  // single-active fallback, but more importantly the migration must run.
  const handle = spawnServer({ GOAL_ROOT: root, CLAUDE_SESSION_ID: sid });
  try {
    await initialize(handle);
    const res = await rpc(handle.child, handle.pending, "tools/call", {
      name: "get_goal", arguments: {},
    });
    expect(!res.result?.isError, `get_goal after migration: ${res.result?.content?.[0]?.text}`);
    const got = JSON.parse(res.result.content[0].text);
    expect(got.goal_id === v2Gid, `migrated record keeps its gid (got ${got.goal_id})`);
    expect(existsSync(join(root, ".goal", "goals", `${v2Gid}.json`)),
           "post-migration record exists at goals/<gid>.json");
    expect(!existsSync(join(root, ".goal", "state.json")),
           "legacy state.json removed after migration");

    // The migration must NOT auto-bind the migrating session (RFC §5).
    expect(!existsSync(join(root, ".goal", "sessions", sid)),
           "migration does not auto-bind the calling session");
  } finally {
    handle.child.kill("SIGTERM");
  }
}

async function step3_sessionOwnershipIsolation() {
  console.error("\n[3] two sessions in one folder → two independent goals");
  const root = mkdtempSync(join(tmpdir(), "v3-handshake-iso-"));
  const sidA = "sessA-" + Math.random().toString(36).slice(2, 6);
  const sidB = "sessB-" + Math.random().toString(36).slice(2, 6);

  // Session A creates a goal.
  const a = spawnServer({ GOAL_ROOT: root, CLAUDE_SESSION_ID: sidA });
  let gidA;
  try {
    await initialize(a);
    const r = await rpc(a.child, a.pending, "tools/call", {
      name: "create_goal", arguments: { objective: "goal A" },
    });
    gidA = JSON.parse(r.result.content[0].text).goal_id;
  } finally { a.child.kill("SIGTERM"); }

  // Session B opens a server in the same root. create_goal must succeed (B
  // doesn't own anything yet), producing a second record.
  const b = spawnServer({ GOAL_ROOT: root, CLAUDE_SESSION_ID: sidB });
  let gidB;
  try {
    await initialize(b);
    const r = await rpc(b.child, b.pending, "tools/call", {
      name: "create_goal", arguments: { objective: "goal B" },
    });
    expect(!r.result?.isError, `session B create_goal succeeds in the same project (got ${r.result?.content?.[0]?.text})`);
    gidB = JSON.parse(r.result.content[0].text).goal_id;
    expect(gidA !== gidB, "two sessions yield two distinct goal ids");
  } finally { b.child.kill("SIGTERM"); }

  // Bash resolver returns the right gid for each session.
  const rA = bashResolve(sidA, root);
  const rB = bashResolve(sidB, root);
  expect(rA.goal_id === gidA, `bash resolver gives A its own gid`);
  expect(rB.goal_id === gidB, `bash resolver gives B its own gid`);
  expect(rA.goal_id !== rB.goal_id, "A and B's resolved goals are distinct");
}

async function main() {
  await step1_freshCreate();
  await step2_v2Migration();
  await step3_sessionOwnershipIsolation();
  if (failures.length) {
    console.error(`\nv3-handshake: ${failures.length} failure(s)`);
    process.exit(1);
  }
  console.error("\nv3-handshake: ALL CHECKS PASSED");
  process.exit(0);
}

main().catch((err) => {
  console.error(`v3-handshake: harness exception: ${err.stack || err.message}`);
  process.exit(1);
});
