/**
 * cowork/handoff/write.ts — shared handoff envelope writer
 *
 * Extracted from bin/goal-bridge so both the bridge AND the MCP tool
 * mcp__goal__write_handoff can call the same logic (DRY per spec §13).
 *
 * Caller contract:
 *   - Must be called under .goal/lock (bridge: mkdirSync mutex; MCP: proper-lockfile)
 *   - Provides monotonic seq via nextHandoffSeq()
 *   - Atomic write: mktemp + rename(2) per spec N3
 *
 * No external dependencies — node:fs only.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  unlinkSync,
  rmdirSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { join, dirname } from "node:path";

// ──────────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────────

export type HandoffReason = "planned" | "rate_limit" | "budget_step_down" | "error" | "user";

export interface WriteHandoffArgs {
  /** .goal/ directory path */
  goalDir: string;
  /** Agent ID writing the handoff (from) */
  from: string;
  /** Agent ID receiving the handoff (to) */
  to: string;
  /** Reason enum */
  reason: HandoffReason;
  /** Goal UUID */
  goalId: string;
  /** Bullets for "## Did" — strings without leading "- " */
  did: string[];
  /** Bullets for "## Did not" */
  did_not: string[];
  /** Bullets for "## Next" */
  next: string[];
  /** Bullets for "## Do not redo" */
  do_not_redo: string[];
  /** Bullets for "## Open audit items" — derived from state.audit if not provided */
  open_audit?: string[];
  /** Bullets for "## Evidence" */
  evidence: string[];
  /**
   * Optional path to the handoff template file.
   * If provided and exists, used as the canonical template.
   * Otherwise falls back to the inline format.
   */
  templatePath?: string;
}

export interface WriteHandoffResult {
  /** Zero-padded 4-digit seq string, e.g. "0007" */
  seq: string;
  /** Absolute path to the written file */
  path: string;
  /** ISO-8601 timestamp at write time */
  ts: string;
}

// ──────────────────────────────────────────────────────────────────────────────
// Public API
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Compute the next monotonic handoff sequence number.
 * Must be called under .goal/lock to avoid seq collisions.
 *
 * @param handoffDir  Absolute path to .goal/handoff/
 */
export function nextHandoffSeq(handoffDir: string): number {
  mkdirSync(handoffDir, { recursive: true });
  let max = 0;
  try {
    const files = readdirSync(handoffDir).filter((f) => /^\d{4}\.md$/.test(f));
    for (const f of files) {
      const n = parseInt(f, 10);
      if (n > max) max = n;
    }
  } catch (_) {
    // Directory may be newly created — treat as empty.
  }
  return max + 1;
}

/**
 * Format a sequence number as a 4-digit zero-padded string.
 */
export function formatSeq(n: number): string {
  return String(n).padStart(4, "0");
}

/**
 * Write a handoff envelope atomically.
 * Must be called under .goal/lock.
 *
 * Throws on write failure (caller must abort relay per spec §13).
 */
export function writeHandoff(args: WriteHandoffArgs): WriteHandoffResult {
  const handoffDir = join(args.goalDir, "handoff");
  mkdirSync(handoffDir, { recursive: true });

  const seq = nextHandoffSeq(handoffDir);
  return writeHandoffWithSeq({ ...args, handoffDir, seq });
}

/**
 * Write a handoff envelope with a pre-computed seq (for bridge callers that
 * compute seq inside the lock using nextHandoffSeq directly).
 */
export function writeHandoffWithSeq(args: WriteHandoffArgs & { handoffDir: string; seq: number }): WriteHandoffResult {
  const { handoffDir, seq } = args;
  const seqStr = formatSeq(seq);
  const ts = nowIso();
  const handoffPath = join(handoffDir, `${seqStr}.md`);

  // Format bullet arrays.
  const fmtBullets = (bullets: string[]) => {
    if (bullets.length === 0) return "- (none)";
    return bullets.map((b) => (b.startsWith("- ") ? b : `- ${b}`)).join("\n");
  };

  const didBullets = fmtBullets(args.did);
  const didNotBullets = fmtBullets(args.did_not);
  const nextBullets = fmtBullets(args.next);
  const doNotRedoBullets = fmtBullets(args.do_not_redo);
  const openAuditBullets = fmtBullets(args.open_audit ?? ["See state.json .audit.checklist"]);
  const evidenceBullets = fmtBullets(args.evidence);

  let content: string;

  // Try template file first.
  if (args.templatePath) {
    let templateBody: string | null = null;
    try {
      const raw = readFileSync(args.templatePath, "utf8");
      // Strip the leading comment block (<!-- ... -->) before filling.
      templateBody = raw.replace(/^<!--[\s\S]*?-->\n?/, "");
    } catch (_) {
      // Template absent — fall through to inline format.
    }

    if (templateBody !== null) {
      content = templateBody
        .replace("{seq}", seqStr)
        .replace("{from}", args.from)
        .replace("{to}", args.to)
        .replace("{at}", ts)
        .replace("{reason}", args.reason)
        .replace("{goal_id}", args.goalId)
        .replace("{did}", didBullets)
        .replace("{did_not}", didNotBullets)
        .replace("{next}", nextBullets)
        .replace("{do_not_redo}", doNotRedoBullets)
        .replace("{open_audit}", openAuditBullets)
        .replace("{evidence}", evidenceBullets);
    } else {
      content = buildInlineContent(seqStr, ts, args, didBullets, didNotBullets, nextBullets, doNotRedoBullets, openAuditBullets, evidenceBullets);
    }
  } else {
    content = buildInlineContent(seqStr, ts, args, didBullets, didNotBullets, nextBullets, doNotRedoBullets, openAuditBullets, evidenceBullets);
  }

  // Atomic write.
  const tmpDir = mkdtempSync(join(handoffDir, ".tmp-handoff-"));
  const tmp = join(tmpDir, "handoff.md");
  try {
    writeFileSync(tmp, content, "utf8");
    renameSync(tmp, handoffPath);
  } catch (e) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch (_) {
      // best-effort cleanup
    }
    try {
      rmdirSync(tmpDir);
    } catch (_) {
      // best-effort cleanup
    }
    throw e; // Abort relay — spec §13.
  }
  try {
    rmdirSync(tmpDir);
  } catch (_) {
    // best-effort cleanup
  }

  return { seq: seqStr, path: handoffPath, ts };
}

// ──────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ──────────────────────────────────────────────────────────────────────────────

function buildInlineContent(
  seqStr: string,
  ts: string,
  args: WriteHandoffArgs,
  didBullets: string,
  didNotBullets: string,
  nextBullets: string,
  doNotRedoBullets: string,
  openAuditBullets: string,
  evidenceBullets: string,
): string {
  const frontmatter = [
    "---",
    `seq: ${seqStr}`,
    `from: ${args.from}`,
    `to: ${args.to}`,
    `at: ${ts}`,
    `reason: ${args.reason}`,
    `goal_id: ${args.goalId}`,
    "---",
  ].join("\n");

  const body = [
    "",
    "## Did",
    didBullets,
    "",
    "## Did not",
    didNotBullets,
    "",
    "## Next",
    nextBullets,
    "",
    "## Do not redo",
    doNotRedoBullets,
    "",
    "## Open audit items",
    openAuditBullets,
    "",
    "## Evidence",
    evidenceBullets,
  ].join("\n");

  return frontmatter + "\n" + body + "\n";
}

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}
