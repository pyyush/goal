/**
 * cowork/cowork-yml.ts — hand-rolled parser for .goal/cowork.yml
 *
 * Per spec §5.5 and architectural decision: NO new deps (no yaml library).
 * Parses the limited subset of YAML defined by the cowork.yml schema.
 *
 * Supported shape:
 *   version: 1
 *   agents:
 *     <name>:
 *       runner: <string>
 *       model: <string>
 *   roles:
 *     lead:   <agent_name>
 *     build:  <agent_name>
 *     review: <agent_name>
 *   relay:
 *     on_rate_limit:       <bool>
 *     on_5xx:              <bool>
 *     small_model_offload: <bool>
 *   heartbeat_ttl_seconds: <number>
 *
 * Rejects unknown top-level keys with a clear error message.
 * All fields are optional except version.
 *
 * Parse strategy:
 *   - Strip comments (#…)
 *   - Track indentation level (0, 2, 4 spaces) to determine structure
 *   - Only handles scalar values (strings, booleans, numbers) and two-level
 *     nested mappings (no sequences at top level)
 *
 * Exported:
 *   parseCoworkYml(text: string): CoworkConfig
 *   loadCoworkYml(filePath: string): CoworkConfig | null  (null if file absent)
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// ──────────────────────────────────────────────────────────────────────────────
// Types (exported for use in MCP server and statusline)
// ──────────────────────────────────────────────────────────────────────────────

export interface CoworkAgentConfig {
  runner: string;
  model: string;
}

export interface CoworkRoles {
  lead: string | null;
  build: string | null;
  review: string | null;
}

export interface CoworkRelayConfig {
  on_rate_limit: boolean;
  on_5xx: boolean;
  small_model_offload: boolean;
}

export interface CoworkConfig {
  version: number;
  agents: Record<string, CoworkAgentConfig>;
  roles: CoworkRoles;
  relay: CoworkRelayConfig;
  heartbeat_ttl_seconds: number;
}

// Allowed top-level keys.
const TOP_LEVEL_KEYS = new Set(["version", "agents", "roles", "relay", "heartbeat_ttl_seconds"]);

// Allowed keys under "agents.<name>".
const AGENT_KEYS = new Set(["runner", "model"]);

// Allowed keys under "roles".
const ROLE_KEYS = new Set(["lead", "build", "review"]);

// Allowed keys under "relay".
const RELAY_KEYS = new Set(["on_rate_limit", "on_5xx", "small_model_offload"]);

/**
 * Parse the limited YAML subset accepted by cowork.yml.
 * Throws with a descriptive message on any schema violation.
 */
export function parseCoworkYml(text: string): CoworkConfig {
  const lines = text.split(/\r?\n/);

  // Strip trailing comments and trim trailing whitespace.
  // We do NOT strip inline comments inside values (not needed for our schema).
  const cleaned = lines.map((l) => {
    // Remove full-line comments.
    const stripped = l.replace(/\s*#[^\n]*$/, "");
    return stripped;
  });

  // Result accumulator.
  const result: {
    version?: number;
    agents: Record<string, CoworkAgentConfig>;
    roles: CoworkRoles;
    relay: CoworkRelayConfig;
    heartbeat_ttl_seconds?: number;
  } = {
    agents: {},
    roles: { lead: null, build: null, review: null },
    relay: { on_rate_limit: true, on_5xx: true, small_model_offload: false },
  };

  // Parsing state machine.
  type Section = "top" | "agents" | "agents.entry" | "roles" | "relay";
  let section: Section = "top";
  let currentAgentName = "";

  for (let i = 0; i < cleaned.length; i++) {
    const raw = cleaned[i];
    if (!raw.trim()) continue; // blank line

    const indent = raw.search(/\S/);
    const content = raw.trim();

    // Split into key: value (colon-separated, first colon wins).
    const colonIdx = content.indexOf(":");
    if (colonIdx < 0) {
      // Line without colon — skip (continuation values not used in our schema).
      continue;
    }
    const key = content.slice(0, colonIdx).trim();
    const value = content.slice(colonIdx + 1).trim();

    // Top-level keys (indent = 0)
    if (indent === 0) {
      if (!TOP_LEVEL_KEYS.has(key)) {
        throw new Error(`cowork.yml: unknown top-level key "${key}". Allowed: ${[...TOP_LEVEL_KEYS].join(", ")}`);
      }

      switch (key) {
        case "version": {
          const v = parseFloat(value);
          if (!Number.isFinite(v)) throw new Error(`cowork.yml: version must be a number (got "${value}")`);
          result.version = v;
          section = "top";
          break;
        }
        case "heartbeat_ttl_seconds": {
          const n = parseFloat(value);
          if (!Number.isFinite(n) || n <= 0) throw new Error(`cowork.yml: heartbeat_ttl_seconds must be a positive number (got "${value}")`);
          result.heartbeat_ttl_seconds = n;
          section = "top";
          break;
        }
        case "agents":
          section = "agents";
          currentAgentName = "";
          break;
        case "roles":
          section = "roles";
          break;
        case "relay":
          section = "relay";
          break;
        default:
          section = "top";
          break;
      }
      continue;
    }

    // Depth-2 keys (indent = 2) under a section
    if (indent === 2) {
      switch (section) {
        case "agents": {
          // This is an agent name.
          if (!key) throw new Error(`cowork.yml: agents: empty agent name`);
          // Agent name must be alphanumeric + dash/underscore.
          if (!/^[a-zA-Z0-9_-]+$/.test(key)) {
            throw new Error(`cowork.yml: agents: invalid agent name "${key}" (use [a-zA-Z0-9_-] only)`);
          }
          currentAgentName = key;
          if (!result.agents[currentAgentName]) {
            result.agents[currentAgentName] = { runner: "", model: "default" };
          }
          section = "agents.entry";
          break;
        }
        case "agents.entry": {
          // Might be another agent at indent=2, or a field.
          // We detect agent fields at indent=4 below. If indent=2 here under
          // agents.entry, treat as a new agent name.
          if (!key) break;
          if (!/^[a-zA-Z0-9_-]+$/.test(key)) {
            throw new Error(`cowork.yml: agents: invalid agent name "${key}"`);
          }
          currentAgentName = key;
          if (!result.agents[currentAgentName]) {
            result.agents[currentAgentName] = { runner: "", model: "default" };
          }
          break;
        }
        case "roles": {
          if (!ROLE_KEYS.has(key)) {
            throw new Error(`cowork.yml: roles: unknown key "${key}". Allowed: ${[...ROLE_KEYS].join(", ")}`);
          }
          const roleKey = key as "lead" | "build" | "review";
          result.roles[roleKey] = value || null;
          break;
        }
        case "relay": {
          if (!RELAY_KEYS.has(key)) {
            throw new Error(`cowork.yml: relay: unknown key "${key}". Allowed: ${[...RELAY_KEYS].join(", ")}`);
          }
          const boolVal = parseBool(value, `relay.${key}`);
          (result.relay as Record<string, boolean>)[key] = boolVal;
          break;
        }
        default:
          // Ignore under top-level scalars.
          break;
      }
      continue;
    }

    // Depth-4 keys (indent = 4) — agent fields
    if (indent === 4) {
      if ((section === "agents" || section === "agents.entry") && currentAgentName) {
        if (!AGENT_KEYS.has(key)) {
          throw new Error(`cowork.yml: agents.${currentAgentName}: unknown key "${key}". Allowed: ${[...AGENT_KEYS].join(", ")}`);
        }
        if (key === "runner") result.agents[currentAgentName].runner = value;
        if (key === "model") result.agents[currentAgentName].model = value || "default";
      }
      continue;
    }

    // Deeper indentation — unsupported.
    if (indent > 4) {
      throw new Error(`cowork.yml: unexpected deep nesting at line ${i + 1}: "${raw.trim()}"`);
    }
  }

  if (result.version === undefined) {
    throw new Error(`cowork.yml: missing required field "version"`);
  }

  return {
    version: result.version,
    agents: result.agents,
    roles: result.roles,
    relay: result.relay,
    heartbeat_ttl_seconds: result.heartbeat_ttl_seconds ?? 15,
  };
}

/**
 * Load cowork.yml from .goal/cowork.yml at the given root.
 * Returns null if the file does not exist.
 * Throws if the file exists but is invalid.
 */
export function loadCoworkYml(goalRoot: string): CoworkConfig | null {
  const filePath = join(goalRoot, ".goal", "cowork.yml");
  if (!existsSync(filePath)) return null;
  const text = readFileSync(filePath, "utf8");
  return parseCoworkYml(text);
}

/**
 * Look up the role label for a given agent ID in a CoworkConfig.
 * Returns the role name (e.g. "lead", "build", "review") or null.
 */
export function getRoleForAgent(config: CoworkConfig, agentId: string): string | null {
  const roles = config.roles as Record<string, string | null>;
  for (const [role, agent] of Object.entries(roles)) {
    if (agent === agentId) return role;
  }
  return null;
}

/**
 * Determine if a CoworkConfig is in solo mode (all roles assigned to one agent,
 * or no roles assigned at all).
 */
export function isSoloMode(config: CoworkConfig): boolean {
  const roles = config.roles;
  const assigned = [roles.lead, roles.build, roles.review].filter(Boolean) as string[];
  if (assigned.length === 0) return true;
  const unique = new Set(assigned);
  return unique.size <= 1;
}

// ──────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ──────────────────────────────────────────────────────────────────────────────

function parseBool(value: string, field: string): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  // YAML also accepts yes/no/on/off.
  if (value === "yes" || value === "on") return true;
  if (value === "no" || value === "off") return false;
  throw new Error(`cowork.yml: ${field} must be a boolean (true/false), got "${value}"`);
}

// ──────────────────────────────────────────────────────────────────────────────
// Default cowork.yml content (used by goalctl cowork init)
// ──────────────────────────────────────────────────────────────────────────────

export const DEFAULT_COWORK_YML = `version: 1
agents:
  claude:
    runner: claude-code
    model: default
  codex:
    runner: codex
    model: default
roles:
  lead:   claude
  build:  codex
  review: claude
relay:
  on_rate_limit:        true
  on_5xx:               true
  small_model_offload:  false   # opt-in
heartbeat_ttl_seconds:  15
`;
