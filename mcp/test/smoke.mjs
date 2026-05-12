// Smoke test: spawn the compiled server, send JSON-RPC over stdio, assert tool
// list and create_goal behaviour. Runs in a tmpdir injected via $GOAL_ROOT.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs";
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
  const requiredTools = [
    "create_goal", "get_goal", "update_goal",
    "claim_lane", "release_lane", "write_handoff", "peer_status", "relay_now",
    "report_progress", "report_stuck", "record_breadcrumb", "queue_message", "steer_message",
  ];
  for (const tool of requiredTools) expect(names.includes(tool), `tools/list missing ${tool}; got ${names.join(",")}`);

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
  // pursuit timer fields: created should have pursuing_seconds=0 and pursuing_since=created_at.
  expect(createdObj.pursuing_seconds === 0, `create_goal: pursuing_seconds should be 0, got ${createdObj.pursuing_seconds}`);
  expect(typeof createdObj.pursuing_since === "string" && createdObj.pursuing_since.length > 0,
         `create_goal: pursuing_since should be a non-empty ISO string, got ${createdObj.pursuing_since}`);
  expect(createdObj.pursuing_since === createdObj.created_at,
         `create_goal: pursuing_since should equal created_at on fresh goal (${createdObj.pursuing_since} vs ${createdObj.created_at})`);

  // 5) verify state.json was atomically written into GOAL_ROOT/.goal/
  const goalFile = join(goalRoot, ".goal", "state.json");
  expect(existsSync(goalFile), `state.json should exist at ${goalFile}`);
  const onDisk = JSON.parse(readFileSync(goalFile, "utf8"));
  expect(onDisk.goal_id === createdObj.goal_id, "on-disk goal_id mismatch");
  expect(onDisk.schema_version === 2, "on-disk schema_version should be 2");
  expect(typeof onDisk.time_used_seconds === "number", "on-disk v3 time_used_seconds missing");
  expect(typeof onDisk.observed_at === "string", "on-disk v3 observed_at missing");
  // No leftover tmp files
  const dirEntries = readdirSync(join(goalRoot, ".goal"));
  const stray = dirEntries.filter((n) => n.startsWith(".goal-write-") || n.endsWith(".tmp"));
  expect(stray.length === 0, `stray tmp files in .goal/: ${stray.join(",")}`);

  // 6) verify events.jsonl has goal.created line
  const eventsFile = join(goalRoot, ".goal", "events.jsonl");
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

  // 7b) Active-pursuit timer: pause for a moment, then resume; elapsed_seconds
  //     should reflect only the time the goal was in `pursuing` (not the
  //     interval it was paused for). We simulate pause/resume by editing the
  //     on-disk goal.json (the MCP server doesn't expose pause/resume tools)
  //     and then call get_goal to inspect the computed view.
  {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    // 7b.1: capture baseline pursuit seconds (likely 0 or 1).
    const beforePauseView = JSON.parse((await rpc("tools/call", { name: "get_goal", arguments: {} })).result.content[0].text);
    const baselineElapsed = beforePauseView.elapsed_seconds;

    // 7b.2: write `status: "paused"` + accumulate pursuing_seconds onto disk.
    await sleep(1100);
    const cur = JSON.parse(readFileSync(goalFile, "utf8"));
    const accSeconds = (cur.pursuing_seconds ?? 0) +
                       Math.max(0, Math.floor((Date.now() - Date.parse(cur.pursuing_since)) / 1000));
    const pausedRecord = {
      ...cur,
      status: "paused",
      pursuing_seconds: accSeconds,
      pursuing_since: null,
      updated_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    };
    writeFileSync(goalFile, JSON.stringify(pausedRecord, null, 2) + "\n", "utf8");

    // 7b.3: while paused, sleep — this time MUST NOT count.
    await sleep(2200);

    // 7b.4: now check via get_goal that elapsed_seconds did NOT increase
    // beyond accSeconds. The MCP server computes elapsed = pursuing_seconds
    // for non-pursuing states.
    const pausedView = JSON.parse((await rpc("tools/call", { name: "get_goal", arguments: {} })).result.content[0].text);
    expect(pausedView.status === "paused", `expected paused, got ${pausedView.status}`);
    expect(pausedView.elapsed_seconds === accSeconds,
           `paused elapsed should equal pursuing_seconds (${accSeconds}), got ${pausedView.elapsed_seconds}`);
    expect(pausedView.elapsed_seconds < baselineElapsed + 3,
           `paused elapsed (${pausedView.elapsed_seconds}) should not have grown by 2s+ during the pause (baseline ${baselineElapsed})`);

    // 7b.5: resume by writing pursuing_since=now back onto disk.
    const resumedRecord = {
      ...pausedRecord,
      status: "pursuing",
      pursuing_since: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      updated_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    };
    writeFileSync(goalFile, JSON.stringify(resumedRecord, null, 2) + "\n", "utf8");

    // 7b.6: wait, then verify elapsed_seconds resumed ticking from accSeconds.
    await sleep(1200);
    const resumedView = JSON.parse((await rpc("tools/call", { name: "get_goal", arguments: {} })).result.content[0].text);
    expect(resumedView.status === "pursuing", `expected pursuing after resume, got ${resumedView.status}`);
    expect(resumedView.elapsed_seconds >= accSeconds + 1,
           `resumed elapsed should be at least accSeconds+1 (${accSeconds + 1}), got ${resumedView.elapsed_seconds}`);
    // And the resumed elapsed must be strictly less than wall-clock from create.
    const wallClock = Math.floor((Date.now() - Date.parse(createdObj.created_at)) / 1000);
    expect(resumedView.elapsed_seconds < wallClock,
           `pursuit-time elapsed (${resumedView.elapsed_seconds}) should be less than wall-clock (${wallClock}) because of the pause`);
  }

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
