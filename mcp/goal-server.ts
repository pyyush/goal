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
type GoalStatus = "pursuing" | "paused" | "achieved" | "unmet" | "budget-limited" | "relaying" | "queued";

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
// Goal-root discovery
//
// Order (mirrors hooks/goal-resolve.sh):
//   1) $GOAL_ROOT env var
//   2) Walk up from cwd looking for the nearest enclosing .claude/goal.json,
//      stopping at $HOME (so user-scope ~/.claude is never the goal root).
//   3) Session pointer at $HOME/.claude/goal-sessions/<session_id>.goal —
//      its content is the absolute path to a goal.json.
//   4) For create_goal, fall back to cwd. For other tools, caller decides.
// ────────────────────────────────────────────────────────────────────────────

export interface ResolveOptions {
  cwd?: string;
  home?: string;
  sessionId?: string;
  env?: NodeJS.ProcessEnv;
}

export interface ResolvedRoot {
  root: string;            // directory containing .claude/
  source: "env" | "walk-up" | "session-pointer" | "cwd-fallback";
}

/** Pure function for testing. Returns null when no existing goal is found. */
export function discoverExistingGoalRoot(opts: ResolveOptions = {}): ResolvedRoot | null {
  const env = opts.env ?? process.env;
  const cwd = opts.cwd ?? process.cwd();
  const home = opts.home ?? env.HOME ?? homedir();
  const sessionId = opts.sessionId ?? env.CLAUDE_SESSION_ID ?? env.GOAL_SESSION_ID;

  // 1) GOAL_ROOT env var — trust it if it exists and is a directory.
  const envRoot = env.GOAL_ROOT;
  if (envRoot && envRoot.length > 0) {
    try {
      if (statSync(envRoot).isDirectory()) {
        return { root: resolve(envRoot), source: "env" };
      }
    } catch {
      // fall through — env var pointed at something that doesn't exist;
      // treat as opt-in even so, but only if used for create.
      return { root: resolve(envRoot), source: "env" };
    }
  }

  // 2) Walk up from cwd to (but not including) $HOME or filesystem root.
  //    Prefer v2 (.goal/state.json), fall back to v1 (.claude/goal.json).
  let d = resolve(cwd);
  const disableMigration = env.GOAL_DISABLE_MIGRATION === "1";
  // Hard upper bound on traversal in pathological cases.
  for (let i = 0; i < 64; i++) {
    if (!d || d === "/" || d === home) break;
    // v2 path (preferred unless migration disabled)
    if (!disableMigration) {
      const v2Candidate = join(d, ".goal", "state.json");
      try {
        const lst = lstatSync(v2Candidate);
        if (lst.isFile() && !lst.isSymbolicLink()) {
          return { root: d, source: "walk-up" };
        }
      } catch { /* not present */ }
    }
    // v1 path (always fallback)
    const candidate = join(d, ".claude", "goal.json");
    try {
      // Symlinks are explicitly disallowed (matches bash: `! -L`). lstatSync
      // returns metadata about the link itself, not its target.
      const lst = lstatSync(candidate);
      if (lst.isFile() && !lst.isSymbolicLink()) {
        return { root: d, source: "walk-up" };
      }
    } catch {
      // not present, keep walking
    }
    const parent = dirname(d);
    if (parent === d) break;
    d = parent;
  }

  // 3) Session pointer.
  if (sessionId && home) {
    const pointer = join(home, ".claude", "goal-sessions", `${sessionId}.goal`);
    try {
      if (statSync(pointer).isFile()) {
        const target = readFileSync(pointer, "utf8").trim();
        if (target.length > 0 && existsSync(target)) {
          // pointer file content is an absolute path to goal.json.
          // root = dirname(dirname(pointer-target)) → strips /.claude/goal.json
          const root = dirname(dirname(target));
          return { root, source: "session-pointer" };
        }
      }
    } catch {
      // ignore
    }
  }

  return null;
}

/** Resolves root for an operation. Caller controls fallback behaviour. */
export function resolveRootForCreate(opts: ResolveOptions = {}): ResolvedRoot {
  const existing = discoverExistingGoalRoot(opts);
  if (existing) return existing;
  return { root: resolve(opts.cwd ?? process.cwd()), source: "cwd-fallback" };
}

// ────────────────────────────────────────────────────────────────────────────
// File paths derived from root
// ────────────────────────────────────────────────────────────────────────────

interface GoalPaths {
  root: string;
  claudeDir: string;
  goalDir: string;           // .goal/ — v2 state directory
  goalFile: string;          // .goal/state.json (v2) or .claude/goal.json when migration disabled
  v1GoalFile: string;        // always .claude/goal.json (migration source)
  eventsFile: string;
  baselineGlobPrefix: string;
  markerFile: string;        // .claude/MIGRATED_TO_GOAL
}

function pathsFor(root: string): GoalPaths {
  const claudeDir = join(root, ".claude");
  const goalDir = join(root, ".goal");
  // Prefer v2 path for both fresh and migrated goals.
  // When GOAL_DISABLE_MIGRATION is set, always use v1.
  const disableMigration = process.env.GOAL_DISABLE_MIGRATION === "1";
  const useV2 = !disableMigration;
  return {
    root,
    claudeDir,
    goalDir,
    goalFile: useV2 ? join(goalDir, "state.json") : join(claudeDir, "goal.json"),
    v1GoalFile: join(claudeDir, "goal.json"),
    eventsFile: join(goalDir, "events.jsonl"),
    baselineGlobPrefix: "goal-baseline-",
    markerFile: join(claudeDir, "MIGRATED_TO_GOAL"),
  };
}

function ensureClaudeDir(paths: GoalPaths): void {
  mkdirSync(paths.claudeDir, { recursive: true });
}

function ensureGoalStateDir(paths: GoalPaths): void {
  const dir = dirname(paths.goalFile);
  mkdirSync(dir, { recursive: true });
}

// ────────────────────────────────────────────────────────────────────────────
// v2 Migration
// ────────────────────────────────────────────────────────────────────────────

/**
 * Migrate from v1 (.claude/goal.json) to v2 (.goal/state.json) if needed.
 *
 * - No-op when GOAL_DISABLE_MIGRATION=1.
 * - No-op when .goal/ already exists.
 * - No-op when .claude/goal.json doesn't exist.
 * - Logs loudly to .claude/goal-hook.log on failure; never half-migrates.
 * - Called at the top of every tool handler.
 */
async function migrateIfNeeded(paths: GoalPaths): Promise<void> {
  if (process.env.GOAL_DISABLE_MIGRATION === "1") return;
  if (existsSync(paths.goalDir)) return;
  if (!existsSync(paths.v1GoalFile)) return;

  ensureClaudeDir(paths);

  // We hold the lock on the v1 path while migrating.
  // Use withGoalLock which already handles v1 vs v2 lock path selection.
  // Since .goal/ doesn't exist yet, withGoalLock will use .claude/goal.lock.
  let didMigrate = false;
  try {
    await withGoalLock(paths, async () => {
      // Double-check inside lock.
      if (existsSync(paths.goalDir)) {
        didMigrate = true; // another process beat us
        return;
      }
      if (!existsSync(paths.v1GoalFile)) return;

      // Parse v1 state.
      let v1Raw: unknown;
      try {
        v1Raw = JSON.parse(readFileSync(paths.v1GoalFile, "utf8"));
      } catch (err) {
        const msg = (err as Error)?.message ?? String(err);
        logError("migration: failed to parse v1 goal.json", { reason: msg });
        appendMigrationLog(paths, "migration-parse-failed", msg);
        throw new ToolError("io_error", `migration: cannot parse v1 goal.json: ${msg}`);
      }

      if (typeof v1Raw !== "object" || v1Raw === null) {
        const msg = "v1 goal.json is not an object";
        logError("migration:", { reason: msg });
        appendMigrationLog(paths, "migration-invalid", msg);
        throw new ToolError("io_error", `migration: ${msg}`);
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
        lineage: [
          {
            agent: "claude-code",
            model: "unknown",
            started_at: v1Created,
            ended_at: endedAt,
            turns: v1Ticks,
            tokens: v1Tokens,
            summary: "migrated from v1",
          },
        ],
        audit: null,
        handoff_head: null,
        queued_until: null,
      };

      // Create .goal/ dir.
      mkdirSync(paths.goalDir, { recursive: false });

      // Write v2 state atomically.
      try {
        atomicWriteJson(paths.goalDir + "/state.json", v2State);
      } catch (err) {
        // Roll back: try to remove .goal/
        try { rmdirSync(paths.goalDir); } catch { /* best-effort */ }
        const msg = (err as Error)?.message ?? String(err);
        logError("migration: failed to write v2 state", { reason: msg });
        appendMigrationLog(paths, "migration-write-failed", msg);
        throw new ToolError("io_error", `migration: cannot write .goal/state.json: ${msg}`);
      }

      // Lock path: after migration, `withGoalLock`'s finally block (the release())
      // will attempt to remove `.claude/goal.lock` (the lock we acquired above).
      // That cleanup will happen automatically. Future lock acquisitions will use
      // `.goal/lock` (because pathsFor now sees .goal/ exists).
      // We do NOT move/rename the lockdir here — proper-lockfile handles release.

      // Write marker file.
      try {
        writeFileSync(paths.markerFile, nowIso() + "\n", { encoding: "utf8", mode: 0o644 });
      } catch { /* best-effort */ }

      appendMigrationLog(paths, "migration-done", "migrated v1→v2");
      logDebug("migration complete", { root: paths.root });
      didMigrate = true;
    });
  } catch (err) {
    if (err instanceof ToolError) throw err;
    logError("migration: unexpected error", { reason: (err as Error)?.message });
    throw new ToolError("io_error", `migration failed: ${(err as Error)?.message}`);
  }

  // If migration just completed, the pathsFor snapshot is stale (.goalFile still
  // points to v1 path). Callers must call pathsFor again after migrateIfNeeded.
  // We log a debug note here; the actual re-resolution is the caller's job.
  if (didMigrate) {
    logDebug("migration: done — caller should re-resolve paths");
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

async function withGoalLock<T>(paths: GoalPaths, fn: () => Promise<T> | T): Promise<T> {
  ensureClaudeDir(paths);
  // Lock path: post-migration (.goal/ exists) → .goal/lock; pre-migration → .claude/goal.lock.
  // We lock on the state directory so the lock works even when state file doesn't yet exist.
  let lockDir: string;
  let lockfilePath: string;
  let lockTarget: string;
  try {
    const goalDirStat = lstatSync(paths.goalDir);
    if (goalDirStat.isDirectory()) {
      lockDir = paths.goalDir;
      lockfilePath = join(paths.goalDir, "lock");
    } else {
      lockDir = paths.claudeDir;
      lockfilePath = join(paths.claudeDir, "goal.lock");
    }
  } catch {
    // .goal/ doesn't exist — use legacy path.
    lockDir = paths.claudeDir;
    lockfilePath = join(paths.claudeDir, "goal.lock");
  }
  lockTarget = lockDir;

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
    });
  }
  try {
    return await fn();
  } finally {
    try {
      if (release) await release();
    } catch (err) {
      logError("failed to release lock", { reason: (err as Error)?.message });
    }
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Goal state read / view / event emission
// ────────────────────────────────────────────────────────────────────────────

function readGoalState(paths: GoalPaths): GoalState | null {
  if (!existsSync(paths.goalFile)) return null;
  try {
    const raw = readFileSync(paths.goalFile, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return validateGoalState(parsed);
  } catch (err) {
    throw new ToolError("io_error", "failed to read or parse goal.json", {
      file: paths.goalFile,
      reason: (err as Error)?.message,
    });
  }
}

// All 7 lifecycle statuses — v2 adds relaying and queued.
const VALID_STATUSES: GoalStatus[] = [
  "pursuing", "paused", "achieved", "unmet", "budget-limited", "relaying", "queued",
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
  if ((state.status === "achieved" || state.status === "unmet" || state.status === "budget-limited") && state.time_used_seconds_final != null) {
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

function validateCreateGoalArgs(args: unknown): { objective: string; token_budget: number | null } {
  const obj = asObject(args ?? {});
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
  return { objective: trimmed, token_budget };
}

function validateUpdateGoalArgs(args: unknown): { status: "complete" } {
  const obj = asObject(args ?? {});
  if (obj.status !== "complete") {
    throw new ToolError("invalid_input", '"status" must be the literal "complete"');
  }
  return { status: "complete" };
}

// ────────────────────────────────────────────────────────────────────────────
// Path resolution with migration (used by every tool)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Resolve paths for root, run migration if needed, then re-resolve so paths
 * reflect the post-migration state (.goal/ dir now exists).
 */
async function resolvePathsWithMigration(root: string): Promise<GoalPaths> {
  const initial = pathsFor(root);
  await migrateIfNeeded(initial);
  // Re-resolve: after migration .goal/ now exists, so pathsFor will pick v2 path.
  return pathsFor(root);
}

/**
 * Wrap a v2 state write: run validateStateV2 before atomicWriteJson.
 */
function atomicWriteStateV2(goalFile: string, state: GoalState): void {
  // Only validate v2 shape when schema_version is 2.
  if (state.schema_version === 2) {
    validateStateV2(state);
  }
  atomicWriteJson(goalFile, state);
}

// ────────────────────────────────────────────────────────────────────────────
// Tool implementations
// ────────────────────────────────────────────────────────────────────────────

async function toolCreateGoal(args: unknown): Promise<GoalView> {
  const { objective, token_budget } = validateCreateGoalArgs(args);
  const resolved = resolveRootForCreate();
  // Run migration first, then re-resolve so paths reflect the post-migration state.
  const paths = await resolvePathsWithMigration(resolved.root);
  logDebug("create_goal: resolved root", { root: paths.root, source: resolved.source });

  // Ensure the state directory exists before acquiring the lock.
  ensureGoalStateDir(paths);

  return await withGoalLock(paths, () => {
    const existing = readGoalState(paths);
    if (existing && (existing.status === "pursuing" || existing.status === "paused")) {
      throw new ToolError("goal_exists_and_active", `a ${existing.status} goal already exists; the user must clear or replace it first`, {
        existing_goal_id: existing.goal_id,
        existing_status: existing.status,
      });
    }

    const newId = randomUUID();
    const ts = nowIso();
    const action = existing ? "replace" : "create";
    // Determine if we're writing a v2 file.
    const isV2 = paths.goalFile.endsWith("state.json");
      const state: GoalState = {
        ...(isV2 ? { schema_version: 2 as const } : {}),
        goal_id: newId,
        objective,
        status: "pursuing",
        created_at: ts,
        updated_at: ts,
        ...(isV2 ? {
          time_used_seconds: 0,
          observed_at: ts,
          active_turn_started_at: ts,
          tokens_used_observed_at: ts,
          time_used_seconds_final: null,
          tokens_used_final: null,
        } : {}),
        token_budget,
        tokens_used: 0,
      tick_count: 0,
      pursuing_seconds: 0,
      pursuing_since: ts,
      history: [
        {
          ts,
          action,
          note: "via mcp__goal__create_goal",
        },
      ],
      ...(isV2 ? {
        compat: ["claude-code"],
        roles: { lead: null, build: null, review: null },
        current: { agent: null, session: null, since: null },
        budget: null,
        lineage: [],
        audit: null,
        handoff_head: null,
        queued_until: null,
      } : {}),
    };

    // Clean up orphan baselines from any previous goal_id BEFORE writing the
    // new state, so a baseline-write race after our write doesn't sweep us.
    cleanupOrphanBaselines(paths, null);
    atomicWriteStateV2(paths.goalFile, state);

    appendEvent(paths, {
      ts,
      type: "goal.created",
      goal_id: newId,
      objective,
      actor: "model",
      token_budget,
    });

    return makeView(state);
  });
}

async function toolUpdateGoal(args: unknown): Promise<GoalView & { final_report: { elapsed_seconds: number; tokens_used: number; tick_count: number } }> {
  validateUpdateGoalArgs(args);
  const discovered = discoverExistingGoalRoot();
  if (!discovered) {
    throw new ToolError("no_active_goal", "no active goal found (no goal state discovered from cwd)");
  }
  // Run migration, then re-resolve.
  const paths = await resolvePathsWithMigration(discovered.root);

  return await withGoalLock(paths, () => {
    const state = readGoalState(paths);
    if (!state) {
      throw new ToolError("no_active_goal", "no active goal found");
    }
    if (state.status !== "pursuing" && state.status !== "paused") {
      throw new ToolError("no_active_goal", `goal is in terminal state "${state.status}"; cannot mark complete`);
    }
    const capturedId = state.goal_id;

    // CAS: re-read after we hold the lock to ensure goal_id hasn't shifted.
    // (Under proper-lockfile this is paranoid but cheap; harmless and matches spec.)
    const fresh = readGoalState(paths);
    if (!fresh || fresh.goal_id !== capturedId) {
      throw new ToolError("goal_id_mismatch", "goal_id changed under us; aborting", {
        expected: capturedId,
        actual: fresh?.goal_id ?? null,
      });
    }

    const ts = nowIso();
    // Accumulate pursuit time if we're transitioning out of pursuing.
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
    atomicWriteStateV2(paths.goalFile, updated);

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

async function toolGetGoal(): Promise<GoalView> {
  const discovered = discoverExistingGoalRoot();
  if (!discovered) {
    throw new ToolError("no_active_goal", "no active goal found (no goal state discovered from cwd)");
  }
  // Run migration, then re-resolve.
  const paths = await resolvePathsWithMigration(discovered.root);
  // Reads still take the lock to avoid tearing a concurrent write.
  return await withGoalLock(paths, () => {
    const state = readGoalState(paths);
    if (!state) {
      throw new ToolError("no_active_goal", "no active goal found");
    }
    return makeView(state);
  });
}

// ────────────────────────────────────────────────────────────────────────────
// P5: Five new MCP tool implementations (coordination only, not lifecycle)
// Per spec §9 and §13: these are asymmetric-safe (model CAN call them);
// model still cannot pause/resume/budget/mark-unmet (existing 3 tools).
// ────────────────────────────────────────────────────────────────────────────

/** Resolve the .goal/ directory for P5 tools. */
async function resolveGoalDir(): Promise<string> {
  const discovered = discoverExistingGoalRoot();
  if (!discovered) throw new ToolError("no_active_goal", "no active goal found");
  const paths = await resolvePathsWithMigration(discovered.root);
  return paths.goalDir;
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
  const goalDir = await resolveGoalDir();
  const paths = pathsFor(discoverExistingGoalRoot()!.root);

  return await withGoalLock(paths, () => {
    // Resolve current agent from state.json (current.agent or cwd-derived).
    let holder = "unknown-agent";
    let goalId: string | undefined;
    try {
      const state = readGoalState(paths);
      if (state?.current?.agent) holder = state.current.agent;
      if (state?.goal_id) goalId = state.goal_id;
    } catch (_) { /* use fallback */ }

    const result = claimLaneInner(goalDir, holder, glob, ttl_seconds, reason);
    if (result.ok === false) {
      // P6 OTEL: emit goal.lane.conflict so the exporter increments the counter.
      appendEvent(paths, {
        ts: nowIso(),
        type: "goal.lane.conflict",
        goal_id: goalId ?? "unknown",
        glob,
        holder,
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
  const goalDir = await resolveGoalDir();

  return await withGoalLock(pathsFor(discoverExistingGoalRoot()!.root), () => {
    const ok = releaseLaneInner(goalDir, lease_id);
    return { ok };
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
  const discovered = discoverExistingGoalRoot();
  if (!discovered) throw new ToolError("no_active_goal", "no active goal found");
  const paths = await resolvePathsWithMigration(discovered.root);
  const goalDir = paths.goalDir;
  const handoffDir = join(goalDir, "handoff");

  return await withGoalLock(paths, () => {
    const state = readGoalState(paths);
    if (!state) throw new ToolError("no_active_goal", "no active goal found");

    // Compute from: current agent or "unknown".
    const from = state.current?.agent ?? "unknown";
    const goalId = state.goal_id;

    // Compute next seq inside lock.
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

    // Format bullets.
    const fmt = (bullets: string[]) =>
      bullets.length === 0 ? "- (none)" : bullets.map((b) => (b.startsWith("- ") ? b : `- ${b}`)).join("\n");

    const content = [
      "---",
      `seq: ${seqStr}`,
      `from: ${from}`,
      `to: ${wArgs.to}`,
      `at: ${ts}`,
      `reason: planned`,
      `goal_id: ${goalId}`,
      "---",
      "",
      "## Did",
      fmt(wArgs.did),
      "",
      "## Did not",
      fmt(wArgs.did_not),
      "",
      "## Next",
      fmt(wArgs.next),
      "",
      "## Do not redo",
      fmt(wArgs.do_not_redo),
      "",
      "## Open audit items",
      "- See state.json .audit.checklist",
      "",
      "## Evidence",
      fmt(wArgs.evidence),
      "",
    ].join("\n");

    // Atomic write.
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

    // Update handoff_head in state.
    try {
      const updated = { ...state, handoff_head: seqStr, updated_at: nowIso() };
      atomicWriteStateV2(paths.goalFile, updated);
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
  const discovered = discoverExistingGoalRoot();
  if (!discovered) throw new ToolError("no_active_goal", "no active goal found");
  const paths = await resolvePathsWithMigration(discovered.root);
  const goalDir = paths.goalDir;

  return await withGoalLock(paths, () => {
    const state = readGoalState(paths);
    const currentAgent = state?.current?.agent ?? null;

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
  if (!discovered) throw new ToolError("no_active_goal", "no active goal found");
  const paths = await resolvePathsWithMigration(discovered.root);
  const goalDir = paths.goalDir;

  // Write a fault file that the running bridge can detect.
  // relay_now only works when a bridge is running for the current agent.
  const state = await withGoalLock(paths, () => readGoalState(paths));
  if (!state) throw new ToolError("no_active_goal", "no active goal found");

  const currentAgent = state.current?.agent;
  if (!currentAgent) {
    throw new ToolError("no_active_goal", "no current.agent set — is a bridge running?");
  }

  // Write a .fault file for the bridge to detect and act on.
  const faultFile = join(goalDir, "agents", `${currentAgent}.fault`);
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

  // Poll for bridge to pick it up (up to 5s).
  const deadline = Date.now() + 5000;
  let handoffSeq: string | null = null;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
    try {
      const fresh = readGoalState(paths);
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

function validateProgressArgs(args: unknown): { audit_item_id: string; status: "passed" | "failed"; evidence_ref: string } {
  const obj = asObject(args ?? {});
  if (typeof obj.audit_item_id !== "string" || !obj.audit_item_id) throw new ToolError("invalid_input", "audit_item_id is required");
  if (obj.status !== "passed" && obj.status !== "failed") throw new ToolError("invalid_input", "status must be passed or failed");
  if (typeof obj.evidence_ref !== "string" || !obj.evidence_ref) throw new ToolError("invalid_input", "evidence_ref is required");
  return { audit_item_id: obj.audit_item_id, status: obj.status, evidence_ref: obj.evidence_ref };
}

async function toolReportProgress(args: unknown): Promise<{ ok: true }> {
  const p = validateProgressArgs(args);
  const discovered = discoverExistingGoalRoot();
  if (!discovered) throw new ToolError("no_active_goal", "no active goal found");
  const paths = await resolvePathsWithMigration(discovered.root);
  return await withGoalLock(paths, () => {
    const s = readGoalState(paths);
    if (!s) throw new ToolError("no_active_goal", "no active goal found");
    const checklist = s.audit?.checklist ?? [];
    const next = checklist.some((i) => i.id === p.audit_item_id)
      ? checklist.map((i) => i.id === p.audit_item_id ? { ...i, status: p.status, evidence: p.evidence_ref } : i)
      : [...checklist, { id: p.audit_item_id, predicate: p.evidence_ref, status: p.status, evidence: p.evidence_ref }];
    const updated = { ...s, audit: { checklist: next }, updated_at: nowIso() };
    atomicWriteStateV2(paths.goalFile, updated);
    appendEvent(paths, { ts: nowIso(), type: `goal.audit.${p.status}`, goal_id: s.goal_id, audit_item_id: p.audit_item_id, evidence_ref: p.evidence_ref });
    composePreamble(paths, updated);
    return { ok: true };
  });
}

async function toolRecordBreadcrumb(args: unknown): Promise<{ ok: true; seq: number }> {
  const obj = asObject(args ?? {});
  for (const k of ["audit_item", "approach", "outcome", "evidence_ref"] as const) {
    if (typeof obj[k] !== "string" || !(obj[k] as string).trim()) throw new ToolError("invalid_input", `${k} is required`);
  }
  const discovered = discoverExistingGoalRoot();
  if (!discovered) throw new ToolError("no_active_goal", "no active goal found");
  const paths = await resolvePathsWithMigration(discovered.root);
  return await withGoalLock(paths, () => {
    const s = readGoalState(paths);
    if (!s) throw new ToolError("no_active_goal", "no active goal found");
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
    return { ok: true, seq };
  });
}

async function toolReportStuck(args: unknown): Promise<{ ok: true; escalation: string }> {
  const obj = asObject(args ?? {});
  if (typeof obj.audit_item_id !== "string" || !obj.audit_item_id) throw new ToolError("invalid_input", "audit_item_id is required");
  if (typeof obj.reason !== "string" || !obj.reason) throw new ToolError("invalid_input", "reason is required");
  const attempts = typeof obj.attempts === "number" ? obj.attempts : parseInt(String(obj.attempts ?? "1"), 10);
  const discovered = discoverExistingGoalRoot();
  if (!discovered) throw new ToolError("no_active_goal", "no active goal found");
  const paths = await resolvePathsWithMigration(discovered.root);
  return await withGoalLock(paths, () => {
    const s = readGoalState(paths);
    if (!s) throw new ToolError("no_active_goal", "no active goal found");
    appendFileSync(join(paths.goalDir, "escalations.md"), `\n## ${nowIso()} ${obj.audit_item_id}\n${obj.reason}\nattempts=${attempts}\n`, "utf8");
    const escalation = attempts >= 5 ? "paused" : "try_peer";
    const updated = attempts >= 5 ? { ...s, status: "paused" as GoalStatus, updated_at: nowIso(), active_turn_started_at: null } : { ...s, updated_at: nowIso() };
    atomicWriteStateV2(paths.goalFile, updated);
    appendEvent(paths, { ts: nowIso(), type: "goal.audit.stuck", goal_id: s.goal_id, audit_item_id: obj.audit_item_id, attempts, escalation });
    composePreamble(paths, updated);
    return { ok: true, escalation };
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
  if (!discovered) throw new ToolError("no_active_goal", "no active goal found");
  const paths = await resolvePathsWithMigration(discovered.root);
  const s = readGoalState(paths);
  const accepted = s?.status === "pursuing" || s?.status === "relaying";
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
          description: "Only 'complete' is valid. The model cannot pause, resume, replace, modify budget, or mark unmet through this tool — those are user-only operations.",
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
      properties: {},
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
    description: "Mark one audit item passed or failed with concrete evidence. This cannot change lifecycle status or bypass the final audit gate.",
    inputSchema: {
      type: "object",
      required: ["audit_item_id", "status", "evidence_ref"],
      properties: {
        audit_item_id: { type: "string" },
        status: { type: "string", enum: ["passed", "failed"] },
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
        return toolResultFromObject(await toolGetGoal());
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
  "after running a completion audit. If you are blocked, stop and report — do not auto-mark unmet.";

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
      // Ensure dirs exist so fs.watch doesn't ENOENT. Fresh v2/v3 goals use
      // .goal/state.json, so create .goal before the first goal exists.
      ensureClaudeDir(paths);
      ensureGoalStateDir(paths);
    } catch (err) {
      logError("channel: failed to ensure .claude dir", { reason: (err as Error)?.message });
      return;
    }
    // Watch the canonical state dir: .goal/ if v2, else .claude/.
    const watchDir = paths.goalFile.includes("/.goal/") ? paths.goalDir : paths.claudeDir;
    try {
      // Watch the directory rather than the file itself: file-level watch breaks
      // on atomic-rename writes (the inode changes), which is exactly what our
      // own atomicWriteJson does.
      this.watcher = watch(watchDir, { persistent: false }, (_eventType, filename) => {
        // We only care about state file changes (state.json for v2, goal.json for v1).
        if (filename && filename !== "goal.json" && filename !== "state.json" && filename !== "goal.pause" && filename !== "pause") return;
        this.coalesceAndEvaluate("filewatch");
      });
      this.watcher.on("error", (err: Error) => {
        logError("channel: watcher error", { reason: err.message });
        try { this.watcher?.close(); } catch { /* best-effort */ }
        this.watcher = null;
      });
      logDebug("channel: watcher installed", { dir: watchDir });
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
        const mtime = statSync(paths.goalFile).mtimeMs;
        if (mtime !== this.lastStateMtimeMs) {
          this.lastStateMtimeMs = mtime;
          this.coalesceAndEvaluate("filewatch");
        }
      } catch {
        // State file may not exist yet.
      }
    }, 500);
    this.pollTimer.unref?.();
    logDebug("channel: polling fallback installed");
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

    let decision: { kind: "send"; goalId: string } | { kind: "skip"; outcome: PushOutcome; goalId: string };
    try {
      decision = await withGoalLock(paths, () => this.decideUnderLock(paths, trigger));
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
    trigger: PushTrigger,
  ): { kind: "send"; goalId: string } | { kind: "skip"; outcome: PushOutcome; goalId: string } {
    // Pause file: hardest kill switch.
    const pauseFile = join(paths.goalDir, "pause");
    if (existsSync(pauseFile)) {
      return { kind: "skip", outcome: "skipped_paused", goalId: this.peekGoalId(paths) };
    }

    let state: GoalState | null;
    try {
      state = readGoalState(paths);
    } catch (err) {
      logError("channel: failed to read goal state", { reason: (err as Error)?.message });
      return { kind: "skip", outcome: "skipped_no_goal", goalId: "" };
    }
    if (!state) {
      return { kind: "skip", outcome: "skipped_no_goal", goalId: "" };
    }

    if (state.status !== "pursuing") {
      // We don't push for paused/achieved/unmet/budget-limited. Each is a
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

  /** Best-effort goal_id read for events when we've decided to skip. */
  private peekGoalId(paths: GoalPaths): string {
    try {
      const s = readGoalState(paths);
      return s?.goal_id ?? "";
    } catch {
      return "";
    }
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
        "If you are blocked, stop and report — do not auto-mark unmet.",
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
  readGoalState,
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
