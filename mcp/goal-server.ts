#!/usr/bin/env node
/**
 * goal-mcp-server — Phase 1 of the /goal parity-tools design.
 *
 * Exposes three native model-side tools over stdio MCP:
 *   - create_goal(objective, token_budget?)
 *   - update_goal(status: "complete")     // asymmetric, model can only mark done
 *   - get_goal()                          // computed remaining_tokens, elapsed_seconds
 *
 * State of record: `.claude/goal.json` at the goal root, shared with hooks &
 * `bin/goalctl`. Writes are atomic (tmp + rename), serialized by proper-lockfile,
 * and CAS-guarded on `goal_id`. Lifecycle transitions append a JSONL event to
 * `.claude/goal-events.jsonl`.
 *
 * Logging policy: stdout is the MCP transport. All diagnostics MUST go to stderr.
 */

import { appendFileSync, mkdirSync, existsSync, lstatSync, readdirSync, readFileSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync, watch, type FSWatcher } from "node:fs";
import { mkdtempSync, openSync, closeSync, fsyncSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

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
  goalFile: string;          // .goal/state.json (v2) or .claude/goal.json (v1)
  v1GoalFile: string;        // always .claude/goal.json (migration source)
  eventsFile: string;
  baselineGlobPrefix: string;
  markerFile: string;        // .claude/MIGRATED_TO_GOAL
}

function pathsFor(root: string): GoalPaths {
  const claudeDir = join(root, ".claude");
  const goalDir = join(root, ".goal");
  // Prefer v2 path if .goal/ exists; otherwise fall back to v1.
  // When GOAL_DISABLE_MIGRATION is set, always use v1.
  const disableMigration = process.env.GOAL_DISABLE_MIGRATION === "1";
  let useV2 = false;
  if (!disableMigration) {
    try {
      useV2 = lstatSync(goalDir).isDirectory();
    } catch {
      useV2 = false;
    }
  }
  return {
    root,
    claudeDir,
    goalDir,
    goalFile: useV2 ? join(goalDir, "state.json") : join(claudeDir, "goal.json"),
    v1GoalFile: join(claudeDir, "goal.json"),
    eventsFile: join(claudeDir, "goal-events.jsonl"),
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
//   - .claude/goal.pause exists            → never push
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
  private bootTimer: NodeJS.Timeout | null = null;
  private coalesceTimer: NodeJS.Timeout | null = null;
  private currentRoot: string | null = null;
  private lastTickCount: number | null = null;
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
    this.scheduleBootPush();
    this.scheduleTimer();
  }

  /** Tear everything down. Safe to call multiple times. */
  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.bootTimer) { clearTimeout(this.bootTimer); this.bootTimer = null; }
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
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
      // Ensure dirs exist so fs.watch doesn't ENOENT.
      ensureClaudeDir(paths);
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
        if (filename && filename !== "goal.json" && filename !== "state.json" && filename !== "goal.pause") return;
        this.coalesceAndEvaluate("filewatch");
      });
      this.watcher.on("error", (err: Error) => {
        logError("channel: watcher error", { reason: err.message });
      });
      logDebug("channel: watcher installed", { dir: watchDir });
    } catch (err) {
      logError("channel: watch() failed; filewatch trigger disabled", { reason: (err as Error)?.message });
    }
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
    const pauseFile = join(paths.claudeDir, "goal.pause");
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

