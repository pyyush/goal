/**
 * cowork/handoff/parse.ts — TypeScript parser for .goal/handoff/NNNN.md
 *
 * Parses the canonical handoff envelope format defined in template.md (§5.2).
 * Used by mcp/goal-server.ts and any other Node consumer.
 *
 * No external dependencies — uses node:fs only.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// ---- public types -----------------------------------------------------------

export type HandoffReason =
  | 'planned'
  | 'rate_limit'
  | 'budget_step_down'
  | 'error'
  | 'user';

export interface HandoffEnvelope {
  /** Zero-padded 4-digit sequence number, e.g. "0007" */
  seq: string;
  from: string;
  to: string;
  /** ISO-8601 timestamp */
  at: string;
  reason: HandoffReason;
  goal_id: string;
  did: string[];
  did_not: string[];
  next: string[];
  do_not_redo: string[];
  open_audit: string[];
  evidence: string[];
}

// ---- internal helpers -------------------------------------------------------

const REQUIRED_FRONTMATTER_KEYS: ReadonlyArray<keyof HandoffEnvelope> = [
  'seq', 'from', 'to', 'at', 'reason', 'goal_id',
];

const VALID_REASONS = new Set<string>([
  'planned', 'rate_limit', 'budget_step_down', 'error', 'user',
]);

const SECTION_HEADERS: Record<string, string> = {
  did:         '## Did',
  did_not:     '## Did not',
  next:        '## Next',
  do_not_redo: '## Do not redo',
  open_audit:  '## Open audit items',
  evidence:    '## Evidence',
};

/** Parse YAML-style frontmatter block (between first --- pair). */
function parseFrontmatter(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  const lines = content.split('\n');

  let inFront = false;
  let pastFirst = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '---') {
      if (!pastFirst) {
        inFront = true;
        pastFirst = true;
        continue;
      }
      if (inFront) {
        break; // closing ---
      }
    }
    if (!inFront) continue;

    const colonIdx = line.indexOf(':');
    if (colonIdx < 0) continue;

    const key = line.slice(0, colonIdx).trim();
    const val = line.slice(colonIdx + 1).trim();
    if (key) result[key] = val;
  }

  return result;
}

/** Extract bullet lines from a named body section. */
function parseSection(content: string, sectionKey: string): string[] {
  const header = SECTION_HEADERS[sectionKey];
  if (!header) throw new Error(`Unknown section key: ${sectionKey}`);

  const lines = content.split('\n');
  const bullets: string[] = [];

  // Skip frontmatter.
  let inFront = false;
  let pastFirst = false;
  let inSection = false;

  for (const line of lines) {
    const trimmed = line.trim();

    // Frontmatter fence detection.
    if (trimmed === '---') {
      if (!pastFirst) {
        inFront = true;
        pastFirst = true;
        continue;
      }
      if (inFront) {
        inFront = false;
        continue;
      }
    }
    if (inFront) continue;

    // Section header detection.
    if (line.startsWith('## ')) {
      inSection = (line.trimEnd() === header);
      continue;
    }

    // Collect bullet lines.
    if (inSection && line.startsWith('- ')) {
      bullets.push(line.slice(2).trim());
    }
  }

  return bullets;
}

// ---- public API -------------------------------------------------------------

/**
 * Parse a single handoff envelope file.
 * Throws if the file cannot be read or the content is malformed.
 */
export function parseHandoff(filePath: string): HandoffEnvelope {
  let content: string;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`parseHandoff: cannot read file "${filePath}": ${msg}`);
  }

  const front = parseFrontmatter(content);

  const envelope: HandoffEnvelope = {
    seq:         front['seq']     ?? '',
    from:        front['from']    ?? '',
    to:          front['to']      ?? '',
    at:          front['at']      ?? '',
    reason:      (front['reason'] ?? '') as HandoffReason,
    goal_id:     front['goal_id'] ?? '',
    did:         parseSection(content, 'did'),
    did_not:     parseSection(content, 'did_not'),
    next:        parseSection(content, 'next'),
    do_not_redo: parseSection(content, 'do_not_redo'),
    open_audit:  parseSection(content, 'open_audit'),
    evidence:    parseSection(content, 'evidence'),
  };

  validateHandoff(envelope);
  return envelope;
}

/**
 * Validate a parsed HandoffEnvelope.
 * Throws with a descriptive message if any required field is missing or invalid.
 */
export function validateHandoff(env: HandoffEnvelope): void {
  for (const key of REQUIRED_FRONTMATTER_KEYS) {
    const val = env[key];
    if (!val || (Array.isArray(val) ? val.length === 0 : (val as string).trim() === '')) {
      // Empty arrays are allowed for body sections in the schema — only frontmatter
      // keys are strictly required.
      if (typeof val === 'string' && val.trim() === '') {
        throw new Error(`validateHandoff: required frontmatter field "${key}" is missing or empty`);
      }
    }
  }

  // Validate seq format: exactly 4 digits.
  if (!/^\d{4}$/.test(env.seq)) {
    throw new Error(
      `validateHandoff: "seq" must be a 4-digit zero-padded string (got "${env.seq}")`
    );
  }

  // Validate reason enum.
  if (!VALID_REASONS.has(env.reason)) {
    throw new Error(
      `validateHandoff: invalid "reason" value "${env.reason}" — must be one of: ${[...VALID_REASONS].join(', ')}`
    );
  }

  // Validate from/to non-empty.
  for (const field of ['from', 'to', 'at', 'goal_id'] as const) {
    if (!env[field] || env[field].trim() === '') {
      throw new Error(`validateHandoff: required field "${field}" is missing or empty`);
    }
  }
}

/**
 * List all handoff envelope paths in a goal directory, sorted by seq ascending.
 * Returns absolute paths.
 *
 * @param goalDir  Path to the .goal/ directory (not the handoff/ subdirectory).
 */
export function listHandoffs(goalDir: string): string[] {
  const handoffDir = join(goalDir, 'handoff');
  let files: string[];
  try {
    files = readdirSync(handoffDir);
  } catch (_) {
    return [];
  }

  return files
    .filter(f => /^\d{4}\.md$/.test(f))
    .sort()
    .map(f => join(handoffDir, f));
}

/**
 * Read and parse the handoff envelope with the given seq string (e.g. "0007").
 * Throws if not found or parse fails.
 *
 * @param goalDir  Path to the .goal/ directory.
 * @param seq      4-digit zero-padded sequence string.
 */
export function readHandoffBySeq(goalDir: string, seq: string): HandoffEnvelope {
  const normalized = seq.padStart(4, '0');
  const filePath = join(goalDir, 'handoff', `${normalized}.md`);
  return parseHandoff(filePath);
}
