// Smoke test: spawn the compiled server, send JSON-RPC over stdio, assert tool
// list and create_goal behaviour. Runs in a tmpdir injected via $GOAL_ROOT.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const serverPath = resolve(here, "..", "dist", "goal-server.js");

if (!existsSync(serverPath)) {
  console.error(`smoke: build output missing at ${serverPath}; run \`npx tsc\` first`);
  process.exit(2);
}

const goalRoot = mkdtempSync(join(tmpdir(), "goal-mcp-smoke-"));
console.error(`smoke: GOAL_ROOT=${goalRoot}`);

const child = spawn(process.execPath, [serverPath], {
  env: { ...process.env, GOAL_ROOT: goalRoot, GOAL_MCP_DEBUG: "1" },
  stdio: ["pipe", "pipe", "pipe"],
});

let stderrBuf = "";
child.stderr.on("data", (b) => { stderrBuf += b.toString("utf8"); });

// JSON-RPC framing: one message per line (MCP stdio uses newline-delimited JSON).
let stdoutBuf = "";
const pending = new Map(); // id -> { resolve, reject }

child.stdout.on("data", (chunk) => {
  stdoutBuf += chunk.toString("utf8");
  let nl;
  while ((nl = stdoutBuf.indexOf("\n")) !== -1) {
    const line = stdoutBuf.slice(0, nl).trim();
    stdoutBuf = stdoutBuf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch {
      console.error(`smoke: non-JSON line on stdout: ${line}`);
      continue;
    }
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve: r } = pending.get(msg.id);
      pending.delete(msg.id);
      r(msg);
    } else if (msg.method) {
      // server-initiated requests (we don't expect any in this smoke); ignore
    } else {
      console.error(`smoke: unmatched message: ${line}`);
    }
  }
});

let nextId = 1;
function rpc(method, params) {
  const id = nextId++;
  const msg = { jsonrpc: "2.0", id, method, params: params ?? {} };
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify(msg) + "\n");
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`rpc timeout: ${method} id=${id}`));
      }
    }, 5000);
  });
}

function assert(cond, msg) {
  if (!cond) {
    console.error(`smoke: ASSERT FAILED: ${msg}`);
    console.error(`smoke: child stderr:\n${stderrBuf}`);
    child.kill("SIGTERM");
    process.exit(1);
  }
}

const failures = [];
function expect(cond, msg) {
  if (!cond) failures.push(msg);
}

async function run() {
  // 1) initialize handshake (MCP requires it before tool calls).
  const init = await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "smoke-test", version: "0.0.0" },
  });
  assert(init.result, "initialize: no result");
  assert(init.result.serverInfo?.name === "goal", `initialize: serverInfo.name should be 'goal', got ${init.result.serverInfo?.name}`);
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  // 2) tools/list
  const list = await rpc("tools/list", {});
  assert(list.result?.tools, "tools/list: no tools");
  const names = list.result.tools.map((t) => t.name).sort();
  console.error(`smoke: tools/list → ${names.join(", ")}`);
  expect(names.join(",") === "create_goal,get_goal,update_goal", `expected three tools, got ${names.join(",")}`);

  // 3) get_goal — should error with no_active_goal
  const getEmpty = await rpc("tools/call", { name: "get_goal", arguments: {} });
  assert(getEmpty.result, "get_goal(empty): no result");
  expect(getEmpty.result.isError === true, "get_goal(empty): expected isError=true");
  const errText = getEmpty.result.content?.[0]?.text ?? "";
  expect(errText.includes("no_active_goal"), `get_goal(empty): expected no_active_goal code, got: ${errText}`);

  // 4) create_goal — happy path
  const created = await rpc("tools/call", {
    name: "create_goal",
    arguments: { objective: "ship Phase 1 of /goal parity tools", token_budget: 5000 },
  });
  assert(created.result, "create_goal: no result");
  expect(!created.result.isError, `create_goal: unexpected error: ${created.result.content?.[0]?.text}`);
  const createdObj = JSON.parse(created.result.content[0].text);
  expect(typeof createdObj.goal_id === "string" && createdObj.goal_id.length > 0, "create_goal: goal_id missing");
  expect(createdObj.status === "pursuing", `create_goal: status should be pursuing, got ${createdObj.status}`);
  expect(createdObj.objective === "ship Phase 1 of /goal parity tools", "create_goal: objective mismatch");
  expect(createdObj.token_budget === 5000, "create_goal: token_budget mismatch");
  expect(createdObj.tokens_used === 0, "create_goal: tokens_used should be 0");
  expect(createdObj.remaining_tokens === 5000, "create_goal: remaining_tokens should be 5000");
  expect(typeof createdObj.elapsed_seconds === "number", "create_goal: elapsed_seconds missing");

  // 5) verify goal.json was atomically written into GOAL_ROOT/.claude/
  const goalFile = join(goalRoot, ".claude", "goal.json");
  expect(existsSync(goalFile), `goal.json should exist at ${goalFile}`);
  const onDisk = JSON.parse(readFileSync(goalFile, "utf8"));
  expect(onDisk.goal_id === createdObj.goal_id, "on-disk goal_id mismatch");
  // No leftover tmp files
  const dirEntries = readdirSync(join(goalRoot, ".claude"));
  const stray = dirEntries.filter((n) => n.startsWith(".goal-write-") || n.endsWith(".tmp"));
  expect(stray.length === 0, `stray tmp files in .claude/: ${stray.join(",")}`);

  // 6) verify goal-events.jsonl has goal.created line
  const eventsFile = join(goalRoot, ".claude", "goal-events.jsonl");
  expect(existsSync(eventsFile), `events file should exist at ${eventsFile}`);
  const eventLines = readFileSync(eventsFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  expect(eventLines.length >= 1, "events: expected at least one event");
  const createdEv = eventLines.find((e) => e.type === "goal.created");
  expect(!!createdEv, "events: expected goal.created event");
  expect(createdEv.goal_id === createdObj.goal_id, "events: goal_id mismatch");
  expect(createdEv.token_budget === 5000, "events: token_budget mismatch");

  // 7) get_goal — should now return the same goal
  const getNow = await rpc("tools/call", { name: "get_goal", arguments: {} });
  assert(!getNow.result.isError, `get_goal: unexpected error: ${getNow.result.content?.[0]?.text}`);
  const got = JSON.parse(getNow.result.content[0].text);
  expect(got.goal_id === createdObj.goal_id, "get_goal: goal_id mismatch");

  // 8) create_goal again — should fail with goal_exists_and_active
  const dup = await rpc("tools/call", {
    name: "create_goal",
    arguments: { objective: "another goal" },
  });
  expect(dup.result.isError === true, "create_goal(dup): expected error");
  const dupText = dup.result.content?.[0]?.text ?? "";
  expect(dupText.includes("goal_exists_and_active"), `create_goal(dup): expected goal_exists_and_active, got: ${dupText}`);

  // 9) update_goal with bad status — invalid_input
  const badUpd = await rpc("tools/call", {
    name: "update_goal",
    arguments: { status: "achieved" },
  });
  expect(badUpd.result.isError === true, "update_goal(bad): expected error");
  expect((badUpd.result.content?.[0]?.text ?? "").includes("invalid_input"), "update_goal(bad): expected invalid_input");

  // 10) update_goal status:"complete" — happy path
  const done = await rpc("tools/call", {
    name: "update_goal",
    arguments: { status: "complete" },
  });
  expect(!done.result.isError, `update_goal: unexpected error: ${done.result.content?.[0]?.text}`);
  const doneObj = JSON.parse(done.result.content[0].text);
  expect(doneObj.status === "achieved", `update_goal: status should be achieved, got ${doneObj.status}`);
  expect(doneObj.final_report && typeof doneObj.final_report.elapsed_seconds === "number", "update_goal: missing final_report.elapsed_seconds");

  // 11) After completion, events should include goal.completed
  const eventLines2 = readFileSync(eventsFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const completedEv = eventLines2.find((e) => e.type === "goal.completed");
  expect(!!completedEv, "events: expected goal.completed event");

  // Done. Summarize.
  if (failures.length) {
    console.error("smoke: FAILURES:");
    failures.forEach((f) => console.error("  - " + f));
    console.error(`smoke: child stderr:\n${stderrBuf}`);
    child.kill("SIGTERM");
    process.exit(1);
  } else {
    console.error("smoke: ALL CHECKS PASSED");
    child.kill("SIGTERM");
    process.exit(0);
  }
}

run().catch((err) => {
  console.error(`smoke: harness exception: ${err.stack || err.message}`);
  console.error(`smoke: child stderr:\n${stderrBuf}`);
  child.kill("SIGTERM");
  process.exit(1);
});
