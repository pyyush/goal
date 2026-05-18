// Smoke test for Phase 2: the goal/continue channel.
//
// Verifies:
//   1. The compiled server advertises `experimental['claude/channel'] = {}` in
//      its initialize response.
//   2. After create_goal, the server pushes a boot continuation event and
//      writes a `goal.continuation_pushed` line with outcome:"sent" to
//      .goal/events.jsonl.
//   3. While `.goal/pause` exists, a file-watch trigger produces
//      outcome:"skipped_paused".
//   4. After removing the pause file, pushes resume.
//
// Runs in a tmpdir injected via $GOAL_ROOT with GOAL_CHANNEL_DEBOUNCE_MS=200
// for fast iteration.
import { spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const serverPath = resolve(here, "..", "dist", "goal-server.js");

if (!existsSync(serverPath)) {
  console.error(`channel-smoke: build output missing at ${serverPath}; run \`npx tsc\` first`);
  process.exit(2);
}

const goalRoot = mkdtempSync(join(tmpdir(), "goal-mcp-channel-"));
console.error(`channel-smoke: GOAL_ROOT=${goalRoot}`);

const child = spawn(process.execPath, [serverPath], {
  env: {
    ...process.env,
    GOAL_ROOT: goalRoot,
    GOAL_MCP_DEBUG: "1",
    GOAL_CHANNEL_DEBOUNCE_MS: "200",
  },
  stdio: ["pipe", "pipe", "pipe"],
});

let stderrBuf = "";
child.stderr.on("data", (b) => { stderrBuf += b.toString("utf8"); });

let stdoutBuf = "";
const pending = new Map();
const notificationsReceived = []; // server-initiated notifications

child.stdout.on("data", (chunk) => {
  stdoutBuf += chunk.toString("utf8");
  let nl;
  while ((nl = stdoutBuf.indexOf("\n")) !== -1) {
    const line = stdoutBuf.slice(0, nl).trim();
    stdoutBuf = stdoutBuf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch {
      console.error(`channel-smoke: non-JSON line on stdout: ${line}`);
      continue;
    }
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve: r } = pending.get(msg.id);
      pending.delete(msg.id);
      r(msg);
    } else if (msg.method) {
      notificationsReceived.push(msg);
    } else {
      console.error(`channel-smoke: unmatched message: ${line}`);
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

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

const failures = [];
function expect(cond, msg) {
  if (!cond) failures.push(msg);
}

function readEvents() {
  const file = join(goalRoot, ".goal", "events.jsonl");
  if (!existsSync(file)) return [];
  const raw = readFileSync(file, "utf8").trim();
  if (!raw) return [];
  return raw.split("\n").map((l) => JSON.parse(l));
}

function readPushEvents() {
  return readEvents().filter((e) => e.type === "goal.continuation_pushed");
}

function bumpGoalMtime() {
  // Touch the most-recent v3 goal record's mtime so fs.watch fires without
  // changing the content. Use a future timestamp to be safe against same-second
  // resolution. v3 records live at .goal/goals/<gid>.json — we don't know the
  // gid here, so we pick the newest .json file under goals/.
  const goalsDir = join(goalRoot, ".goal", "goals");
  let candidates;
  try {
    candidates = readdirSync(goalsDir).filter((n) => n.endsWith(".json")).map((n) => join(goalsDir, n));
  } catch {
    throw new Error(`bumpGoalMtime: ${goalsDir} not found — create_goal must run first`);
  }
  if (candidates.length === 0) throw new Error(`bumpGoalMtime: no goal records in ${goalsDir}`);
  // Pick the one with the largest mtime.
  const target = candidates.sort()[candidates.length - 1];
  const t = new Date(Date.now() + 1_000);
  utimesSync(target, t, t);
}

async function run() {
  // ── 1) initialize handshake; assert channel capability advertised ──────
  const init = await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "channel-smoke", version: "0.0.0" },
  });
  if (!init.result) {
    console.error("channel-smoke: initialize: no result");
    console.error(`channel-smoke: child stderr:\n${stderrBuf}`);
    child.kill("SIGTERM");
    process.exit(1);
  }
  const caps = init.result.capabilities ?? {};
  const hasChannel = caps.experimental && Object.prototype.hasOwnProperty.call(caps.experimental, "claude/channel");
  expect(hasChannel, `initialize: capabilities.experimental['claude/channel'] should be advertised; got ${JSON.stringify(caps)}`);

  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  // ── 2) tools/list — sanity check Phase 1 tools still there ────────────
  const list = await rpc("tools/list", {});
  const names = (list.result?.tools ?? []).map((t) => t.name).sort();
  for (const tool of ["create_goal", "get_goal", "update_goal", "report_progress", "queue_message", "steer_message"]) {
    expect(names.includes(tool), `tools/list missing ${tool}; got ${names.join(",")}`);
  }

  // ── 3) Create an active goal. ─────────────────────────────────────────
  const created = await rpc("tools/call", {
    name: "create_goal",
    arguments: { objective: "exercise the goal/continue channel" },
  });
  expect(!created.result.isError, `create_goal: unexpected error: ${created.result.content?.[0]?.text}`);
  const createdObj = JSON.parse(created.result.content[0].text);
  expect(createdObj.status === "pursuing", `create_goal: status should be pursuing, got ${createdObj.status}`);
  // Pursuit timer fields are present on the create view.
  expect(createdObj.pursuing_seconds === 0, `create_goal: pursuing_seconds should be 0, got ${createdObj.pursuing_seconds}`);
  expect(typeof createdObj.pursuing_since === "string" && createdObj.pursuing_since.length > 0,
         `create_goal: pursuing_since should be a non-empty ISO string, got ${createdObj.pursuing_since}`);

  // ── 4) Wait for the boot push (2s grace inside the server) and/or the
  //       filewatch push that create_goal itself triggers. Either way we
  //       expect at least one `outcome:"sent"` event within ~3s.
  //       The boot timer is unref'd inside the server.
  let sentEvent = null;
  for (let i = 0; i < 60; i++) {
    const events = readPushEvents();
    sentEvent = events.find((e) => e.outcome === "sent");
    if (sentEvent) break;
    await sleep(100);
  }
  expect(!!sentEvent, "expected at least one goal.continuation_pushed event with outcome:'sent' within 6s");
  if (sentEvent) {
    expect(sentEvent.goal_id === createdObj.goal_id, `sent event goal_id mismatch: ${sentEvent.goal_id} vs ${createdObj.goal_id}`);
    expect(sentEvent.channel === "goal/continue", `sent event channel mismatch: ${sentEvent.channel}`);
    expect(["boot", "filewatch", "timer"].includes(sentEvent.trigger), `sent event trigger should be boot|filewatch|timer, got ${sentEvent.trigger}`);
  }

  // Verify a real notification flowed over the wire too.
  const channelNotifs = notificationsReceived.filter((n) => n.method === "notifications/claude/channel");
  expect(channelNotifs.length >= 1, `expected at least one notifications/claude/channel on the wire; got ${channelNotifs.length}`);
  if (channelNotifs.length >= 1) {
    const n = channelNotifs[0];
    expect(typeof n.params?.content === "string" && n.params.content.includes("mcp__goal__get_goal"), "channel notification content should mention mcp__goal__get_goal");
    expect(typeof n.params?.meta?.trigger === "string", "channel notification meta.trigger should be a string");
  }

  // ── 5) Touch .goal/pause; trigger a file-watch event; expect a
  //       skipped_paused outcome.
  const pauseFile = join(goalRoot, ".goal", "pause");
  const beforePauseCount = readPushEvents().length;
  closeSync(openSync(pauseFile, "w")); // create empty file
  // Wait past our own push debounce (we set GOAL_CHANNEL_DEBOUNCE_MS=200).
  await sleep(300);
  bumpGoalMtime();
  // Allow time for fs.watch coalesce + lock acquisition.
  let pausedEvent = null;
  for (let i = 0; i < 30; i++) {
    await sleep(100);
    const events = readPushEvents();
    if (events.length > beforePauseCount) {
      pausedEvent = events.slice(beforePauseCount).find((e) => e.outcome === "skipped_paused");
      if (pausedEvent) break;
    }
  }
  expect(!!pausedEvent, "expected a goal.continuation_pushed event with outcome:'skipped_paused' after touching goal.pause");

  // ── 6) Remove the pause file; trigger another file-watch event; expect
  //       a fresh `sent` event (pushes resume).
  unlinkSync(pauseFile);
  await sleep(300); // outlast our own debounce
  const beforeResumeCount = readPushEvents().length;
  bumpGoalMtime();
  let resumedEvent = null;
  for (let i = 0; i < 30; i++) {
    await sleep(100);
    const events = readPushEvents();
    if (events.length > beforeResumeCount) {
      resumedEvent = events.slice(beforeResumeCount).find((e) => e.outcome === "sent");
      if (resumedEvent) break;
    }
  }
  expect(!!resumedEvent, "expected goal.continuation_pushed with outcome:'sent' after removing goal.pause");

  // ── Done. Summarize.
  if (failures.length) {
    console.error("channel-smoke: FAILURES:");
    failures.forEach((f) => console.error("  - " + f));
    console.error(`channel-smoke: events file:\n${JSON.stringify(readPushEvents(), null, 2)}`);
    console.error(`channel-smoke: child stderr:\n${stderrBuf}`);
    child.kill("SIGTERM");
    process.exit(1);
  } else {
    console.error("channel-smoke: ALL CHECKS PASSED");
    child.kill("SIGTERM");
    process.exit(0);
  }
}

run().catch((err) => {
  console.error(`channel-smoke: harness exception: ${err.stack || err.message}`);
  console.error(`channel-smoke: child stderr:\n${stderrBuf}`);
  child.kill("SIGTERM");
  process.exit(1);
});
