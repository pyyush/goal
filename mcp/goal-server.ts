#!/usr/bin/env node
/**
 * goal-mcp-server — Phase 1 of the /goal parity-tools design.
 *
 * Exposes three native model-side tools over stdio MCP:
 *   - create_goal(objective, token_budget?)
 *   - update_goal(status: "complete")     // asymmetric, model can only mark done
 *   - get_goal()                          // computed remaining_tokens, elapsed_seconds
 *
 * State of record: `.goal/state.json` at the goal root, shared with hooks &
 * `bin/goalctl`. Writes are atomic (tmp + rename), serialized by proper-lockfile,
 * and CAS-guarded on `goal_id`. Lifecycle transitions append a JSONL event to
 * `.goal/events.jsonl`.
 *
 * Logging policy: stdout is the MCP transport. All diagnostics MUST go to stderr.
 */

import { appendFileSync, mkdirSync, existsSync, lstatSync, readdirSync, readFileSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync, watch, type FSWatcher } from "node:fs";
import { mkdtempSync, openSync, closeSync, fsyncSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

// P5: Lane leases and cowork.yml (inline implementations to avoid TS path issues)
// We inline the lane claim/release logic here rather than importing the
// .ts modules (which would require tsx at runtime). The canonical types and
// exported functions live in cowork/lanes.ts and cowork/cowork-yml.ts.

// ── Lanes inline (mirrors cowork/lanes.ts) ───────────────────────────────────

interface LaneLease {
  lease_id: string;
  glob: string;
  holder: string;
  acquired_at: string;
  ttl_seconds: number;
  reason: string;
}

interface LanesFile {
  leases: LaneLease[];
}

type ClaimLaneResult =
  | { ok: true; lease_id: string }
  | { ok: false; conflict_with: string };

function lanesFilePath(goalDir: string): string {
  return join(goalDir, "lanes.json");
}

function readLanesFileInner(goalDir: string): LanesFile {
  const fp = lanesFilePath(goalDir);
  if (!existsSync(fp)) return { leases: [] };
  try {
    const raw = readFileSync(fp, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || !Array.isArray((parsed as Record<string, unknown>).leases)) {
      return { leases: [] };
    }
    return parsed as LanesFile;
  } catch (_) {
    return { leases: [] };
  }
}

function writeLanesFileInner(goalDir: string, data: LanesFile): void {
  const fp = lanesFilePath(goalDir);
  const dir = dirname(fp);
  mkdirSync(dir, { recursive: true });
  const tmpDir = mkdtempSync(join(dir, ".tmp-lanes-"));
  const tmp = join(tmpDir, "lanes.json");
  try {
    writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
    renameSync(tmp, fp);
  } finally {
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch (_) { /* best-effort */ }
    try { rmdirSync(tmpDir); } catch (_) { /* best-effort */ }
  }
}

function getHolderHeartbeatAgeMs(goalDir: string, holder: string): number | null {
  const agentFile = join(goalDir, "agents", `${holder}.json`);
  if (!existsSync(agentFile)) return null;
  try {
    const obj = JSON.parse(readFileSync(agentFile, "utf8")) as Record<string, unknown>;
    const hbAt = obj.heartbeat_at;
    if (typeof hbAt !== "string") return null;
    const hbMs = Date.parse(hbAt);
    if (!Number.isFinite(hbMs)) return null;
    return Date.now() - hbMs;
  } catch (_) {
    return null;
  }
}

const HEARTBEAT_TTL_MS = parseInt(process.env.GOAL_HEARTBEAT_TTL_MS ?? "15000", 10);

function readAndPruneLanesInner(goalDir: string): LanesFile {
  const data = readLanesFileInner(goalDir);
  const now = Date.now();
  const active = data.leases.filter((lease) => {
    const acquiredMs = Date.parse(lease.acquired_at);
    if (Number.isFinite(acquiredMs) && now - acquiredMs > lease.ttl_seconds * 1000) return false;
    const age = getHolderHeartbeatAgeMs(goalDir, lease.holder);
    if (age !== null && age > HEARTBEAT_TTL_MS) return false;
    return true;
  });
  if (active.length !== data.leases.length) {
    writeLanesFileInner(goalDir, { leases: active });
    return { leases: active };
  }
  return data;
}

function globToRegexInner(glob: string): RegExp {
  let pattern = "^";
  let i = 0;
  while (i < glob.length) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        pattern += ".*";
        i += 2;
        if (glob[i] === "/") i++;
      } else {
        pattern += "[^/]*";
        i++;
      }
    } else if (ch === "?") {
      pattern += "[^/]";
      i++;
    } else if (/[.+^${}()|[\]\\]/.test(ch)) {
      pattern += "\\" + ch;
      i++;
    } else {
      pattern += ch;
      i++;
    }
  }
  pattern += "$";
  return new RegExp(pattern);
}

function samplePathFromGlobInner(glob: string): string {
  return glob.replace(/\*\*\//g, "a/b/").replace(/\*\*/g, "a/b").replace(/\*/g, "x").replace(/\?/g, "y");
}

function globsConflictInner(globA: string, globB: string): boolean {
  const sA = samplePathFromGlobInner(globA);
  const sB = samplePathFromGlobInner(globB);
  try {
    const rA = globToRegexInner(globA);
    const rB = globToRegexInner(globB);
    return rA.test(sB) || rB.test(sA);
  } catch (_) {
    return true; // conservative
  }
}

function claimLaneInner(
  goalDir: string, holder: string, glob: string, ttlSeconds: number, reason: string
): ClaimLaneResult {
  const data = readAndPruneLanesInner(goalDir);
  for (const existing of data.leases) {
    if (existing.holder === holder && existing.glob === glob) {
      // Renewal by same holder.
      const renewed = data.leases.map((l) =>
        l.lease_id === existing.lease_id
          ? { ...l, acquired_at: nowIso(), ttl_seconds: ttlSeconds, reason }
          : l,
      );
      writeLanesFileInner(goalDir, { leases: renewed });
      return { ok: true, lease_id: existing.lease_id };
    }
    if (existing.holder !== holder && globsConflictInner(glob, existing.glob)) {
      return { ok: false, conflict_with: existing.lease_id };
    }
  }
  const leaseId = randomUUID();
  writeLanesFileInner(goalDir, {
    leases: [...data.leases, { lease_id: leaseId, glob, holder, acquired_at: nowIso(), ttl_seconds: ttlSeconds, reason }],
  });
  return { ok: true, lease_id: leaseId };
}

function releaseLaneInner(goalDir: string, leaseId: string): boolean {
  const data = readLanesFileInner(goalDir);
  const after = data.leases.filter((l) => l.lease_id !== leaseId);
  if (after.length === data.leases.length) return false;
  writeLanesFileInner(goalDir, { leases: after });
  return true;
}

// ── CoworkYml inline (mirrors cowork/cowork-yml.ts) ──────────────────────────

interface CoworkAgentConfig { runner: string; model: string; }
interface CoworkRoles { lead: string | null; build: string | null; review: string | null; }
interface CoworkRelayConfig { on_rate_limit: boolean; on_5xx: boolean; small_model_offload: boolean; }
interface CoworkConfig {
  version: number;
  agents: Record<string, CoworkAgentConfig>;
  roles: CoworkRoles;
  relay: CoworkRelayConfig;
  heartbeat_ttl_seconds: number;
}

function parseCoworkYmlInner(text: string): CoworkConfig {
  const lines = text.split(/\r?\n/);
  const cleaned = lines.map((l) => l.replace(/\s*#[^\n]*$/, ""));
  const result: { version?: number; agents: Record<string, CoworkAgentConfig>; roles: CoworkRoles; relay: CoworkRelayConfig; heartbeat_ttl_seconds?: number } = {
    agents: {}, roles: { lead: null, build: null, review: null },
    relay: { on_rate_limit: true, on_5xx: true, small_model_offload: false },
  };
  type Section = "top" | "agents" | "agents.entry" | "roles" | "relay";
  let section: Section = "top";
  let currentAgent = "";

  for (const raw of cleaned) {
    if (!raw.trim()) continue;
    const indent = raw.search(/\S/);
    const content = raw.trim();
    const colonIdx = content.indexOf(":");
    if (colonIdx < 0) continue;
    const key = content.slice(0, colonIdx).trim();
    const value = content.slice(colonIdx + 1).trim();

    if (indent === 0) {
      switch (key) {
        case "version": result.version = parseFloat(value); section = "top"; break;
        case "heartbeat_ttl_seconds": result.heartbeat_ttl_seconds = parseFloat(value); section = "top"; break;
        case "agents": section = "agents"; currentAgent = ""; break;
        case "roles": section = "roles"; break;
        case "relay": section = "relay"; break;
        default: section = "top"; break;
      }
    } else if (indent === 2) {
      if (section === "agents" || section === "agents.entry") {
        if (/^[a-zA-Z0-9_-]+$/.test(key)) {
          currentAgent = key;
          if (!result.agents[currentAgent]) result.agents[currentAgent] = { runner: "", model: "default" };
          section = "agents.entry";
        }
      } else if (section === "roles") {
        if (key === "lead" || key === "build" || key === "review") result.roles[key] = value || null;
      } else if (section === "relay") {
        if (key === "on_rate_limit" || key === "on_5xx" || key === "small_model_offload") {
          (result.relay as unknown as Record<string, boolean>)[key] = value === "true" || value === "yes";
        }
      }
    } else if (indent === 4) {
      if ((section === "agents" || section === "agents.entry") && currentAgent) {
        if (key === "runner") result.agents[currentAgent].runner = value;
        if (key === "model") result.agents[currentAgent].model = value || "default";
      }
    }
  }
  return {
    version: result.version ?? 1, agents: result.agents, roles: result.roles,
    relay: result.relay, heartbeat_ttl_seconds: result.heartbeat_ttl_seconds ?? 15,
  };
}

function loadCoworkYmlInner(goalDir: string): CoworkConfig | null {
  const fp = join(goalDir, "cowork.yml");
  if (!existsSync(fp)) return null;
  try {
    return parseCoworkYmlInner(readFileSync(fp, "utf8"));
  } catch (_) {
    return null;
  }
}

function getRoleForAgentInner(config: CoworkConfig, agentId: string): string | null {
  const roles = config.roles as unknown as Record<string, string | null>;
  for (const [role, agent] of Object.entries(roles)) {
    if (agent === agentId) return role;
  }
  return null;
}

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import lockfile from "proper-lockfile";

// ────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────

// v2 adds relaying and queued; v1 readers must tolerate these on read.
type GoalStatus = "pursuing" | "paused" | "achieved" | "needs-input" | "budget-limited" | "relaying" | "queued";

/** One task-level checkpoint inside a durable goal spec. */
interface GoalTaskSpec {
  id?: string;
  title?: string;
  outcome?: string;
  verification?: string;
  files?: string[];
  owner?: string;
}

/** Structured objective from the `goalframe` skill. All fields optional; stored verbatim. */
interface GoalSpec {
  title?: string;
  outcome?: string;
  verification?: string;
  constraints?: string;
  boundaries?: string;
  iteration?: string;
  blocked_when?: string;
  tasks?: GoalTaskSpec[];
  assumptions?: string | string[];
}

interface HistoryEntry {
  ts: string;
  action: string;
  note: string;
}

interface LineageEntry {
  agent: string;
  model: string;
  started_at: string;
  ended_at: string | null;
  turns: number;
  tokens: number;
  summary: string;
}

interface GoalRoles {
  lead: string | null;
  build: string | null;
  review: string | null;
}

interface GoalCurrent {
  agent: string | null;
  session: string | null;
  since: string | null;
}

interface GoalState {
  // v2 fields (additive, optional for backward compat reads from v1)
  schema_version?: number;
  goal_id: string;
  objective: string;
  /**
   * Structured objective produced by the `goalframe` skill at /goal time.
   * Stored once; the Stop-hook dispatcher references it on every continuation
   * tick instead of re-pasting the raw objective. Opaque to this server.
   */
  spec?: GoalSpec | null;
  status: GoalStatus;
  created_at: string;
  updated_at: string;
  // The bash `goalctl` writes `null` when no budget is set. Match that shape.
  token_budget: number | null;
  tokens_used: number;
  tick_count: number;
  /**
   * Cumulative seconds the goal has spent in `pursuing` status across all
   * pursue/pause cycles. Default 0. Maintained by every writer.
   */
  pursuing_seconds: number;
  /**
   * ISO8601 UTC timestamp at which the current pursuing session began.
   * Non-null ONLY when `status === "pursuing"`.
   */
  pursuing_since: string | null;
  history: HistoryEntry[];
  // v2 additive fields (all optional — absent on v1 files; populated on migration)
  compat?: string[];
  roles?: GoalRoles | null;
  current?: GoalCurrent | null;
  budget?: { kind: string; limit: number; used: number } | null;
  lineage?: LineageEntry[];
  audit?: { checklist: Array<{ id: string; predicate: string; status: string; evidence: string | null }> } | null;
  handoff_head?: string | null;
  queued_until?: string | null;
  time_used_seconds?: number;
  observed_at?: string;
  active_turn_started_at?: string | null;
  tokens_used_observed_at?: string;
  time_used_seconds_final?: number | null;
  tokens_used_final?: number | null;
}

interface GoalView extends GoalState {
  remaining_tokens: number | null;
  elapsed_seconds: number;
}

type ErrorCode =
  | "no_active_goal"
  | "goal_exists_and_active"
  | "goal_id_mismatch"
  | "invalid_input"
  | "file_lock_failed"
  | "io_error";

class ToolError extends Error {
  constructor(public readonly code: ErrorCode, message: string, public readonly details?: Record<string, unknown>) {
    super(message);
    this.name = "ToolError";
  }
}

// ────────────────────────────────────────────────────────────────────────────
// stderr-only logger (stdout is the MCP transport)
// ────────────────────────────────────────────────────────────────────────────

function logDebug(msg: string, extra?: Record<string, unknown>): void {
  if (process.env.GOAL_MCP_DEBUG === "1") {
    const line = extra ? `${msg} ${JSON.stringify(extra)}` : msg;
    process.stderr.write(`[goal-mcp] ${line}\n`);
  }
}

function logError(msg: string, extra?: Record<string, unknown>): void {
  const line = extra ? `${msg} ${JSON.stringify(extra)}` : msg;
  process.stderr.write(`[goal-mcp] ERROR: ${line}\n`);
}

// ────────────────────────────────────────────────────────────────────────────
// Goal-root discovery — v3 session-scoped layout
//
// A "goal root" is the directory containing the project's `.goal/`. The MCP
// server resolves it once per tool call by:
//   1) $GOAL_ROOT env var (test/override)
//   2) Walk up from cwd looking for an existing .goal/ (v3), .goal/state.json
//      (v2 legacy), or .claude/goal.json (v1 legacy). Stops at $HOME so the
//      user-scope ~/.claude is never picked as a project root.
//   3) For create_goal: fall back to cwd. For other tools: caller decides.
//
// The session that owns a given goal is identified by reading the v3 session
// pointer at $GOAL_ROOT/.goal/sessions/<session_id>. Pointers are written by
// `create_goal` (and by `/goal adopt` in the slash command) — never as a side
// effect of a read.
// ────────────────────────────────────────────────────────────────────────────

export interface ResolveOptions {
  cwd?: string;
  home?: string;
  sessionId?: string;
  env?: NodeJS.ProcessEnv;
}

export interface ResolvedRoot {
  root: string;            // directory containing .goal/ (or, for create, cwd)
  source: "env" | "walk-up" | "cwd-fallback";
}

/** Pure function for testing. Returns null when no existing goal root is found. */
export function discoverExistingGoalRoot(opts: ResolveOptions = {}): ResolvedRoot | null {
  const env = opts.env ?? process.env;
  const cwd = opts.cwd ?? process.cwd();
  const home = opts.home ?? env.HOME ?? homedir();

  // 1) GOAL_ROOT env var — trust it if it exists and is a directory.
  const envRoot = env.GOAL_ROOT;
  if (envRoot && envRoot.length > 0) {
    try {
      if (statSync(envRoot).isDirectory()) {
        return { root: resolve(envRoot), source: "env" };
      }
    } catch {
      // Treat as opt-in: env var pointed at a yet-to-be-created dir. Callers
      // that need to verify existence do so explicitly.
      return { root: resolve(envRoot), source: "env" };
    }
  }

  // 2) Walk up from cwd until we hit /, $HOME, or run out of parents.
  //    Recognise v3 (.goal/), v2 (.goal/state.json), or v1 (.claude/goal.json).
  let d = resolve(cwd);
  for (let i = 0; i < 64; i++) {
    if (!d || d === "/" || d === home) break;
    // v3: .goal/ directory exists (covers fresh v3, migrated v2, channel state, etc.)
    try {
      const lst = lstatSync(join(d, ".goal"));
      if (lst.isDirectory() && !lst.isSymbolicLink()) {
        return { root: d, source: "walk-up" };
      }
    } catch { /* not present */ }
    // v1 legacy: still recognise .claude/goal.json so the migrator picks it up.
    try {
      const lst = lstatSync(join(d, ".claude", "goal.json"));
      if (lst.isFile() && !lst.isSymbolicLink()) {
        return { root: d, source: "walk-up" };
      }
    } catch { /* keep walking */ }
    const parent = dirname(d);
    if (parent === d) break;
    d = parent;
  }

  return null;
}

/** Resolves root for an operation. Caller controls fallback behaviour. */
export function resolveRootForCreate(opts: ResolveOptions = {}): ResolvedRoot {
  const existing = discoverExistingGoalRoot(opts);
  if (existing) return existing;
  return { root: resolve(opts.cwd ?? process.cwd()), source: "cwd-fallback" };
}

/**
 * Resolve the current session id for binding/owner lookups. Claude Code v2.1.x
 * exposes the live id as CLAUDE_CODE_SESSION_ID; older/local harnesses may set
 * CLAUDE_SESSION_ID, and tests can use GOAL_SESSION_ID. Returns null if no
 * session is available — callers must handle the "unbound" case.
 *
 * Hardening: refuse session ids that would escape the sessions/ directory or
 * exceed a sane length cap.
 */
export function currentSessionId(env: NodeJS.ProcessEnv = process.env): string | null {
  return sanitizeSessionId(env.CLAUDE_CODE_SESSION_ID ?? env.CLAUDE_SESSION_ID ?? env.GOAL_SESSION_ID ?? null);
}

function sanitizeSessionId(raw: unknown): string | null {
  if (!raw) return null;
  const trimmed = String(raw).trim();
  if (trimmed.length === 0 || trimmed.length > 256) return null;
  if (trimmed.includes("/") || trimmed.includes("\\") || trimmed.includes("..") || trimmed.includes("\0")) return null;
  return trimmed;
}

// ────────────────────────────────────────────────────────────────────────────
// File paths derived from root — v3 session-scoped layout
// ────────────────────────────────────────────────────────────────────────────

interface GoalPaths {
  root: string;
  claudeDir: string;         // .claude/         legacy (logs, baseline files, marker)
  goalDir: string;           // .goal/
  goalsDir: string;          // .goal/goals/     per-goal records (<gid>.json)
  sessionsDir: string;       // .goal/sessions/  per-session pointer files (text: gid)
  locksDir: string;          // .goal/locks/     per-goal lockfiles
  cursorsDir: string;        // .goal/cursors/   dispatcher progress cursors
  eventsFile: string;        // .goal/events.jsonl
  pauseFile: string;         // .goal/pause      kill switch
  v1GoalFile: string;        // .claude/goal.json  (migration source — legacy)
  v2GoalFile: string;        // .goal/state.json   (migration source — legacy)
  baselineGlobPrefix: string;
  markerFile: string;        // .claude/MIGRATED_TO_GOAL
}

function pathsFor(root: string): GoalPaths {
  const claudeDir = join(root, ".claude");
  const goalDir = join(root, ".goal");
  return {
    root,
    claudeDir,
    goalDir,
    goalsDir: join(goalDir, "goals"),
    sessionsDir: join(goalDir, "sessions"),
    locksDir: join(goalDir, "locks"),
    cursorsDir: join(goalDir, "cursors"),
    eventsFile: join(goalDir, "events.jsonl"),
    pauseFile: join(goalDir, "pause"),
    v1GoalFile: join(claudeDir, "goal.json"),
    v2GoalFile: join(goalDir, "state.json"),
    baselineGlobPrefix: "goal-baseline-",
    markerFile: join(claudeDir, "MIGRATED_TO_GOAL"),
  };
}

function ensureClaudeDir(paths: GoalPaths): void {
  mkdirSync(paths.claudeDir, { recursive: true });
}

/** Ensure all v3 subdirectories exist. Cheap; idempotent. */
function ensureV3Dirs(paths: GoalPaths): void {
  mkdirSync(paths.goalDir, { recursive: true });
  mkdirSync(paths.goalsDir, { recursive: true });
  mkdirSync(paths.sessionsDir, { recursive: true });
  mkdirSync(paths.locksDir, { recursive: true });
  mkdirSync(paths.cursorsDir, { recursive: true });
}

/** Per-goal record path: .goal/goals/<gid>.json */
function goalRecordPath(paths: GoalPaths, gid: string): string {
  return join(paths.goalsDir, `${gid}.json`);
}

/** Per-session pointer path: .goal/sessions/<sid> — content is the goal_id. */
function sessionPointerPath(paths: GoalPaths, sid: string): string {
  return join(paths.sessionsDir, sid);
}

/** Per-goal lockfile path: .goal/locks/<gid>.lock */
function goalLockfilePath(paths: GoalPaths, gid: string): string {
  return join(paths.locksDir, `${gid}.lock`);
}

/** Project-coordination lockfile (for cross-goal shared state: lanes, etc.). */
function coordLockfilePath(paths: GoalPaths): string {
  return join(paths.locksDir, "_coord.lock");
}

// ────────────────────────────────────────────────────────────────────────────
// Migration: v1 (.claude/goal.json) → v2 (.goal/state.json) → v3 (.goal/goals/<gid>.json)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Forward-migrate any legacy state to the v3 layout. Idempotent; safe to run
 * on every tool entry. The two stages:
 *
 *   v1 → v2:  .claude/goal.json     → .goal/state.json    (legacy, rare in practice)
 *   v2 → v3:  .goal/state.json      → .goal/goals/<gid>.json
 *
 * v3 migration NEVER auto-binds the migrating record to the calling session
 * (per RFC §5: "the next /goal or /goal adopt binds a session"). Terminal
 * records (`achieved`, `budget-limited`) carry forward as-is and simply don't
 * render in the statusline (no session owns them).
 *
 * Diagnostics go to .claude/goal-hook.log; failures throw `io_error`.
 */
async function migrateIfNeeded(paths: GoalPaths): Promise<void> {
  if (process.env.GOAL_DISABLE_MIGRATION === "1") return;

  // v1 → v2 (legacy path; almost no one is here anymore).
  if (existsSync(paths.v1GoalFile) && !existsSync(paths.v2GoalFile) && !existsSync(paths.goalsDir)) {
    await migrateV1ToV2(paths);
  }

  // v2 → v3 (the common case post-merge: every previously-merged install has v2 state.json).
  if (existsSync(paths.v2GoalFile)) {
    await migrateV2ToV3(paths);
  }
}

async function migrateV1ToV2(paths: GoalPaths): Promise<void> {
  ensureClaudeDir(paths);
  try {
    await withLegacyV1Lock(paths, async () => {
      if (existsSync(paths.v2GoalFile) || existsSync(paths.goalsDir)) return; // another runner won
      if (!existsSync(paths.v1GoalFile)) return;

      let v1Raw: unknown;
      try {
        v1Raw = JSON.parse(readFileSync(paths.v1GoalFile, "utf8"));
      } catch (err) {
        const msg = (err as Error)?.message ?? String(err);
        appendMigrationLog(paths, "migration-v1-parse-failed", msg);
        throw new ToolError("io_error", `migration: cannot parse v1 goal.json: ${msg}`);
      }
      if (typeof v1Raw !== "object" || v1Raw === null) {
        appendMigrationLog(paths, "migration-v1-invalid", "not an object");
        throw new ToolError("io_error", "migration: v1 goal.json is not an object");
      }

      const v1 = v1Raw as Record<string, unknown>;
      const v1Status = typeof v1.status === "string" ? v1.status : "pursuing";
      const v1Ticks = typeof v1.tick_count === "number" ? v1.tick_count : 0;
      const v1Tokens = typeof v1.tokens_used === "number" ? v1.tokens_used : 0;
      const v1Created = typeof v1.created_at === "string" ? v1.created_at : nowIso();
      const v1Updated = typeof v1.updated_at === "string" ? v1.updated_at : nowIso();
      const isActive = v1Status === "pursuing" || v1Status === "paused";
      const endedAt = isActive ? null : v1Updated;

      const v2State: GoalState = {
        ...(v1 as Partial<GoalState>),
        schema_version: 2,
        goal_id: typeof v1.goal_id === "string" ? v1.goal_id : randomUUID(),
        objective: typeof v1.objective === "string" ? v1.objective : "",
        status: (VALID_STATUSES.includes(v1Status as GoalStatus) ? v1Status : "pursuing") as GoalStatus,
        created_at: v1Created,
        updated_at: v1Updated,
        time_used_seconds: typeof v1.pursuing_seconds === "number" ? v1.pursuing_seconds : 0,
        observed_at: v1Updated,
        active_turn_started_at: v1Status === "pursuing" ? (typeof v1.pursuing_since === "string" ? v1.pursuing_since : v1Updated) : null,
        tokens_used_observed_at: v1Updated,
        time_used_seconds_final: isActive ? null : (typeof v1.pursuing_seconds === "number" ? v1.pursuing_seconds : null),
        tokens_used_final: isActive ? null : v1Tokens,
        token_budget: (typeof v1.token_budget === "number" ? v1.token_budget : null),
        tokens_used: v1Tokens,
        tick_count: v1Ticks,
        pursuing_seconds: typeof v1.pursuing_seconds === "number" ? v1.pursuing_seconds : 0,
        pursuing_since: typeof v1.pursuing_since === "string" ? v1.pursuing_since : null,
        history: Array.isArray(v1.history) ? (v1.history as HistoryEntry[]) : [],
        compat: ["claude-code"],
        roles: { lead: null, build: null, review: null },
        current: { agent: null, session: null, since: null },
        budget: null,
        lineage: [{
          agent: "claude-code", model: "unknown", started_at: v1Created, ended_at: endedAt,
          turns: v1Ticks, tokens: v1Tokens, summary: "migrated from v1",
        }],
        audit: null, handoff_head: null, queued_until: null,
      };

      mkdirSync(paths.goalDir, { recursive: true });
      try {
        atomicWriteJson(paths.v2GoalFile, v2State);
      } catch (err) {
        try { rmdirSync(paths.goalDir); } catch { /* best-effort */ }
        const msg = (err as Error)?.message ?? String(err);
        appendMigrationLog(paths, "migration-v1-write-failed", msg);
        throw new ToolError("io_error", `migration: cannot write .goal/state.json: ${msg}`);
      }
      try { writeFileSync(paths.markerFile, nowIso() + "\n", { encoding: "utf8", mode: 0o644 }); } catch { /* best-effort */ }
      appendMigrationLog(paths, "migration-v1-v2-done", "migrated v1→v2");
      logDebug("migration v1→v2 complete", { root: paths.root });
    });
  } catch (err) {
    if (err instanceof ToolError) throw err;
    throw new ToolError("io_error", `v1→v2 migration failed: ${(err as Error)?.message}`);
  }
}

async function migrateV2ToV3(paths: GoalPaths): Promise<void> {
  ensureV3Dirs(paths);
  try {
    // Take a project lock (not per-goal yet — we don't know the gid). The
    // lockfile is in .goal/locks/, the same place v3 RMW takes per-goal locks,
    // so we serialize cleanly against concurrent create_goal/get_goal callers.
    await withProjectLock(paths, () => {
      if (!existsSync(paths.v2GoalFile)) return; // another runner won
      let v2Raw: unknown;
      try {
        v2Raw = JSON.parse(readFileSync(paths.v2GoalFile, "utf8"));
      } catch (err) {
        const msg = (err as Error)?.message ?? String(err);
        appendMigrationLog(paths, "migration-v2-parse-failed", msg);
        throw new ToolError("io_error", `migration v2→v3: cannot parse state.json: ${msg}`);
      }
      const state = validateGoalState(v2Raw);
      const gid = state.goal_id;
      if (!UUID_RE.test(gid)) {
        appendMigrationLog(paths, "migration-v2-bad-gid", `goal_id=${gid}`);
        throw new ToolError("io_error", `migration v2→v3: invalid goal_id "${gid}"`);
      }
      const target = goalRecordPath(paths, gid);
      // Idempotency: if target already exists with the same gid, just remove
      // the legacy file. If it exists with a different content, prefer the v3
      // record (it is the post-migration source of truth).
      if (existsSync(target)) {
        try { unlinkSync(paths.v2GoalFile); } catch { /* best-effort */ }
        appendMigrationLog(paths, "migration-v2-v3-skipped-target-exists", target);
        return;
      }
      // Write v3 record, then unlink the v2 file (atomic enough: the record
      // exists before we remove the old file).
      atomicWriteJson(target, state);
      try { unlinkSync(paths.v2GoalFile); } catch (err) {
        appendMigrationLog(paths, "migration-v2-unlink-failed",
          `wrote ${target} but failed to remove ${paths.v2GoalFile}: ${(err as Error)?.message}`);
      }
      // Do NOT auto-bind to current session (RFC §5). The next /goal create or
      // /goal adopt writes the pointer.
      appendMigrationLog(paths, "migration-v2-v3-done", `gid=${gid}`);
      logDebug("migration v2→v3 complete", { root: paths.root, gid });
      // Emit a one-line event so users can see this in events.jsonl.
      appendEvent(paths, {
        ts: nowIso(),
        type: "goal.migrated",
        goal_id: gid,
        note: "v2 state.json → v3 goals/<gid>.json (unowned; bind via /goal adopt)",
      });
    });
  } catch (err) {
    if (err instanceof ToolError) throw err;
    throw new ToolError("io_error", `v2→v3 migration failed: ${(err as Error)?.message}`);
  }
}

function appendMigrationLog(paths: GoalPaths, event: string, note: string): void {
  const line = JSON.stringify({
    ts: nowIso(),
    pid: process.pid,
    event,
    root: paths.root,
    note,
  }) + "\n";
  try {
    appendFileSync(join(paths.claudeDir, "goal-hook.log"), line, { encoding: "utf8" });
  } catch { /* best-effort */ }
}

// ────────────────────────────────────────────────────────────────────────────
// Atomic JSON write
// ────────────────────────────────────────────────────────────────────────────

function atomicWriteJson(targetPath: string, value: unknown): void {
  const dir = dirname(targetPath);
  mkdirSync(dir, { recursive: true });
  // Make a unique tmp in the SAME directory so rename(2) is atomic on the same FS.
  const tmpDir = mkdtempSync(join(dir, ".goal-write-"));
  const tmpFile = join(tmpDir, "goal.json.tmp");
  try {
    const payload = JSON.stringify(value, null, 2) + "\n";
    writeFileSync(tmpFile, payload, { encoding: "utf8", mode: 0o644 });
    // fsync the file so rename actually flushes contents on power loss.
    const fd = openSync(tmpFile, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmpFile, targetPath);
  } finally {
    // Cleanup the tmp dir; if rename succeeded the tmp file is already gone.
    try {
      if (existsSync(tmpFile)) unlinkSync(tmpFile);
    } catch { /* best-effort */ }
    try {
      // We constructed an empty dir specifically; safe to remove.
      rmdirSync(tmpDir);
    } catch { /* best-effort */ }
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Locked read-modify-write
// ────────────────────────────────────────────────────────────────────────────

/**
 * Per-goal RMW lock. Granularity: one lockfile per goal at .goal/locks/<gid>.lock.
 *
 * v3 lock model: a goal is owned by exactly one session, but the MCP server may
 * be called concurrently for *different* goals in the same project (two Claude
 * sessions, same folder). Locking per-goal means session A's slow RMW on goal A
 * cannot starve session B's RMW on goal B. The bash Stop hook uses the same
 * .goal/locks/<gid>.lock path (mkdir mutex), so the two writers serialize on
 * the same file across runtimes.
 *
 * proper-lockfile's lockfilePath option points at a directory whose existence
 * is the mutex. We point it at the same path the bash side uses (a directory),
 * so both runtimes agree.
 */
async function withGoalLock<T>(
  paths: GoalPaths,
  gid: string,
  fn: () => Promise<T> | T,
): Promise<T> {
  ensureV3Dirs(paths);
  const lockfilePath = goalLockfilePath(paths, gid);
  return acquireAndRun(paths, lockfilePath, fn);
}

/**
 * Project-coordination lock — for tools that touch cross-goal shared state
 * (lanes.json, channel debouncer, etc.). Granularity: one lockfile per project
 * at .goal/locks/_coord.lock.
 */
async function withProjectLock<T>(
  paths: GoalPaths,
  fn: () => Promise<T> | T,
): Promise<T> {
  ensureV3Dirs(paths);
  return acquireAndRun(paths, coordLockfilePath(paths), fn);
}

/**
 * Lock the v1 legacy file during migration. The v1 path is .claude/goal.lock
 * (proper-lockfile semantics, mkdir mutex). Only used by migrateIfNeeded so v1
 * → v3 migration is single-shot across runners.
 */
async function withLegacyV1Lock<T>(
  paths: GoalPaths,
  fn: () => Promise<T> | T,
): Promise<T> {
  ensureClaudeDir(paths);
  return acquireAndRun(paths, join(paths.claudeDir, "goal.lock"), fn);
}

async function acquireAndRun<T>(
  _paths: GoalPaths,
  lockfilePath: string,
  fn: () => Promise<T> | T,
): Promise<T> {
  // proper-lockfile demands the lock TARGET exist. We use the lockfilePath
  // directory's parent as the target — the parent (locks/ or .claude/) is
  // guaranteed to exist by the ensure* call above.
  const lockTarget = dirname(lockfilePath);
  mkdirSync(lockTarget, { recursive: true });

  let release: (() => Promise<void>) | null = null;
  try {
    release = await lockfile.lock(lockTarget, {
      stale: 30_000,
      retries: { retries: 10, factor: 1.5, minTimeout: 50, maxTimeout: 500, randomize: true },
      realpath: false,
      lockfilePath,
    });
  } catch (err) {
    throw new ToolError("file_lock_failed", "could not acquire goal lock", {
      reason: (err as Error)?.message,
      lockfilePath,
    });
  }
  try {
    return await fn();
  } finally {
    try {
      if (release) await release();
    } catch (err) {
      logError("failed to release lock", { reason: (err as Error)?.message, lockfilePath });
    }
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Goal state read / view / event emission
// ────────────────────────────────────────────────────────────────────────────

/**
 * Read one goal record by id from .goal/goals/<gid>.json. Returns null if the
 * file does not exist; throws if it exists but can't be read/parsed.
 */
function readGoalRecord(paths: GoalPaths, gid: string): GoalState | null {
  const file = goalRecordPath(paths, gid);
  if (!existsSync(file)) return null;
  try {
    const lst = lstatSync(file);
    if (!lst.isFile() || lst.isSymbolicLink()) return null;
    const raw = readFileSync(file, "utf8");
    return validateGoalState(JSON.parse(raw));
  } catch (err) {
    throw new ToolError("io_error", `failed to read goal record ${gid}`, {
      file,
      reason: (err as Error)?.message,
    });
  }
}

/**
 * Read the goal_id this session owns from .goal/sessions/<sid>. Returns null
 * if the pointer is absent, malformed, or names a goal_id that doesn't pass
 * UUID validation. The pointer must agree with the record it names — that
 * check is the caller's (read the record by the returned gid).
 */
function readSessionPointer(paths: GoalPaths, sid: string): string | null {
  const ptr = sessionPointerPath(paths, sid);
  try {
    const lst = lstatSync(ptr);
    if (!lst.isFile() || lst.isSymbolicLink()) return null;
    const gid = readFileSync(ptr, "utf8").trim();
    if (!UUID_RE.test(gid)) return null;
    return gid;
  } catch {
    return null;
  }
}

/**
 * List every goal record in this project. Used by:
 *   - resolveOwnedOrUniqueActive (for sessions without a pointer)
 *   - the channel push manager (to find the pursuing goal to push for)
 *   - /goal discover (slash command — via the bash helper, not this fn)
 *
 * Best-effort: unreadable records are silently skipped, never thrown.
 */
function listAllGoalRecords(paths: GoalPaths): GoalState[] {
  if (!existsSync(paths.goalsDir)) return [];
  let entries: string[];
  try {
    entries = readdirSync(paths.goalsDir);
  } catch { return []; }
  const goals: GoalState[] = [];
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    if (name.startsWith(".")) continue;
    const gid = name.slice(0, -5); // strip ".json"
    if (!UUID_RE.test(gid)) continue;
    try {
      const goal = readGoalRecord(paths, gid);
      if (goal) goals.push(goal);
    } catch { /* skip unreadable */ }
  }
  return goals;
}

/**
 * Resolve a goal for a tool call that operates on an existing goal (get_goal,
 * update_goal, P5 coordination tools). Resolution order:
 *
 *   1) Session pointer  — .goal/sessions/<session id> names the gid.
 *      The record is loaded and the pointer/record gid-agreement is verified;
 *      a dangling or disagreeing pointer falls through to (2).
 *   2) Single-active fallback — if exactly one non-terminal goal exists in
 *      the project, return it. This is intentionally narrow: it adopts only
 *      when there is no ambiguity. With ≥2 active goals, callers must
 *      disambiguate (e.g. /goal adopt) or error with no_active_goal.
 *
 * Returns null if no goal can be resolved. Read-only — never writes the
 * session pointer as a side effect.
 */
function resolveGoalForSession(paths: GoalPaths, sessionId?: string | null): { state: GoalState; source: "pointer" | "single-active" } | null {
  const sid = sessionId ?? currentSessionId();
  if (sid) {
    const gid = readSessionPointer(paths, sid);
    if (gid) {
      try {
        const state = readGoalRecord(paths, gid);
        if (state && state.goal_id === gid) {
          return { state, source: "pointer" };
        }
      } catch { /* dangling pointer; fall through */ }
    }
  }
  const all = listAllGoalRecords(paths);
  const active = all.filter((g) =>
    g.status === "pursuing" || g.status === "paused" || g.status === "needs-input" || g.status === "relaying" || g.status === "queued",
  );
  if (active.length === 1) return { state: active[0], source: "single-active" };
  return null;
}

// All 7 lifecycle statuses — v2 adds relaying and queued.
const VALID_STATUSES: GoalStatus[] = [
  "pursuing", "paused", "achieved", "needs-input", "budget-limited", "relaying", "queued",
];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Hand-rolled schema validation for v2 state.json writes.
 * Throws ToolError("io_error") on any violation.
 * Called before every atomicWriteJson in the MCP server.
 */
function validateStateV2(obj: unknown): void {
  if (typeof obj !== "object" || obj === null) {
    throw new ToolError("io_error", "state.json: not an object");
  }
  const v = obj as Record<string, unknown>;

  // schema_version must be 2.
  if (v.schema_version !== 2) {
    throw new ToolError("io_error", `state.json: schema_version must be 2 (got ${JSON.stringify(v.schema_version)})`);
  }

  // Required string fields.
  const required = ["goal_id", "objective", "status", "created_at", "updated_at"] as const;
  for (const k of required) {
    if (typeof v[k] !== "string") {
      throw new ToolError("io_error", `state.json: missing or non-string required field "${k}"`);
    }
  }

  // goal_id must be UUID-shaped.
  if (!UUID_RE.test(v.goal_id as string)) {
    throw new ToolError("io_error", `state.json: goal_id is not a valid UUID: "${v.goal_id}"`);
  }

  // status must be one of the 7 values.
  if (!VALID_STATUSES.includes(v.status as GoalStatus)) {
    throw new ToolError("io_error", `state.json: invalid status "${v.status}"`);
  }

  // lineage must be an array if present.
  if (v.lineage !== undefined && v.lineage !== null && !Array.isArray(v.lineage)) {
    throw new ToolError("io_error", "state.json: lineage must be an array");
  }

  // roles shape if present and non-null.
  if (v.roles !== undefined && v.roles !== null) {
    if (typeof v.roles !== "object" || Array.isArray(v.roles)) {
      throw new ToolError("io_error", "state.json: roles must be an object or null");
    }
    const roles = v.roles as Record<string, unknown>;
    for (const k of ["lead", "build", "review"] as const) {
      if (roles[k] !== undefined && roles[k] !== null && typeof roles[k] !== "string") {
        throw new ToolError("io_error", `state.json: roles.${k} must be string or null`);
      }
    }
  }

  // current shape if present and non-null.
  if (v.current !== undefined && v.current !== null) {
    if (typeof v.current !== "object" || Array.isArray(v.current)) {
      throw new ToolError("io_error", "state.json: current must be an object or null");
    }
    const cur = v.current as Record<string, unknown>;
    for (const k of ["agent", "session", "since"] as const) {
      if (cur[k] !== undefined && cur[k] !== null && typeof cur[k] !== "string") {
        throw new ToolError("io_error", `state.json: current.${k} must be string or null`);
      }
    }
  }

  for (const k of ["time_used_seconds", "tokens_used", "tokens_used_final", "time_used_seconds_final"] as const) {
    if (v[k] !== undefined && v[k] !== null && typeof v[k] !== "number") {
      throw new ToolError("io_error", `state.json: ${k} must be number or null`);
    }
  }
  for (const k of ["observed_at", "active_turn_started_at", "tokens_used_observed_at"] as const) {
    if (v[k] !== undefined && v[k] !== null && typeof v[k] !== "string") {
      throw new ToolError("io_error", `state.json: ${k} must be string or null`);
    }
  }
}

function validateGoalState(value: unknown): GoalState {
  if (typeof value !== "object" || value === null) {
    throw new ToolError("io_error", "goal state: not an object");
  }
  const v = value as Record<string, unknown>;
  const required = ["goal_id", "objective", "status", "created_at", "updated_at"] as const;
  for (const k of required) {
    if (typeof v[k] !== "string") {
      throw new ToolError("io_error", `goal state: missing or non-string field "${k}"`);
    }
  }
  const status = v.status as string;
  if (!VALID_STATUSES.includes(status as GoalStatus)) {
    throw new ToolError("io_error", `goal state: invalid status "${status}"`);
  }
  const token_budget = v.token_budget;
  if (token_budget !== null && token_budget !== undefined && !(typeof token_budget === "number" && Number.isInteger(token_budget))) {
    throw new ToolError("io_error", "goal.json: token_budget must be integer or null");
  }
  const tokens_used = typeof v.tokens_used === "number" ? v.tokens_used : 0;
  const tick_count = typeof v.tick_count === "number" ? v.tick_count : 0;
  // Backward-compat for legacy goal.json (no pursuit timer fields):
  //   - missing pursuing_seconds → 0
  //   - missing pursuing_since AND status === "pursuing" → seed from created_at
  //     (loses any pre-existing paused time but ticks correctly from here on)
  //   - missing pursuing_since AND status !== "pursuing" → null
  const pursuing_seconds = typeof v.pursuing_seconds === "number" && Number.isFinite(v.pursuing_seconds)
    ? Math.max(0, Math.floor(v.pursuing_seconds))
    : 0;
  let pursuing_since: string | null;
  if (typeof v.pursuing_since === "string" && v.pursuing_since.length > 0) {
    pursuing_since = v.pursuing_since;
  } else if (status === "pursuing" && typeof v.created_at === "string") {
    pursuing_since = v.created_at as string;
  } else {
    pursuing_since = null;
  }
  const history = Array.isArray(v.history) ? (v.history as HistoryEntry[]) : [];
  // v2 additive fields — pass through if present, ignore if absent (v1 compat).
  const schema_version = typeof v.schema_version === "number" ? v.schema_version : undefined;
  const spec = (v.spec !== undefined) ? (v.spec as GoalSpec | null) : undefined;
  const compat = Array.isArray(v.compat) ? (v.compat as string[]) : undefined;
  const roles = (v.roles !== undefined) ? (v.roles as GoalRoles | null) : undefined;
  const current = (v.current !== undefined) ? (v.current as GoalCurrent | null) : undefined;
  const budget = (v.budget !== undefined) ? (v.budget as GoalState["budget"]) : undefined;
  const lineage = Array.isArray(v.lineage) ? (v.lineage as LineageEntry[]) : undefined;
  const audit = (v.audit !== undefined) ? (v.audit as GoalState["audit"]) : undefined;
  const handoff_head = (v.handoff_head !== undefined) ? (v.handoff_head as string | null) : undefined;
  const queued_until = (v.queued_until !== undefined) ? (v.queued_until as string | null) : undefined;
  const time_used_seconds = typeof v.time_used_seconds === "number" ? v.time_used_seconds : undefined;
  const observed_at = typeof v.observed_at === "string" ? v.observed_at : undefined;
  const active_turn_started_at = (v.active_turn_started_at !== undefined) ? (v.active_turn_started_at as string | null) : undefined;
  const tokens_used_observed_at = typeof v.tokens_used_observed_at === "string" ? v.tokens_used_observed_at : undefined;
  const time_used_seconds_final = (v.time_used_seconds_final !== undefined) ? (v.time_used_seconds_final as number | null) : undefined;
  const tokens_used_final = (v.tokens_used_final !== undefined) ? (v.tokens_used_final as number | null) : undefined;
  return {
    ...(schema_version !== undefined ? { schema_version } : {}),
    goal_id: v.goal_id as string,
    objective: v.objective as string,
    ...(spec !== undefined ? { spec } : {}),
    status: status as GoalStatus,
    created_at: v.created_at as string,
    updated_at: v.updated_at as string,
    token_budget: (token_budget as number | null) ?? null,
    tokens_used,
    tick_count,
    pursuing_seconds,
    pursuing_since,
    history,
    ...(compat !== undefined ? { compat } : {}),
    ...(roles !== undefined ? { roles } : {}),
    ...(current !== undefined ? { current } : {}),
    ...(budget !== undefined ? { budget } : {}),
    ...(lineage !== undefined ? { lineage } : {}),
    ...(audit !== undefined ? { audit } : {}),
    ...(handoff_head !== undefined ? { handoff_head } : {}),
    ...(queued_until !== undefined ? { queued_until } : {}),
    ...(time_used_seconds !== undefined ? { time_used_seconds } : {}),
    ...(observed_at !== undefined ? { observed_at } : {}),
    ...(active_turn_started_at !== undefined ? { active_turn_started_at } : {}),
    ...(tokens_used_observed_at !== undefined ? { tokens_used_observed_at } : {}),
    ...(time_used_seconds_final !== undefined ? { time_used_seconds_final } : {}),
    ...(tokens_used_final !== undefined ? { tokens_used_final } : {}),
  };
}

function nowIso(): string {
  // UTC, second precision, matching the bash `date -u +%FT%TZ`.
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function makeView(state: GoalState): GoalView {
  const remaining = state.token_budget == null ? null : Math.max(0, state.token_budget - state.tokens_used);
  // Active pursuit time only — paused intervals are excluded.
  let elapsed = state.pursuing_seconds;
  if (state.status === "pursuing" && state.pursuing_since !== null) {
    const sinceMs = Date.parse(state.pursuing_since);
    if (Number.isFinite(sinceMs)) {
      const delta = Math.floor((Date.now() - sinceMs) / 1000);
      if (delta > 0) elapsed += delta;
    }
  }
  return { ...state, remaining_tokens: remaining, elapsed_seconds: elapsed };
}

function liveGoalSeconds(state: GoalState): number {
  if ((state.status === "achieved" || state.status === "budget-limited") && state.time_used_seconds_final != null) {
    return state.time_used_seconds_final;
  }
  let elapsed = state.time_used_seconds ?? state.pursuing_seconds ?? 0;
  if (state.status === "pursuing") {
    const observedMs = Date.parse(state.observed_at ?? state.updated_at ?? state.created_at);
    const activeMs = state.active_turn_started_at ? Date.parse(state.active_turn_started_at) : observedMs;
    const start = Math.max(Number.isFinite(observedMs) ? observedMs : Date.now(), Number.isFinite(activeMs) ? activeMs : 0);
    const delta = Math.floor((Date.now() - start) / 1000);
    if (delta > 0) elapsed += delta;
  }
  return Math.max(0, Math.floor(elapsed));
}

interface GoalEvent {
  ts: string;
  type: string;
  goal_id: string;
  // additional fields per event type
  [key: string]: unknown;
}

function appendEvent(paths: GoalPaths, event: GoalEvent): void {
  ensureClaudeDir(paths);
  const line = JSON.stringify(event) + "\n";
  try {
    // Append is reasonably safe under the same-process lock we already hold.
    // Cross-process atomicity for individual JSONL lines isn't guaranteed by
    // POSIX, but ext4/apfs do atomic writes for small (<PIPE_BUF) lines and
    // the bash hooks use the same pattern.
    appendFileSync(paths.eventsFile, line, { encoding: "utf8" });
  } catch (err) {
    // Events are best-effort; don't fail the operation, but log loudly.
    logError("failed to append event", {
      file: paths.eventsFile,
      reason: (err as Error)?.message,
    });
  }
}

function cleanupOrphanBaselines(paths: GoalPaths, keepGoalId: string | null): void {
  let entries: string[];
  try {
    entries = readdirSync(paths.claudeDir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (!name.startsWith(paths.baselineGlobPrefix)) continue;
    // matches goal-baseline-<id>
    const id = name.slice(paths.baselineGlobPrefix.length);
    if (keepGoalId !== null && id === keepGoalId) continue;
    try {
      unlinkSync(join(paths.claudeDir, name));
    } catch (err) {
      logError("failed to remove orphan baseline", { file: name, reason: (err as Error)?.message });
    }
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Tool input validation
// ────────────────────────────────────────────────────────────────────────────

function asObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ToolError("invalid_input", "arguments must be a JSON object");
  }
  return value as Record<string, unknown>;
}

function validateOptionalSessionId(obj: Record<string, unknown>): string | null {
  if (obj.session_id === undefined || obj.session_id === null) return null;
  if (typeof obj.session_id !== "string") {
    throw new ToolError("invalid_input", '"session_id" must be a string when provided');
  }
  const sid = sanitizeSessionId(obj.session_id);
  if (!sid) {
    throw new ToolError("invalid_input", '"session_id" is invalid');
  }
  return sid;
}

function validateCreateGoalArgs(args: unknown): { objective: string; token_budget: number | null; spec: GoalSpec | null; session_id: string | null } {
  const obj = asObject(args ?? {});
  const session_id = validateOptionalSessionId(obj);
  const objective = obj.objective;
  if (typeof objective !== "string") {
    throw new ToolError("invalid_input", '"objective" is required and must be a string');
  }
  const trimmed = objective.trim();
  if (trimmed.length === 0) {
    throw new ToolError("invalid_input", '"objective" must not be empty');
  }
  if (objective.length > 4000) {
    throw new ToolError("invalid_input", '"objective" exceeds maxLength 4000');
  }
  let token_budget: number | null = null;
  if (obj.token_budget !== undefined && obj.token_budget !== null) {
    const tb = obj.token_budget;
    if (typeof tb !== "number" || !Number.isInteger(tb) || tb < 1) {
      throw new ToolError("invalid_input", '"token_budget" must be a positive integer');
    }
    token_budget = tb;
  }
  let spec: GoalSpec | null = null;
  if (obj.spec !== undefined && obj.spec !== null) {
    if (typeof obj.spec !== "object" || Array.isArray(obj.spec)) {
      throw new ToolError("invalid_input", '"spec" must be an object when provided');
    }
    const src = obj.spec as Record<string, unknown>;
    const picked: GoalSpec = {};
    for (const k of ["title","outcome","verification","constraints","boundaries","iteration","blocked_when"] as const) {
      const v = src[k];
      if (typeof v === "string") picked[k] = v;
    }
    const assumptions = src.assumptions;
    if (typeof assumptions === "string") {
      picked.assumptions = assumptions;
    } else if (Array.isArray(assumptions)) {
      picked.assumptions = assumptions.filter((v): v is string => typeof v === "string").slice(0, 20);
    }
    if (Array.isArray(src.tasks)) {
      const tasks: GoalTaskSpec[] = [];
      for (const [idx, raw] of src.tasks.slice(0, 20).entries()) {
        if (typeof raw === "string") {
          const title = raw.trim();
          if (title) tasks.push({ id: `t${idx + 1}`, title });
          continue;
        }
        if (typeof raw !== "object" || raw === null || Array.isArray(raw)) continue;
        const taskObj = raw as Record<string, unknown>;
        const task: GoalTaskSpec = {};
        for (const k of ["id","title","outcome","verification","owner"] as const) {
          const v = taskObj[k];
          if (typeof v === "string" && v.trim()) task[k] = v.trim();
        }
        if (Array.isArray(taskObj.files)) {
          task.files = taskObj.files.filter((v): v is string => typeof v === "string" && v.trim().length > 0).slice(0, 12);
        }
        if (task.title || task.outcome || task.verification) tasks.push(task);
      }
      if (tasks.length > 0) picked.tasks = tasks;
    }
    spec = picked;
  }
  return { objective: trimmed, token_budget, spec, session_id };
}

function validateUpdateGoalArgs(args: unknown): { status: "complete"; session_id: string | null } {
  const obj = asObject(args ?? {});
  if (obj.status !== "complete") {
    throw new ToolError("invalid_input", '"status" must be the literal "complete"');
  }
  return { status: "complete", session_id: validateOptionalSessionId(obj) };
}

function validateGetGoalArgs(args: unknown): { session_id: string | null } {
  const obj = asObject(args ?? {});
  return { session_id: validateOptionalSessionId(obj) };
}

function auditId(raw: string | undefined, fallback: string, used: Set<string>): string {
  const cleaned = (raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  let id = cleaned || fallback;
  if (!used.has(id)) {
    used.add(id);
    return id;
  }
  let suffix = 2;
  while (used.has(`${id}-${suffix}`)) suffix++;
  id = `${id}-${suffix}`;
  used.add(id);
  return id;
}

function taskPredicate(task: GoalTaskSpec): string {
  const title = (task.title ?? "").trim();
  const outcome = (task.outcome ?? "").trim();
  const verification = (task.verification ?? "").trim();
  const parts: string[] = [];
  if (title) parts.push(title);
  if (outcome && outcome !== title) parts.push(outcome);
  if (verification) parts.push(`verified by ${verification}`);
  return parts.join(" — ").slice(0, 600) || "task-level checkpoint";
}

function initialAuditFromSpec(spec: GoalSpec | null): GoalState["audit"] {
  if (!spec) return null;
  const used = new Set<string>();
  const taskItems = (spec.tasks ?? [])
    .map((task, idx) => ({
      id: auditId(task.id, `t${idx + 1}`, used),
      predicate: taskPredicate(task),
      status: "open",
      evidence: null,
    }))
    .filter((item) => item.predicate.trim().length > 0);
  if (taskItems.length > 0) {
    return { checklist: taskItems };
  }

  const fallback: Array<{ id: string; predicate: string; status: string; evidence: string | null }> = [];
  if (spec.outcome) {
    fallback.push({ id: "outcome", predicate: `Outcome is true: ${spec.outcome}`, status: "open", evidence: null });
  }
  if (spec.verification) {
    fallback.push({ id: "verification", predicate: `Verification surface passes: ${spec.verification}`, status: "open", evidence: null });
  }
  if (spec.constraints) {
    fallback.push({ id: "constraints", predicate: `Constraints preserved: ${spec.constraints}`, status: "open", evidence: null });
  }
  return fallback.length > 0 ? { checklist: fallback } : null;
}

// ────────────────────────────────────────────────────────────────────────────
// Path resolution with migration (used by every tool)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Resolve v3 paths for root and run any pending forward migration (v1→v2,
 * v2→v3). pathsFor is deterministic in v3 (no per-state branching), so
 * re-resolving after migration is a no-op — but we keep the function shape so
 * every tool entry has one place to anchor "I've migrated, here are my paths."
 */
async function resolvePathsWithMigration(root: string): Promise<GoalPaths> {
  const paths = pathsFor(root);
  await migrateIfNeeded(paths);
  return paths;
}

/**
 * Wrap a v2/v3 state write: validate, then atomically write to
 * .goal/goals/<gid>.json. The record SHAPE is unchanged from v2 (the wire
 * schema is still schema_version=2); only the on-disk layout differs in v3.
 */
function atomicWriteGoalRecord(paths: GoalPaths, state: GoalState): void {
  if (state.schema_version === 2) {
    validateStateV2(state);
  }
  atomicWriteJson(goalRecordPath(paths, state.goal_id), state);
}

/**
 * Atomic write of a small text file (e.g. a session pointer). Same fs
 * (tmp-in-same-dir → rename) so the result is atomic on POSIX/APFS.
 */
function atomicWriteText(targetPath: string, contents: string): void {
  const dir = dirname(targetPath);
  mkdirSync(dir, { recursive: true });
  const tmpDir = mkdtempSync(join(dir, ".text-write-"));
  const tmpFile = join(tmpDir, "out.tmp");
  try {
    writeFileSync(tmpFile, contents, { encoding: "utf8", mode: 0o644 });
    const fd = openSync(tmpFile, "r");
    try { fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmpFile, targetPath);
  } finally {
    try { if (existsSync(tmpFile)) unlinkSync(tmpFile); } catch { /* best-effort */ }
    try { rmdirSync(tmpDir); } catch { /* best-effort */ }
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Tool implementations
// ────────────────────────────────────────────────────────────────────────────

async function toolCreateGoal(args: unknown): Promise<GoalView> {
  const { objective, token_budget, spec, session_id } = validateCreateGoalArgs(args);
  const resolved = resolveRootForCreate();
  const paths = await resolvePathsWithMigration(resolved.root);
  const sid = session_id ?? currentSessionId();
  logDebug("create_goal: resolved root", { root: paths.root, source: resolved.source, session: sid ?? "(none)" });

  ensureV3Dirs(paths);

  // Use the project-coordination lock: we don't have a per-goal lockfile path
  // until we've minted the new gid, and we want create_goal to serialize
  // against other create_goal calls in the same project.
  return await withProjectLock(paths, () => {
    // Pre-flight: a session can own only one non-terminal goal at a time.
    if (sid) {
      const ownedGid = readSessionPointer(paths, sid);
      if (ownedGid) {
        const existing = readGoalRecord(paths, ownedGid);
        if (existing && (existing.status === "pursuing" || existing.status === "paused")) {
          throw new ToolError("goal_exists_and_active",
            `this session already owns a ${existing.status} goal; clear or replace it via /goal first`,
            { existing_goal_id: existing.goal_id, existing_status: existing.status, owner_session_id: sid });
        }
        // Stale pointer to a terminal goal: drop it so we can rebind below.
        try { unlinkSync(sessionPointerPath(paths, sid)); } catch { /* best-effort */ }
      }
    } else {
      // No session id available — fall back to project-wide single-goal check
      // so we don't silently create a second active goal nothing can resolve.
      const projectActive = listAllGoalRecords(paths).filter((g) => g.status === "pursuing" || g.status === "paused");
      if (projectActive.length > 0) {
        throw new ToolError("goal_exists_and_active",
          "an active goal already exists in this project; no session id was provided to bind to a different one",
          { existing_goal_id: projectActive[0].goal_id, existing_status: projectActive[0].status });
      }
    }

    const newId = randomUUID();
    const ts = nowIso();
    const state: GoalState = {
      schema_version: 2,
      goal_id: newId,
      objective,
      ...(spec ? { spec } : {}),
      status: "pursuing",
      created_at: ts,
      updated_at: ts,
      time_used_seconds: 0,
      observed_at: ts,
      active_turn_started_at: ts,
      tokens_used_observed_at: ts,
      time_used_seconds_final: null,
      tokens_used_final: null,
      token_budget,
      tokens_used: 0,
      tick_count: 0,
      pursuing_seconds: 0,
      pursuing_since: ts,
      history: [{ ts, action: "create", note: "via mcp__goal__create_goal" }],
      compat: ["claude-code"],
      roles: { lead: null, build: null, review: null },
      current: { agent: null, session: sid ?? null, since: sid ? ts : null },
      budget: null,
      lineage: [],
      audit: initialAuditFromSpec(spec),
      handoff_head: null,
      queued_until: null,
    };

    cleanupOrphanBaselines(paths, null);
    atomicWriteGoalRecord(paths, state);
    if (sid) {
      atomicWriteText(sessionPointerPath(paths, sid), newId);
    }

    appendEvent(paths, {
      ts,
      type: "goal.created",
      goal_id: newId,
      objective,
      actor: "model",
      owner_session_id: sid,
      token_budget,
    });

    return makeView(state);
  });
}

async function toolUpdateGoal(args: unknown): Promise<GoalView & { final_report: { elapsed_seconds: number; tokens_used: number; tick_count: number } }> {
  const { session_id } = validateUpdateGoalArgs(args);
  const discovered = discoverExistingGoalRoot();
  if (!discovered) {
    throw new ToolError("no_active_goal", "no active goal found (no .goal/ discovered from cwd)");
  }
  const paths = await resolvePathsWithMigration(discovered.root);
  const resolved = resolveGoalForSession(paths, session_id);
  if (!resolved) {
    throw new ToolError("no_active_goal", "this session owns no goal, and the project does not have a single unambiguous active goal");
  }
  const gid = resolved.state.goal_id;

  return await withGoalLock(paths, gid, () => {
    const fresh = readGoalRecord(paths, gid);
    if (!fresh) {
      throw new ToolError("no_active_goal", `goal record ${gid} disappeared under us`);
    }
    if (fresh.status !== "pursuing" && fresh.status !== "paused") {
      throw new ToolError("no_active_goal", `goal is in terminal state "${fresh.status}"; cannot mark complete`);
    }
    // CAS: a second open of the file under the lock catches any pointer-vs-record drift.
    if (fresh.goal_id !== gid) {
      throw new ToolError("goal_id_mismatch", "goal_id changed under us; aborting", {
        expected: gid, actual: fresh.goal_id,
      });
    }

    const ts = nowIso();
    let newPursuingSeconds = fresh.pursuing_seconds;
    if (fresh.status === "pursuing" && fresh.pursuing_since !== null) {
      const sinceMs = Date.parse(fresh.pursuing_since);
      if (Number.isFinite(sinceMs)) {
        const delta = Math.floor((Date.now() - sinceMs) / 1000);
        if (delta > 0) newPursuingSeconds += delta;
      }
    }
    const updated: GoalState = {
      ...fresh,
      status: "achieved",
      updated_at: ts,
      time_used_seconds: liveGoalSeconds(fresh),
      observed_at: ts,
      active_turn_started_at: null,
      time_used_seconds_final: liveGoalSeconds(fresh),
      tokens_used_final: fresh.tokens_used,
      pursuing_seconds: newPursuingSeconds,
      pursuing_since: null,
      history: [
        ...fresh.history,
        { ts, action: "mark-achieved", note: "via mcp__goal__update_goal" },
      ],
    };
    atomicWriteGoalRecord(paths, updated);

    const view = makeView(updated);
    appendEvent(paths, {
      ts,
      type: "goal.completed",
      goal_id: updated.goal_id,
      elapsed_seconds: view.elapsed_seconds,
      final_tokens: updated.tokens_used,
      continuation_turns: updated.tick_count,
    });

    return {
      ...view,
      final_report: {
        elapsed_seconds: view.elapsed_seconds,
        tokens_used: updated.tokens_used,
        tick_count: updated.tick_count,
      },
    };
  });
}

async function toolGetGoal(args: unknown = {}): Promise<GoalView> {
  const { session_id } = validateGetGoalArgs(args);
  const discovered = discoverExistingGoalRoot();
  if (!discovered) {
    throw new ToolError("no_active_goal", "no active goal found (no .goal/ discovered from cwd)");
  }
  const paths = await resolvePathsWithMigration(discovered.root);
  const resolved = resolveGoalForSession(paths, session_id);
  if (!resolved) {
    throw new ToolError("no_active_goal", "this session owns no goal, and the project does not have a single unambiguous active goal");
  }
  // Reads still take the lock to avoid tearing a concurrent write.
  return await withGoalLock(paths, resolved.state.goal_id, () => {
    const state = readGoalRecord(paths, resolved.state.goal_id);
    if (!state) throw new ToolError("no_active_goal", "goal record vanished mid-read");
    return makeView(state);
  });
}

// ────────────────────────────────────────────────────────────────────────────
// P5: Five new MCP tool implementations (coordination only, not lifecycle)
// Per spec §9 and §13: these are asymmetric-safe (model CAN call them);
// model still cannot pause/resume/budget/mark-needs-input (existing 3 tools).
// ────────────────────────────────────────────────────────────────────────────

/** Resolve the .goal/ directory for tools that don't need a goal record. */
async function resolveGoalDir(): Promise<string> {
  const discovered = discoverExistingGoalRoot();
  if (!discovered) throw new ToolError("no_active_goal", "no active goal found");
  const paths = await resolvePathsWithMigration(discovered.root);
  return paths.goalDir;
}

/**
 * Resolve (paths, the goal this session owns or the unique active goal) under
 * the goal's per-goal lock, then run `fn`. Used by every tool that does RMW on
 * a specific goal record. Throws no_active_goal if nothing can be resolved.
 */
async function withSessionGoalLock<T>(
  fn: (paths: GoalPaths, state: GoalState, gid: string) => Promise<T> | T,
): Promise<T> {
  const discovered = discoverExistingGoalRoot();
  if (!discovered) throw new ToolError("no_active_goal", "no .goal/ discovered from cwd");
  const paths = await resolvePathsWithMigration(discovered.root);
  const resolved = resolveGoalForSession(paths);
  if (!resolved) {
    throw new ToolError("no_active_goal", "this session owns no goal, and the project does not have a single unambiguous active goal");
  }
  const gid = resolved.state.goal_id;
  return withGoalLock(paths, gid, async () => {
    const fresh = readGoalRecord(paths, gid);
    if (!fresh) throw new ToolError("no_active_goal", `goal record ${gid} vanished mid-call`);
    return await fn(paths, fresh, gid);
  });
}

/**
 * Like withSessionGoalLock, but takes the *project-coordination* lock instead.
 * Used by tools that touch shared cross-goal state (lanes.json, handoff seq,
 * breadcrumbs, escalations) — the goal record is still resolved for context,
 * but the lock is project-wide so concurrent goals don't race on shared files.
 */
async function withSessionGoalProjectLock<T>(
  fn: (paths: GoalPaths, state: GoalState, gid: string) => Promise<T> | T,
): Promise<T> {
  const discovered = discoverExistingGoalRoot();
  if (!discovered) throw new ToolError("no_active_goal", "no .goal/ discovered from cwd");
  const paths = await resolvePathsWithMigration(discovered.root);
  const resolved = resolveGoalForSession(paths);
  if (!resolved) {
    throw new ToolError("no_active_goal", "this session owns no goal, and the project does not have a single unambiguous active goal");
  }
  const gid = resolved.state.goal_id;
  return withProjectLock(paths, async () => {
    const fresh = readGoalRecord(paths, gid);
    if (!fresh) throw new ToolError("no_active_goal", `goal record ${gid} vanished mid-call`);
    return await fn(paths, fresh, gid);
  });
}

// ── claim_lane ────────────────────────────────────────────────────────────────

interface ClaimLaneArgs { glob: string; ttl_seconds: number; reason: string; }

function validateClaimLaneArgs(args: unknown): ClaimLaneArgs {
  const obj = asObject(args ?? {});
  const glob = obj.glob;
  if (typeof glob !== "string" || glob.trim().length === 0) {
    throw new ToolError("invalid_input", '"glob" is required and must be a non-empty string');
  }
  if (glob.length > 512) throw new ToolError("invalid_input", '"glob" exceeds max length 512');
  const ttlRaw = obj.ttl_seconds;
  const ttl = typeof ttlRaw === "number" ? ttlRaw : parseInt(String(ttlRaw ?? "600"), 10);
  if (!Number.isInteger(ttl) || ttl < 1 || ttl > 86400) {
    throw new ToolError("invalid_input", '"ttl_seconds" must be an integer between 1 and 86400');
  }
  const reason = obj.reason;
  if (typeof reason !== "string" || reason.trim().length === 0) {
    throw new ToolError("invalid_input", '"reason" is required and must be a non-empty string');
  }
  return { glob: glob.trim(), ttl_seconds: ttl, reason: reason.trim() };
}

async function toolClaimLane(args: unknown): Promise<ClaimLaneResult> {
  const { glob, ttl_seconds, reason } = validateClaimLaneArgs(args);
  return await withSessionGoalProjectLock((paths, state, gid) => {
    const holder = state.current?.agent ?? "unknown-agent";
    const result = claimLaneInner(paths.goalDir, holder, glob, ttl_seconds, reason);
    if (result.ok === false) {
      appendEvent(paths, {
        ts: nowIso(),
        type: "goal.lane.conflict",
        goal_id: gid,
        glob, holder,
        conflict_with: result.conflict_with,
      });
    }
    return result;
  });
}

// ── release_lane ──────────────────────────────────────────────────────────────

function validateReleaseLaneArgs(args: unknown): { lease_id: string } {
  const obj = asObject(args ?? {});
  const lid = obj.lease_id;
  if (typeof lid !== "string" || lid.trim().length === 0) {
    throw new ToolError("invalid_input", '"lease_id" is required and must be a non-empty string');
  }
  return { lease_id: lid.trim() };
}

async function toolReleaseLane(args: unknown): Promise<{ ok: boolean }> {
  const { lease_id } = validateReleaseLaneArgs(args);
  return await withSessionGoalProjectLock((paths) => {
    return { ok: releaseLaneInner(paths.goalDir, lease_id) };
  });
}

// ── write_handoff ─────────────────────────────────────────────────────────────

interface WriteHandoffMcpArgs {
  to: string;
  did: string[];
  did_not: string[];
  next: string[];
  do_not_redo: string[];
  evidence: string[];
}

function validateWriteHandoffArgs(args: unknown): WriteHandoffMcpArgs {
  const obj = asObject(args ?? {});
  const requireStringArray = (key: string) => {
    const v = obj[key];
    if (!Array.isArray(v)) throw new ToolError("invalid_input", `"${key}" must be an array of strings`);
    for (const item of v) {
      if (typeof item !== "string") throw new ToolError("invalid_input", `"${key}[]" items must be strings`);
    }
    return v as string[];
  };

  const to = obj.to;
  if (typeof to !== "string" || to.trim().length === 0) {
    throw new ToolError("invalid_input", '"to" is required (target agent ID)');
  }

  return {
    to: to.trim(),
    did: requireStringArray("did"),
    did_not: requireStringArray("did_not"),
    next: requireStringArray("next"),
    do_not_redo: requireStringArray("do_not_redo"),
    evidence: requireStringArray("evidence"),
  };
}

async function toolWriteHandoff(args: unknown): Promise<{ seq: string; path: string }> {
  const wArgs = validateWriteHandoffArgs(args);
  return await withSessionGoalProjectLock((paths, state, gid) => {
    const handoffDir = join(paths.goalDir, "handoff");
    const from = state.current?.agent ?? "unknown";

    mkdirSync(handoffDir, { recursive: true });
    let max = 0;
    try {
      const files = readdirSync(handoffDir).filter((f) => /^\d{4}\.md$/.test(f));
      for (const f of files) { const n = parseInt(f, 10); if (n > max) max = n; }
    } catch (_) { /* empty */ }
    const seq = max + 1;
    const seqStr = String(seq).padStart(4, "0");
    const ts = nowIso();
    const handoffPath = join(handoffDir, `${seqStr}.md`);

    const fmt = (bullets: string[]) =>
      bullets.length === 0 ? "- (none)" : bullets.map((b) => (b.startsWith("- ") ? b : `- ${b}`)).join("\n");

    const content = [
      "---",
      `seq: ${seqStr}`,
      `from: ${from}`,
      `to: ${wArgs.to}`,
      `at: ${ts}`,
      `reason: planned`,
      `goal_id: ${gid}`,
      "---",
      "",
      "## Did", fmt(wArgs.did),
      "",
      "## Did not", fmt(wArgs.did_not),
      "",
      "## Next", fmt(wArgs.next),
      "",
      "## Do not redo", fmt(wArgs.do_not_redo),
      "",
      "## Open audit items",
      `- See .goal/goals/${gid}.json .audit.checklist`,
      "",
      "## Evidence", fmt(wArgs.evidence),
      "",
    ].join("\n");

    const tmpDir = mkdtempSync(join(handoffDir, ".tmp-handoff-"));
    const tmp = join(tmpDir, "handoff.md");
    try {
      writeFileSync(tmp, content, "utf8");
      renameSync(tmp, handoffPath);
    } catch (e) {
      try { if (existsSync(tmp)) unlinkSync(tmp); } catch (_) { /* best-effort */ }
      try { rmdirSync(tmpDir); } catch (_) { /* best-effort */ }
      throw new ToolError("io_error", `handoff write failed: ${(e as Error).message}`);
    }
    try { rmdirSync(tmpDir); } catch (_) { /* best-effort */ }

    try {
      const updated = { ...state, handoff_head: seqStr, updated_at: nowIso() };
      atomicWriteGoalRecord(paths, updated);
    } catch (_) { /* non-fatal — handoff is written */ }

    return { seq: seqStr, path: handoffPath };
  });
}

// ── peer_status ───────────────────────────────────────────────────────────────

interface PeerStatus {
  peer_agent: string | null;
  last_heartbeat: string | null;
  current_role: string | null;
  headroom: string;
}

async function toolPeerStatus(): Promise<PeerStatus> {
  return await withSessionGoalLock((paths, state) => {
    const goalDir = paths.goalDir;
    const currentAgent = state.current?.agent ?? null;

    // Read quota.json for headroom.
    let headroom = "high";
    try {
      const quotaRaw = readFileSync(join(goalDir, "quota.json"), "utf8");
      const quota = JSON.parse(quotaRaw) as Record<string, unknown>;
      const providers = quota.providers as Record<string, Record<string, unknown>> | undefined;
      if (providers) {
        // headroom = lowest headroom across all providers.
        const order = ["high", "medium", "low", "exhausted"];
        for (const p of Object.values(providers)) {
          const h = String(p.estimated_headroom ?? "high");
          if (order.indexOf(h) > order.indexOf(headroom)) headroom = h;
        }
      }
    } catch (_) { /* quota.json absent = high */ }

    // Scan agents/ dir for peer heartbeats.
    const agentsDir = join(goalDir, "agents");
    let peerAgent: string | null = null;
    let lastHeartbeat: string | null = null;

    try {
      const agentFiles = readdirSync(agentsDir).filter((f) => f.endsWith(".json"));
      // Pick the peer with the most recent heartbeat (excluding current agent).
      let bestHbMs = 0;
      for (const f of agentFiles) {
        try {
          const obj = JSON.parse(readFileSync(join(agentsDir, f), "utf8")) as Record<string, unknown>;
          const agentId = String(obj.agent_id ?? "");
          if (agentId === currentAgent) continue; // skip self
          const hbAt = String(obj.heartbeat_at ?? "");
          const hbMs = hbAt ? Date.parse(hbAt) : 0;
          if (hbMs > bestHbMs) {
            bestHbMs = hbMs;
            peerAgent = agentId;
            lastHeartbeat = hbAt || null;
          }
        } catch (_) { /* skip malformed agent file */ }
      }
    } catch (_) { /* agents dir absent */ }

    // current_role from cowork.yml.
    let currentRole: string | null = null;
    try {
      const coworkCfg = loadCoworkYmlInner(goalDir);
      if (coworkCfg && currentAgent) {
        currentRole = getRoleForAgentInner(coworkCfg, currentAgent);
      }
    } catch (_) { /* cowork.yml absent or invalid */ }

    return { peer_agent: peerAgent, last_heartbeat: lastHeartbeat, current_role: currentRole, headroom };
  });
}

// ── relay_now ─────────────────────────────────────────────────────────────────

const VALID_RELAY_REASONS = new Set(["planned", "rate_limit", "budget_step_down", "error", "user"]);

function validateRelayNowArgs(args: unknown): { reason: string } {
  const obj = asObject(args ?? {});
  const reason = obj.reason;
  if (typeof reason !== "string" || !VALID_RELAY_REASONS.has(reason)) {
    throw new ToolError("invalid_input", `"reason" must be one of: ${[...VALID_RELAY_REASONS].join(", ")}`);
  }
  return { reason };
}

async function toolRelayNow(args: unknown): Promise<{ ok: boolean; handoff_seq: string | null }> {
  const { reason } = validateRelayNowArgs(args);
  const discovered = discoverExistingGoalRoot();
  if (!discovered) throw new ToolError("no_active_goal", "no .goal/ discovered from cwd");
  const paths = await resolvePathsWithMigration(discovered.root);
  const resolved = resolveGoalForSession(paths);
  if (!resolved) {
    throw new ToolError("no_active_goal", "this session owns no goal");
  }
  const state = resolved.state;
  const gid = state.goal_id;
  const currentAgent = state.current?.agent;
  if (!currentAgent) {
    throw new ToolError("no_active_goal", "no current.agent set — is a bridge running?");
  }

  const faultFile = join(paths.goalDir, "agents", `${currentAgent}.fault`);
  const faultData = JSON.stringify({
    kind: reason === "rate_limit" ? "rate_limit" : "other",
    reason,
    at: nowIso(),
    payload: `relay_now: ${reason}`,
    event_type: "mcp_relay_now",
  }, null, 2) + "\n";

  try {
    mkdirSync(dirname(faultFile), { recursive: true });
    const faultTmpDir = mkdtempSync(join(dirname(faultFile), ".tmp-fault-"));
    const faultTmp = join(faultTmpDir, "fault.json");
    try {
      writeFileSync(faultTmp, faultData, "utf8");
      renameSync(faultTmp, faultFile);
    } finally {
      try { if (existsSync(faultTmp)) unlinkSync(faultTmp); } catch (_) { /* best-effort */ }
      try { rmdirSync(faultTmpDir); } catch (_) { /* best-effort */ }
    }
  } catch (e) {
    throw new ToolError("io_error", `relay_now: could not write fault file: ${(e as Error).message}`);
  }

  // Poll the goal record for the bridge to pick it up (up to 5s).
  const deadline = Date.now() + 5000;
  let handoffSeq: string | null = null;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
    try {
      const fresh = readGoalRecord(paths, gid);
      if (fresh && (fresh.status === "relaying" || fresh.status === "pursuing") && fresh.handoff_head) {
        handoffSeq = fresh.handoff_head;
        break;
      }
    } catch (_) { /* retry */ }
  }

  return { ok: true, handoff_seq: handoffSeq };
}

// ── v3 progress / breadcrumb / routing tools ────────────────────────────────

function appendBreadcrumb(goalDir: string, entry: Record<string, unknown>): number {
  const file = join(goalDir, "breadcrumbs.jsonl");
  let seq = 1;
  try {
    const lines = readFileSync(file, "utf8").trim().split(/\n/).filter(Boolean);
    const last = lines.length ? JSON.parse(lines[lines.length - 1]) : null;
    seq = Number(last?.seq ?? 0) + 1;
  } catch (_) { /* first breadcrumb */ }
  appendFileSync(file, JSON.stringify({ seq, at: nowIso(), ...entry }) + "\n", "utf8");
  return seq;
}

function jaccard(a: string, b: string): number {
  const toks = (s: string) => new Set(s.toLowerCase().split(/[^a-z0-9_/-]+/).filter(Boolean));
  const A = toks(a), B = toks(b);
  const union = new Set([...A, ...B]);
  if (union.size === 0) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / union.size;
}

function composePreamble(paths: GoalPaths, state: GoalState, antiLoopNote = ""): void {
  const goalDir = paths.goalDir;
  const list = state.audit?.checklist ?? [];
  const counts = {
    open: list.filter((i) => i.status === "open").length,
    passed: list.filter((i) => i.status === "passed").length,
    failed: list.filter((i) => i.status === "failed").length,
  };
  const handoffDir = join(goalDir, "handoff");
  const handoffs = (() => {
    try {
      return readdirSync(handoffDir).filter((f) => /^\d{4}\.md$/.test(f)).sort().slice(-3).reverse()
        .map((f) => readFileSync(join(handoffDir, f), "utf8").slice(0, 1200));
    } catch (_) { return []; }
  })();
  const breadcrumbs = (() => {
    try { return readFileSync(join(goalDir, "breadcrumbs.jsonl"), "utf8").trim().split(/\n/).filter(Boolean).slice(-8); }
    catch (_) { return []; }
  })();
  const lanes = (() => {
    try { return readFileSync(join(goalDir, "lanes.json"), "utf8").slice(0, 1500); }
    catch (_) { return '{"leases":[]}'; }
  })();
  const body = [
    "## Objective",
    `<untrusted_objective>${state.objective}</untrusted_objective>`,
    "",
    "## Audit",
    `open=${counts.open} passed=${counts.passed} failed=${counts.failed}`,
    ...list.map((i) => `- ${i.id}: ${i.status} — ${i.predicate}${i.evidence ? ` (${i.evidence})` : ""}`),
    "",
    "## Recent Handoffs",
    ...handoffs,
    "",
    "## Breadcrumbs",
    ...breadcrumbs,
    antiLoopNote ? `\n${antiLoopNote}` : "",
    "",
    "## Lane Leases",
    lanes,
    "",
    "## Remaining Budget",
    state.token_budget ? `${Math.max(0, state.token_budget - state.tokens_used)} tokens` : "unbounded",
    "",
    "## Role",
    JSON.stringify(state.roles ?? {}),
  ].join("\n");
  const capped = body.split(/\s+/).slice(0, 1500).join(" ") + "\n";
  writeFileSync(join(goalDir, "preamble.md"), capped, "utf8");
}

type AuditSupportStatus = "passed" | "failed" | "confirmed" | "partial" | "proxy-only" | "unverified" | "blocked";

function validateProgressArgs(args: unknown): { audit_item_id: string; status: AuditSupportStatus; evidence_ref: string } {
  const obj = asObject(args ?? {});
  if (typeof obj.audit_item_id !== "string" || !obj.audit_item_id) throw new ToolError("invalid_input", "audit_item_id is required");
  if (!["passed", "failed", "confirmed", "partial", "proxy-only", "unverified", "blocked"].includes(String(obj.status))) {
    throw new ToolError("invalid_input", "status must be passed, failed, confirmed, partial, proxy-only, unverified, or blocked");
  }
  if (typeof obj.evidence_ref !== "string" || !obj.evidence_ref) throw new ToolError("invalid_input", "evidence_ref is required");
  return { audit_item_id: obj.audit_item_id, status: obj.status as AuditSupportStatus, evidence_ref: obj.evidence_ref };
}

async function toolReportProgress(args: unknown): Promise<{ ok: true }> {
  const p = validateProgressArgs(args);
  return await withSessionGoalLock((paths, s) => {
    const checklist = s.audit?.checklist ?? [];
    const next = checklist.some((i) => i.id === p.audit_item_id)
      ? checklist.map((i) => i.id === p.audit_item_id ? { ...i, status: p.status, evidence: p.evidence_ref } : i)
      : [...checklist, { id: p.audit_item_id, predicate: p.evidence_ref, status: p.status, evidence: p.evidence_ref }];
    const updated = { ...s, audit: { checklist: next }, updated_at: nowIso() };
    atomicWriteGoalRecord(paths, updated);
    appendEvent(paths, { ts: nowIso(), type: `goal.audit.${p.status}`, goal_id: s.goal_id, audit_item_id: p.audit_item_id, evidence_ref: p.evidence_ref });
    composePreamble(paths, updated);
    return { ok: true as const };
  });
}

async function toolRecordBreadcrumb(args: unknown): Promise<{ ok: true; seq: number }> {
  const obj = asObject(args ?? {});
  for (const k of ["audit_item", "approach", "outcome", "evidence_ref"] as const) {
    if (typeof obj[k] !== "string" || !(obj[k] as string).trim()) throw new ToolError("invalid_input", `${k} is required`);
  }
  return await withSessionGoalProjectLock((paths, s) => {
    const seq = appendBreadcrumb(paths.goalDir, { agent: s.current?.agent ?? "model", audit_item: obj.audit_item, approach: obj.approach, outcome: obj.outcome, evidence_ref: obj.evidence_ref });
    let note = "";
    try {
      const rows = readFileSync(join(paths.goalDir, "breadcrumbs.jsonl"), "utf8").trim().split(/\n/).filter(Boolean).map((l) => JSON.parse(l));
      const last = rows.filter((r) => r.audit_item === obj.audit_item).slice(-3);
      if (last.length === 3 && jaccard(String(last[0].approach), String(last[1].approach)) > 0.7 && jaccard(String(last[1].approach), String(last[2].approach)) > 0.7) {
        note = "You've tried similar approaches 3 times. Consider a different angle, or call mcp__goal__report_stuck to surface this.";
      }
    } catch (_) { /* best effort */ }
    composePreamble(paths, s, note);
    return { ok: true as const, seq };
  });
}

async function toolReportStuck(args: unknown): Promise<{ ok: true; escalation: string }> {
  const obj = asObject(args ?? {});
  if (typeof obj.audit_item_id !== "string" || !obj.audit_item_id) throw new ToolError("invalid_input", "audit_item_id is required");
  if (typeof obj.reason !== "string" || !obj.reason) throw new ToolError("invalid_input", "reason is required");
  const attempts = typeof obj.attempts === "number" ? obj.attempts : parseInt(String(obj.attempts ?? "1"), 10);
  return await withSessionGoalProjectLock((paths, s) => {
    appendFileSync(join(paths.goalDir, "escalations.md"), `\n## ${nowIso()} ${obj.audit_item_id}\n${obj.reason}\nattempts=${attempts}\n`, "utf8");
    const escalation = attempts >= 5 ? "paused" : "try_peer";
    const updated = attempts >= 5 ? { ...s, status: "paused" as GoalStatus, updated_at: nowIso(), active_turn_started_at: null } : { ...s, updated_at: nowIso() };
    atomicWriteGoalRecord(paths, updated);
    appendEvent(paths, { ts: nowIso(), type: "goal.audit.stuck", goal_id: s.goal_id, audit_item_id: obj.audit_item_id, attempts, escalation });
    composePreamble(paths, updated);
    return { ok: true as const, escalation };
  });
}

function validateMessageArgs(args: unknown): { text: string; session_id: string } {
  const obj = asObject(args ?? {});
  if (typeof obj.text !== "string" || !obj.text.trim()) throw new ToolError("invalid_input", "text is required");
  if (typeof obj.session_id !== "string" || !obj.session_id.trim()) throw new ToolError("invalid_input", "session_id is required");
  return { text: obj.text, session_id: obj.session_id };
}

async function toolQueueMessage(args: unknown): Promise<{ ok: true; position: number }> {
  const m = validateMessageArgs(args);
  const goalDir = await resolveGoalDir();
  const file = join(goalDir, "queue", `${m.session_id}.jsonl`);
  mkdirSync(dirname(file), { recursive: true });
  let position = 1;
  try { position = readFileSync(file, "utf8").trim().split(/\n/).filter(Boolean).length + 1; } catch (_) {}
  appendFileSync(file, JSON.stringify({ at: nowIso(), text: m.text, session_id: m.session_id }) + "\n", "utf8");
  return { ok: true, position };
}

async function toolSteerMessage(args: unknown): Promise<{ ok: true; accepted: boolean }> {
  const m = validateMessageArgs(args);
  const discovered = discoverExistingGoalRoot();
  if (!discovered) throw new ToolError("no_active_goal", "no .goal/ discovered from cwd");
  const paths = await resolvePathsWithMigration(discovered.root);
  const resolved = resolveGoalForSession(paths);
  const accepted = resolved !== null && (resolved.state.status === "pursuing" || resolved.state.status === "relaying");
  const dir = accepted ? "steers" : "rejected_steers";
  const file = join(paths.goalDir, dir, `${m.session_id}.jsonl`);
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, JSON.stringify({ at: nowIso(), text: m.text, session_id: m.session_id }) + "\n", "utf8");
  return { ok: true, accepted };
}

// ────────────────────────────────────────────────────────────────────────────
// MCP wiring
// ────────────────────────────────────────────────────────────────────────────

const TOOLS: Tool[] = [
  {
    name: "create_goal",
    description:
      "Create a persistent objective for this session. Only call this when the user explicitly asks to set or pursue a goal — do NOT infer goals from ordinary task framings. Fails if an active or paused goal already exists on this project; the user must clear or replace it first.",
    inputSchema: {
      type: "object",
      required: ["objective"],
      properties: {
        objective: {
          type: "string",
          maxLength: 4000,
          description: "Concrete objective. Should be specific enough that completion is verifiable against artifacts.",
        },
        token_budget: {
          type: "integer",
          minimum: 1,
          description: "Optional positive token budget. When exceeded, the goal auto-transitions to budget-limited and a wrap-up steering message is injected.",
        },
        session_id: {
          type: "string",
          description: "Optional Claude session id. Pass CLAUDE_CODE_SESSION_ID from the slash-command environment when available so the record is bound to .goal/sessions/<session_id> even if the MCP process was launched before Claude exported it.",
        },
        spec: {
          type: "object",
          description: "Optional structured objective from the `goalframe` skill (title, outcome, verification, constraints, boundaries, iteration, blocked_when, assumptions). Stored once and referenced by the continuation dispatcher so the raw objective is not re-pasted every turn.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "update_goal",
    description:
      "Update the existing goal. Use this tool only to mark the goal achieved after running a thorough completion audit — every explicit deliverable in the objective must map to concrete artifact evidence. Do NOT mark complete merely because tests pass, a large diff was made, or the budget was exhausted.",
    inputSchema: {
      type: "object",
      required: ["status"],
      properties: {
        status: {
          type: "string",
          enum: ["complete"],
          description: "Only 'complete' is valid. The model cannot pause, resume, replace, modify budget, or mark a failure through this tool — those are user-only operations.",
        },
        session_id: {
          type: "string",
          description: "Optional Claude session id used to resolve this session's owned goal.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_goal",
    description:
      "Get the current goal for this session: status, budget, tokens used and remaining, elapsed time, recent history. Use this to self-orient at the start of a continuation turn or after compaction, INSTEAD OF reading goal.json directly with the Read tool.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: {
          type: "string",
          description: "Optional Claude session id used to resolve this session's owned goal.",
        },
      },
      additionalProperties: false,
    },
  },
  // ── P5: Coordination-only tools (not lifecycle — asymmetric constraints preserved) ──
  {
    name: "claim_lane",
    description:
      "Claim an exclusive lane lease on a file glob before making edits. Prevents concurrent agents from editing the same paths. Returns {ok:true, lease_id} on success or {ok:false, conflict_with} when another agent holds a conflicting lease. Always release the lease when done (use release_lane).",
    inputSchema: {
      type: "object",
      required: ["glob", "ttl_seconds", "reason"],
      properties: {
        glob: {
          type: "string",
          description: "File glob pattern to lock (e.g. 'src/auth/**', '*.ts'). Supports ** (any path), * (any filename chars), ? (single char).",
          maxLength: 512,
        },
        ttl_seconds: {
          type: "integer",
          minimum: 1,
          maximum: 86400,
          description: "Lease TTL in seconds (1–86400). Lease auto-expires after this duration.",
        },
        reason: {
          type: "string",
          description: "Human-readable reason for the lease (e.g. 'implementing session refresh').",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "release_lane",
    description:
      "Release a lane lease by lease_id. Call this after finishing edits to the locked glob, so other agents can proceed. Returns {ok:true} if found and released, {ok:false} if lease_id was not found (already expired or released).",
    inputSchema: {
      type: "object",
      required: ["lease_id"],
      properties: {
        lease_id: {
          type: "string",
          description: "UUID lease_id returned by claim_lane.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "write_handoff",
    description:
      "Write a handoff envelope to .goal/handoff/NNNN.md — a structured note for the peer agent. Use this before yielding to another agent (e.g. before relay_now). Returns {seq, path}.",
    inputSchema: {
      type: "object",
      required: ["to", "did", "did_not", "next", "do_not_redo", "evidence"],
      properties: {
        to: { type: "string", description: "Target agent ID receiving the handoff." },
        did: { type: "array", items: { type: "string" }, description: "What was accomplished (bullet list)." },
        did_not: { type: "array", items: { type: "string" }, description: "What was explicitly NOT done (bullet list)." },
        next: { type: "array", items: { type: "string" }, description: "What the receiving agent should do next (bullet list)." },
        do_not_redo: { type: "array", items: { type: "string" }, description: "Work that should not be repeated (bullet list)." },
        evidence: { type: "array", items: { type: "string" }, description: "File paths or artifacts that prove the work was done (bullet list)." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "peer_status",
    description:
      "Get the status of the peer agent: last heartbeat, their current role from cowork.yml, and estimated provider headroom. Returns {peer_agent, last_heartbeat, current_role, headroom}. Returns {peer_agent:null} if no peer is running.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "relay_now",
    description:
      "Force an immediate relay to the peer agent for the given reason. Writes a fault signal that the running bridge picks up and converts to a handoff. Waits up to 5s for the bridge to confirm the relay. Only works when a bridge is running for the current agent. Returns {ok, handoff_seq}.",
    inputSchema: {
      type: "object",
      required: ["reason"],
      properties: {
        reason: {
          type: "string",
          enum: ["planned", "rate_limit", "budget_step_down", "error", "user"],
          description: "Relay reason. Use 'planned' for an intentional yield, 'rate_limit' if you are being throttled.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "report_progress",
    description: "Mark one task/audit item with concrete evidence and an overclaim support level. This cannot change lifecycle status or bypass the final audit gate.",
    inputSchema: {
      type: "object",
      required: ["audit_item_id", "status", "evidence_ref"],
      properties: {
        audit_item_id: { type: "string" },
        status: { type: "string", enum: ["passed", "failed", "confirmed", "partial", "proxy-only", "unverified", "blocked"] },
        evidence_ref: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "report_stuck",
    description: "Declare that an audit item is stuck; after max attempts the goal pauses for user attention.",
    inputSchema: {
      type: "object",
      required: ["audit_item_id", "reason", "attempts"],
      properties: {
        audit_item_id: { type: "string" },
        reason: { type: "string" },
        attempts: { type: "integer", minimum: 1 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "record_breadcrumb",
    description: "Append a non-trivial approach/outcome breadcrumb and refresh the continuation preamble.",
    inputSchema: {
      type: "object",
      required: ["audit_item", "approach", "outcome", "evidence_ref"],
      properties: {
        audit_item: { type: "string" },
        approach: { type: "string" },
        outcome: { type: "string" },
        evidence_ref: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "queue_message",
    description: "Queue a user or peer message for the next turn of a session.",
    inputSchema: {
      type: "object",
      required: ["text", "session_id"],
      properties: { text: { type: "string" }, session_id: { type: "string" } },
      additionalProperties: false,
    },
  },
  {
    name: "steer_message",
    description: "Route a mid-turn steer to steers/<session>.jsonl, or rejected_steers when the current state cannot accept it.",
    inputSchema: {
      type: "object",
      required: ["text", "session_id"],
      properties: { text: { type: "string" }, session_id: { type: "string" } },
      additionalProperties: false,
    },
  },
];

function toolResultFromObject(value: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  };
}

function errorResult(err: ToolError | Error): CallToolResult {
  const code = err instanceof ToolError ? err.code : "io_error";
  const details = err instanceof ToolError ? err.details : undefined;
  const payload = {
    error: {
      code,
      message: err.message,
      ...(details ? { details } : {}),
    },
  };
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  };
}

async function dispatch(name: string, args: unknown): Promise<CallToolResult> {
  try {
    switch (name) {
      case "create_goal":
        return toolResultFromObject(await toolCreateGoal(args));
      case "update_goal":
        return toolResultFromObject(await toolUpdateGoal(args));
      case "get_goal":
        return toolResultFromObject(await toolGetGoal(args));
      // P5: coordination tools
      case "claim_lane":
        return toolResultFromObject(await toolClaimLane(args));
      case "release_lane":
        return toolResultFromObject(await toolReleaseLane(args));
      case "write_handoff":
        return toolResultFromObject(await toolWriteHandoff(args));
      case "peer_status":
        return toolResultFromObject(await toolPeerStatus());
      case "relay_now":
        return toolResultFromObject(await toolRelayNow(args));
      case "report_progress":
        return toolResultFromObject(await toolReportProgress(args));
      case "report_stuck":
        return toolResultFromObject(await toolReportStuck(args));
      case "record_breadcrumb":
        return toolResultFromObject(await toolRecordBreadcrumb(args));
      case "queue_message":
        return toolResultFromObject(await toolQueueMessage(args));
      case "steer_message":
        return toolResultFromObject(await toolSteerMessage(args));
      default:
        return errorResult(new ToolError("invalid_input", `unknown tool: ${name}`));
    }
  } catch (err) {
    if (err instanceof ToolError) return errorResult(err);
    logError("unexpected exception in tool dispatch", { tool: name, reason: (err as Error)?.message, stack: (err as Error)?.stack });
    return errorResult(err as Error);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Phase 2: goal/continue channel — push-driven idle continuation
//
// State machine triggers:
//   - boot:       one initial push at server start after a grace period
//                 (if there is an active goal)
//   - timer:      every GOAL_PUSH_INTERVAL_SECONDS while pursuing+healthy
//                 (default: disabled)
//   - filewatch:  on goal.json mtime changes — but ONLY if the change wasn't
//                 a Stop-hook tick (we detect that by tick_count increment)
//
// Kill switches (in priority order):
//   - GOAL_CHANNEL_DISABLE=1               → never push
//   - .goal/pause exists                   → never push
//   - status !== "pursuing"                → never push
//   - token_budget set AND tokens_used >=  → never push (budget exhausted)
//
// Coordination with the Stop hook:
//   The Stop hook also re-engages the model on turn end and increments
//   tick_count. We track the last observed tick_count; if it just incremented
//   on a file-watch event, the Stop hook fired, so we skip our push.
// ────────────────────────────────────────────────────────────────────────────

const CHANNEL_ID = "goal/continue" as const;
const CHANNEL_NOTIFICATION_METHOD = "notifications/claude/channel" as const;

const CONTINUATION_MESSAGE =
  "Continue working toward the active project goal. " +
  "Call `mcp__goal__get_goal()` if you need the current objective and status. " +
  "If you determine the goal is achieved, call `mcp__goal__update_goal({status:\"complete\"})` " +
  "after running a completion audit. If you are blocked, state the blocker and stop — do not mark the goal failed.";

const BOOT_GRACE_MS = 2_000;
const DEFAULT_DEBOUNCE_MS = 5_000;
const WATCH_COALESCE_MS = 100; // collapse rapid fs.watch events into one evaluation

type PushTrigger = "boot" | "timer" | "filewatch";
type PushOutcome =
  | "sent"
  | "send_failed"
  | "skipped_paused"
  | "skipped_disabled"
  | "skipped_no_goal"
  | "skipped_budget"
  | "skipped_debounce"
  | `skipped_status_${string}`;

interface ChannelEvent {
  ts: string;
  type: "goal.continuation_pushed";
  goal_id: string;
  channel: string;
  trigger: PushTrigger;
  outcome: PushOutcome;
  // The notification's `meta` keys can only be identifiers (letters/digits/_),
  // so we log additional context in our own event stream, not on the wire.
  [key: string]: unknown;
}

class ChannelPushManager {
  private readonly server: Server;
  private watcher: FSWatcher | null = null;
  private timer: NodeJS.Timeout | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private bootTimer: NodeJS.Timeout | null = null;
  private coalesceTimer: NodeJS.Timeout | null = null;
  private currentRoot: string | null = null;
  private lastTickCount: number | null = null;
  private lastStateMtimeMs = 0;
  private lastPushTs = 0;
  private running = false;
  private readonly debounceMs: number;

  constructor(server: Server) {
    this.server = server;
    const raw = process.env.GOAL_CHANNEL_DEBOUNCE_MS;
    const parsed = raw ? Number.parseInt(raw, 10) : NaN;
    this.debounceMs = Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_DEBOUNCE_MS;
  }

  /** Entry point — called after MCP initialize handshake completes. */
  start(): void {
    if (this.running) return;
    if (process.env.GOAL_CHANNEL_DISABLE === "1") {
      logDebug("channel: disabled via GOAL_CHANNEL_DISABLE=1");
      return;
    }
    this.running = true;

    // Resolve the root once at start; if it's not present yet, we still try
    // to install the watcher when a goal is later created (next attemptPush).
    const resolved = discoverExistingGoalRoot() ?? resolveRootForCreate();
    this.currentRoot = resolved.root;
    logDebug("channel: starting", { root: this.currentRoot, source: resolved.source, debounceMs: this.debounceMs });

    this.installWatcher();
    this.installPollingFallback();
    this.scheduleBootPush();
    this.scheduleTimer();
  }

  /** Tear everything down. Safe to call multiple times. */
  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.bootTimer) { clearTimeout(this.bootTimer); this.bootTimer = null; }
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
    if (this.coalesceTimer) { clearTimeout(this.coalesceTimer); this.coalesceTimer = null; }
    if (this.watcher) {
      try { this.watcher.close(); } catch { /* best-effort */ }
      this.watcher = null;
    }
    logDebug("channel: stopped");
  }

  private installWatcher(): void {
    if (!this.currentRoot) return;
    const paths = pathsFor(this.currentRoot);
    try {
      ensureV3Dirs(paths);
    } catch (err) {
      logError("channel: failed to ensure .goal dirs", { reason: (err as Error)?.message });
      return;
    }
    // v3: watch .goal/goals/ for per-goal record changes, plus .goal/ itself for the
    // pause kill switch. Per-file watch breaks on atomic-rename writes (inode changes),
    // so we watch the directories.
    try {
      this.watcher = watch(paths.goalsDir, { persistent: false }, (_eventType, filename) => {
        if (filename && !filename.endsWith(".json")) return;
        this.coalesceAndEvaluate("filewatch");
      });
      this.watcher.on("error", (err: Error) => {
        logError("channel: watcher error", { reason: err.message });
        try { this.watcher?.close(); } catch { /* best-effort */ }
        this.watcher = null;
      });
      logDebug("channel: watcher installed", { dir: paths.goalsDir });
    } catch (err) {
      logError("channel: watch() failed; filewatch trigger disabled", { reason: (err as Error)?.message });
    }
  }

  private installPollingFallback(): void {
    if (!this.currentRoot || this.pollTimer) return;
    this.pollTimer = setInterval(() => {
      if (!this.currentRoot) return;
      const paths = pathsFor(this.currentRoot);
      try {
        const fingerprint = this.goalStateFingerprint(paths);
        if (fingerprint !== this.lastStateMtimeMs) {
          this.lastStateMtimeMs = fingerprint;
          this.coalesceAndEvaluate("filewatch");
        }
      } catch {
        // .goal/goals/ may not exist yet — that's fine.
      }
    }, 500);
    this.pollTimer.unref?.();
    logDebug("channel: polling fallback installed");
  }

  private goalStateFingerprint(paths: GoalPaths): number {
    // Directory mtime catches record add/remove and pause create/remove. File
    // mtimes catch atomic rewrites or explicit touches when fs.watch is down.
    let max = 0;
    try { max = Math.max(max, statSync(paths.goalDir).mtimeMs); } catch { /* best-effort */ }
    try { max = Math.max(max, statSync(paths.goalsDir).mtimeMs); } catch { /* best-effort */ }
    try { max = Math.max(max, statSync(paths.pauseFile).mtimeMs); } catch { /* absent is fine */ }
    let names: string[] = [];
    try { names = readdirSync(paths.goalsDir).filter((n) => n.endsWith(".json")); } catch { return max; }
    for (const name of names) {
      try { max = Math.max(max, statSync(join(paths.goalsDir, name)).mtimeMs); } catch { /* best-effort */ }
    }
    return max;
  }

  private scheduleBootPush(): void {
    this.bootTimer = setTimeout(() => {
      this.bootTimer = null;
      void this.attemptPush("boot");
    }, BOOT_GRACE_MS);
    // Don't block process exit on this timer.
    this.bootTimer.unref?.();
  }

  private scheduleTimer(): void {
    const raw = process.env.GOAL_PUSH_INTERVAL_SECONDS;
    if (!raw) return;
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n) || n <= 0) {
      logDebug("channel: invalid GOAL_PUSH_INTERVAL_SECONDS; timer disabled", { raw });
      return;
    }
    const intervalMs = n * 1_000;
    this.timer = setInterval(() => {
      void this.attemptPush("timer");
    }, intervalMs);
    this.timer.unref?.();
    logDebug("channel: timer scheduled", { intervalSeconds: n });
  }

  private coalesceAndEvaluate(trigger: PushTrigger): void {
    // fs.watch can fire multiple times per atomic rename. Coalesce within a
    // short window into a single evaluation.
    if (this.coalesceTimer) return;
    this.coalesceTimer = setTimeout(() => {
      this.coalesceTimer = null;
      void this.attemptPush(trigger);
    }, WATCH_COALESCE_MS);
    this.coalesceTimer.unref?.();
  }

  /**
   * Evaluate kill switches, push if appropriate, log outcome. All decisions
   * (and the state read) happen under the same proper-lockfile mutex the
   * tool RMW paths use, so we serialize cleanly against create_goal/update_goal.
   */
  private async attemptPush(trigger: PushTrigger): Promise<void> {
    if (!this.running) return;
    if (process.env.GOAL_CHANNEL_DISABLE === "1") {
      // Best-effort log; no goal_id available without reading state, leave blank.
      this.logEvent({ trigger, outcome: "skipped_disabled", goal_id: "" });
      return;
    }

    // Re-resolve the root each time — the goal may have been created since boot
    // in a directory we discovered via cwd-fallback.
    const resolved = discoverExistingGoalRoot();
    if (!resolved) {
      this.logEvent({ trigger, outcome: "skipped_no_goal", goal_id: "" });
      return;
    }
    if (resolved.root !== this.currentRoot) {
      // Root changed; re-install watcher on the new dir.
      logDebug("channel: root changed, re-installing watcher", { from: this.currentRoot, to: resolved.root });
      if (this.watcher) {
        try { this.watcher.close(); } catch { /* best-effort */ }
        this.watcher = null;
      }
      this.currentRoot = resolved.root;
      this.installWatcher();
    }

    const paths = pathsFor(resolved.root);

    // Find the goal this push refers to (session-owned, or the single active one).
    // We can't take the per-goal lock without a gid, so we resolve first, then lock.
    const owned = resolveGoalForSession(paths);
    if (!owned) {
      this.logEvent({ trigger, outcome: "skipped_no_goal", goal_id: "" });
      return;
    }
    const goalId = owned.state.goal_id;

    let decision: { kind: "send"; goalId: string } | { kind: "skip"; outcome: PushOutcome; goalId: string };
    try {
      decision = await withGoalLock(paths, goalId, () => this.decideUnderLock(paths, goalId, trigger));
    } catch (err) {
      logError("channel: lock acquisition failed; skipping push", { reason: (err as Error)?.message });
      return;
    }

    if (decision.kind === "skip") {
      this.logEvent({ trigger, outcome: decision.outcome, goal_id: decision.goalId });
      return;
    }

    // Outside the lock: do the actual notification.notification() call so we
    // don't hold the file lock across an unbounded network/IPC operation.
    try {
      await this.server.notification({
        method: CHANNEL_NOTIFICATION_METHOD,
        params: {
          content: CONTINUATION_MESSAGE,
          // Meta keys must be identifiers (letters/digits/underscores), per the
          // channels-reference docs. We surface trigger here for the model;
          // goal_id is logged in our own events file instead.
          meta: { trigger },
        },
      });
      this.lastPushTs = Date.now();
      this.logEvent({ trigger, outcome: "sent", goal_id: decision.goalId });
      logDebug("channel: push sent", { trigger, goal_id: decision.goalId });
    } catch (err) {
      // Channel send rejected (e.g. host doesn't support the capability, or
      // transport closed). Log and continue — do NOT crash the server.
      const reason = (err as Error)?.message ?? String(err);
      this.logEvent({ trigger, outcome: "send_failed", goal_id: decision.goalId, reason });
      logError("channel: push failed", { trigger, reason });
    }
  }

  private decideUnderLock(
    paths: GoalPaths,
    gid: string,
    trigger: PushTrigger,
  ): { kind: "send"; goalId: string } | { kind: "skip"; outcome: PushOutcome; goalId: string } {
    // Pause file: hardest kill switch.
    if (existsSync(paths.pauseFile)) {
      return { kind: "skip", outcome: "skipped_paused", goalId: gid };
    }

    let state: GoalState | null;
    try {
      state = readGoalRecord(paths, gid);
    } catch (err) {
      logError("channel: failed to read goal record", { reason: (err as Error)?.message, gid });
      return { kind: "skip", outcome: "skipped_no_goal", goalId: gid };
    }
    if (!state) {
      return { kind: "skip", outcome: "skipped_no_goal", goalId: gid };
    }

    if (state.status !== "pursuing") {
      // We don't push for paused/achieved/needs-input/budget-limited. Each is a
      // distinct outcome string so events file analytics can break them out.
      const safe = state.status.replace(/[^a-z0-9_-]/gi, "_");
      return { kind: "skip", outcome: `skipped_status_${safe}` as PushOutcome, goalId: state.goal_id };
    }

    if (state.token_budget !== null && state.tokens_used >= state.token_budget) {
      return { kind: "skip", outcome: "skipped_budget", goalId: state.goal_id };
    }

    // Stop-hook debounce coordination:
    //
    // The Stop hook bumps tick_count when it fires its own continuation. If we
    // observe tick_count just incremented on a filewatch event AND that
    // increment is within the debounce window, skip — Stop already nudged.
    if (trigger === "filewatch") {
      const lastTick = this.lastTickCount;
      const updatedAtMs = Date.parse(state.updated_at);
      const sinceUpdateMs = Number.isFinite(updatedAtMs) ? Date.now() - updatedAtMs : Number.POSITIVE_INFINITY;
      if (
        lastTick !== null &&
        state.tick_count > lastTick &&
        sinceUpdateMs >= 0 &&
        sinceUpdateMs < this.debounceMs
      ) {
        this.lastTickCount = state.tick_count;
        return { kind: "skip", outcome: "skipped_debounce", goalId: state.goal_id };
      }
    }

    // Also debounce against our own recent push (timer or boot fired moments ago).
    if (this.lastPushTs > 0 && Date.now() - this.lastPushTs < this.debounceMs) {
      return { kind: "skip", outcome: "skipped_debounce", goalId: state.goal_id };
    }

    // Record tick_count snapshot for future debounce comparisons.
    this.lastTickCount = state.tick_count;
    return { kind: "send", goalId: state.goal_id };
  }

  private logEvent(partial: { trigger: PushTrigger; outcome: PushOutcome; goal_id: string; [k: string]: unknown }): void {
    if (!this.currentRoot) return;
    const paths = pathsFor(this.currentRoot);
    const event: ChannelEvent = {
      ts: nowIso(),
      type: "goal.continuation_pushed",
      goal_id: partial.goal_id,
      channel: CHANNEL_ID,
      trigger: partial.trigger,
      outcome: partial.outcome,
      ...(partial.reason !== undefined ? { reason: partial.reason } : {}),
    };
    appendEvent(paths, event);
  }
}

async function main(): Promise<void> {
  const server = new Server(
    {
      name: "goal",
      version: "0.2.0",
    },
    {
      capabilities: {
        tools: {},
        // Phase 2: declare the channel capability so Claude Code registers
        // a listener for `notifications/claude/channel` events from us.
        // The presence of the experimental key is the trigger.
        experimental: {
          "claude/channel": {},
        },
      },
      // Steers the model on receipt of a continuation push. Short and
      // cache-stable — the actual objective is fetched on demand via get_goal.
      instructions:
        'Events from the goal channel arrive as <channel source="goal" ...>. ' +
        "They are one-way nudges to keep the active project goal in motion. " +
        "On receipt, call mcp__goal__get_goal() if you need the current objective and status, " +
        "then continue working toward it. If you determine the goal is achieved, " +
        "call mcp__goal__update_goal({status:\"complete\"}) after a thorough completion audit. " +
        "If you are blocked, state the blocker and stop — do not mark the goal failed.",
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => {
    return { tools: TOOLS };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    logDebug("call_tool", { name });
    return dispatch(name, args);
  });

  const transport = new StdioServerTransport();

  // Channel push manager — created up front; activated after initialize handshake.
  const channelManager = new ChannelPushManager(server);

  server.oninitialized = (): void => {
    // Host capabilities are populated after the initialized notification.
    // We don't gate on a specific host capability — Claude Code documents
    // `experimental['claude/channel']` as a server-side declaration; the host
    // simply registers a listener. If the host ignores it (older Claude Code,
    // other MCP clients), our notification sends are silent no-ops at worst
    // (the SDK queues them on the transport).
    const clientInfo = server.getClientVersion();
    logDebug("initialized", { client: clientInfo?.name, version: clientInfo?.version });
    channelManager.start();
  };

  // Graceful shutdown — release any held lock, close watchers, clear timers.
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logDebug(`shutting down on ${signal}`);
    try {
      channelManager.stop();
    } catch (err) {
      logError("error during channelManager.stop", { reason: (err as Error)?.message });
    }
    try {
      await server.close();
    } catch (err) {
      logError("error during server.close", { reason: (err as Error)?.message });
    }
    // proper-lockfile installs its own SIGTERM handler to clean up locks owned
    // by this process; explicitly calling its unlockAll mirrors that for SIGINT.
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await server.connect(transport);
  logDebug("goal-mcp-server connected over stdio");
}

// Only auto-run when executed as a script (not when imported by tests).
// We compare by file URL because `require.main` is unreliable under tsx/loader hooks.
const invokedAsScript = (() => {
  try {
    const argvFile = process.argv[1] ? resolve(process.argv[1]) : "";
    const thisFile = resolve(new URL(import.meta.url).pathname);
    return argvFile === thisFile;
  } catch {
    return false;
  }
})();

if (invokedAsScript) {
  main().catch((err) => {
    logError("fatal", { reason: (err as Error)?.message, stack: (err as Error)?.stack });
    process.exit(1);
  });
}

// Exports for testing
export const __test = {
  pathsFor,
  readGoalRecord,
  readSessionPointer,
  resolveGoalForSession,
  listAllGoalRecords,
  validateGoalState,
  makeView,
  validateCreateGoalArgs,
  validateUpdateGoalArgs,
  toolCreateGoal,
  toolUpdateGoal,
  toolGetGoal,
  dispatch,
  TOOLS,
  ChannelPushManager,
  CHANNEL_ID,
  CHANNEL_NOTIFICATION_METHOD,
  CONTINUATION_MESSAGE,
};
