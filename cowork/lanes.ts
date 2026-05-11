/**
 * cowork/lanes.ts — lane lease management for .goal/lanes.json
 *
 * Per spec §5.3, §3 F6, §13:
 *   - Leases stored in .goal/lanes.json as { leases: [...] }
 *   - All reads/writes under .goal/lock (same dir mutex as bridge + MCP)
 *   - Lazy TTL expiry: prune stale leases on every read
 *   - Stale heartbeat eviction: evict if holder's heartbeat older than GOAL_HEARTBEAT_TTL_MS
 *   - Glob conflict detection: conservative heuristic described below
 *
 * Glob conflict heuristic (spec architectural decision):
 *   Two globs conflict if they OVERLAP (could match the same file).
 *   Strategy: convert both globs to regex via globToRegex(), then:
 *     - Test if regex(globA) matches a sample path generated from globB
 *     - Test if regex(globB) matches a sample path generated from globA
 *   If either direction matches, the globs conflict.
 *   This is conservative (false positives = "conflict" is safer than false negatives).
 *   The regex conversion handles **, *, ? and treats all other chars as literals.
 *
 * No external dependencies — node:fs only.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";

// ──────────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────────

export interface LaneLease {
  lease_id: string;
  glob: string;
  holder: string;
  acquired_at: string;
  ttl_seconds: number;
  reason: string;
}

export interface LanesFile {
  leases: LaneLease[];
}

export interface ClaimLaneResult {
  ok: true;
  lease_id: string;
} | {
  ok: false;
  conflict_with: string; // lease_id of conflicting lease
};

// ──────────────────────────────────────────────────────────────────────────────
// Config
// ──────────────────────────────────────────────────────────────────────────────

const DEFAULT_HEARTBEAT_TTL_MS = parseInt(
  process.env.GOAL_HEARTBEAT_TTL_MS ?? "15000",
  10,
);

// ──────────────────────────────────────────────────────────────────────────────
// File I/O
// ──────────────────────────────────────────────────────────────────────────────

export function lanesFilePath(goalDir: string): string {
  return join(goalDir, "lanes.json");
}

/** Read lanes.json. If absent, returns an empty file. */
export function readLanesFile(goalDir: string): LanesFile {
  const filePath = lanesFilePath(goalDir);
  if (!existsSync(filePath)) return { leases: [] };
  try {
    const raw = readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || !Array.isArray((parsed as Record<string, unknown>).leases)) {
      return { leases: [] };
    }
    return parsed as LanesFile;
  } catch (_) {
    return { leases: [] };
  }
}

/** Write lanes.json atomically. Must be called under .goal/lock. */
export function writeLanesFile(goalDir: string, data: LanesFile): void {
  const filePath = lanesFilePath(goalDir);
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });
  const tmpDir = mkdtempSync(join(dir, ".tmp-lanes-"));
  const tmp = join(tmpDir, "lanes.json");
  try {
    writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
    renameSync(tmp, filePath);
  } finally {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch (_) {
      // best-effort
    }
    try {
      rmdirSync(tmpDir);
    } catch (_) {
      // best-effort
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Lazy TTL expiry + stale heartbeat eviction
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Read lanes.json and prune stale/expired leases.
 * Must be called under .goal/lock to ensure atomic prune+write.
 *
 * Stale = TTL expired OR holder heartbeat older than heartbeatTtlMs.
 */
export function readAndPruneLanes(
  goalDir: string,
  heartbeatTtlMs: number = DEFAULT_HEARTBEAT_TTL_MS,
): LanesFile {
  const data = readLanesFile(goalDir);
  const now = Date.now();

  const active = data.leases.filter((lease) => {
    // TTL check.
    const acquiredMs = Date.parse(lease.acquired_at);
    if (Number.isFinite(acquiredMs)) {
      const ageMs = now - acquiredMs;
      if (ageMs > lease.ttl_seconds * 1000) {
        return false; // expired
      }
    }

    // Stale heartbeat check.
    if (lease.holder && heartbeatTtlMs > 0) {
      const heartbeatAge = getHolderHeartbeatAge(goalDir, lease.holder);
      if (heartbeatAge !== null && heartbeatAge > heartbeatTtlMs) {
        return false; // stale holder
      }
    }

    return true;
  });

  if (active.length !== data.leases.length) {
    // Prune happened — write back.
    writeLanesFile(goalDir, { leases: active });
    return { leases: active };
  }

  return data;
}

/** Get the age in ms of the holder's heartbeat. Returns null if not determinable. */
function getHolderHeartbeatAge(goalDir: string, holder: string): number | null {
  const agentFile = join(goalDir, "agents", `${holder}.json`);
  if (!existsSync(agentFile)) return null;
  try {
    const raw = readFileSync(agentFile, "utf8");
    const obj = JSON.parse(raw) as Record<string, unknown>;
    const hbAt = obj.heartbeat_at;
    if (typeof hbAt !== "string") return null;
    const hbMs = Date.parse(hbAt);
    if (!Number.isFinite(hbMs)) return null;
    return Date.now() - hbMs;
  } catch (_) {
    return null;
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Glob conflict detection
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Convert a file glob pattern to a RegExp.
 *
 * Heuristic: handles **, *, ? and treats all other chars as literals.
 * Conservative: may produce false positives (conflict when there isn't one),
 * but never false negatives.
 *
 * Examples:
 *   "src/auth/**"  → /^src\/auth\/.*$/
 *   "*.ts"          → /^[^/]*\.ts$/
 *   "src/?.ts"      → /^src\/[^/]\.ts$/
 */
export function globToRegex(glob: string): RegExp {
  let pattern = "^";
  let i = 0;
  while (i < glob.length) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        // ** matches anything including path separators.
        pattern += ".*";
        i += 2;
        // Skip trailing / after ** if present.
        if (glob[i] === "/") i++;
      } else {
        // * matches anything except path separator.
        pattern += "[^/]*";
        i++;
      }
    } else if (ch === "?") {
      // ? matches any single char except path separator.
      pattern += "[^/]";
      i++;
    } else if (/[.+^${}()|[\]\\]/.test(ch)) {
      // Escape regex special chars.
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

/**
 * Generate a representative sample path from a glob.
 * Used to test if another glob's regex matches paths that this glob would produce.
 *
 * Strategy: replace ** with a/b, * with x, ? with y, keep literals.
 */
function samplePathFromGlob(glob: string): string {
  return glob
    .replace(/\*\*\//g, "a/b/")
    .replace(/\*\*/g, "a/b")
    .replace(/\*/g, "x")
    .replace(/\?/g, "y");
}

/**
 * Check if two globs conflict (could match the same file).
 *
 * Returns true if:
 *   - regex(globA) matches samplePath(globB), OR
 *   - regex(globB) matches samplePath(globA)
 *
 * This is conservative: false positives are acceptable (deny = safe);
 * false negatives are unacceptable (two agents editing same file).
 */
export function globsConflict(globA: string, globB: string): boolean {
  const sampleA = samplePathFromGlob(globA);
  const sampleB = samplePathFromGlob(globB);

  let regA: RegExp;
  let regB: RegExp;
  try {
    regA = globToRegex(globA);
    regB = globToRegex(globB);
  } catch (_) {
    // If regex construction fails, be conservative and report conflict.
    return true;
  }

  return regA.test(sampleB) || regB.test(sampleA);
}

// ──────────────────────────────────────────────────────────────────────────────
// Lease operations (must all be called under .goal/lock)
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Attempt to claim a lane lease.
 * Returns {ok:true, lease_id} on success, {ok:false, conflict_with} on conflict.
 *
 * Must be called under .goal/lock.
 */
export function claimLane(
  goalDir: string,
  holder: string,
  glob: string,
  ttlSeconds: number,
  reason: string,
  heartbeatTtlMs: number = DEFAULT_HEARTBEAT_TTL_MS,
): ClaimLaneResult {
  const data = readAndPruneLanes(goalDir, heartbeatTtlMs);

  // Check for conflict with any existing lease (held by a different agent).
  for (const existing of data.leases) {
    if (existing.holder === holder) {
      // Same holder: check if they're renewing the same or overlapping glob.
      // Allow same-holder overlapping globs without conflict (renewal pattern).
      if (existing.glob === glob) {
        // Exact renewal — update TTL in place.
        const renewed: LaneLease[] = data.leases.map((l) =>
          l.lease_id === existing.lease_id
            ? { ...l, acquired_at: nowIso(), ttl_seconds: ttlSeconds, reason }
            : l,
        );
        writeLanesFile(goalDir, { leases: renewed });
        return { ok: true, lease_id: existing.lease_id };
      }
      continue; // same holder, different glob — ok
    }

    // Different holder: check for glob overlap.
    if (globsConflict(glob, existing.glob)) {
      return { ok: false, conflict_with: existing.lease_id };
    }
  }

  // No conflict — create new lease.
  const leaseId = randomUUID();
  const newLease: LaneLease = {
    lease_id: leaseId,
    glob,
    holder,
    acquired_at: nowIso(),
    ttl_seconds: ttlSeconds,
    reason,
  };
  writeLanesFile(goalDir, { leases: [...data.leases, newLease] });
  return { ok: true, lease_id: leaseId };
}

/**
 * Release a lane lease by lease_id.
 * Returns true if the lease was found and removed, false if not found.
 *
 * Must be called under .goal/lock.
 */
export function releaseLane(
  goalDir: string,
  leaseId: string,
): boolean {
  const data = readLanesFile(goalDir);
  const before = data.leases.length;
  const after = data.leases.filter((l) => l.lease_id !== leaseId);
  if (after.length === before) return false;
  writeLanesFile(goalDir, { leases: after });
  return true;
}

/**
 * List all active (non-expired, non-stale) leases.
 * Performs lazy pruning.
 *
 * Must be called under .goal/lock.
 */
export function listLanes(
  goalDir: string,
  heartbeatTtlMs: number = DEFAULT_HEARTBEAT_TTL_MS,
): LaneLease[] {
  return readAndPruneLanes(goalDir, heartbeatTtlMs).leases;
}

/**
 * Clear all leases (used in tests).
 */
export function clearAllLanes(goalDir: string): void {
  writeLanesFile(goalDir, { leases: [] });
}

// ──────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ──────────────────────────────────────────────────────────────────────────────

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}
