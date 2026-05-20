# Cowork Relay

Cowork is the opt-in path for handing one durable goal between agent runners.
Solo users never create `.goal/cowork.yml` and never need the bridge.

The invariant is simple: the goal record is the coordinator. Runners do not
share memory or a server; they read and write the same local `.goal/` protocol.

## State Layout

```text
.goal/
  goals/<goal_id>.json      per-goal record
  sessions/<session_id>     owner pointer; file content is the goal_id
  locks/<goal_id>.lock      per-goal mutex
  locks/_coord.lock         project coordination mutex
  handoff/NNNN.md           append-only handoff envelopes
  agents/<agent_id>.json    bridge heartbeat
  quota.json                provider headroom
  lanes.json                path-glob leases
  cowork.yml                opt-in role contract
  events.jsonl              append-only diagnostics
  pause                     kill switch
```

Every record write is atomic and protected by the same per-goal lock used by
the MCP server, hooks, `goalctl`, HTTP shim, and bridge. Handoff sequence
allocation uses `_coord.lock` because it is project-wide.

## Start A Peer Bridge

```bash
goalctl cowork init
goalctl bridge start codex --root /path/to/project
goalctl bridge stop codex
```

The bridge binds no sockets. It watches `.goal/goals/`, writes a heartbeat,
spawns the configured runner for each turn, detects rate-limit/server-error
patterns, and updates the goal record under lock.

Codex is driven through NDJSON `codex exec` / `codex exec resume`; Claude Code
normally continues through its Stop hook. Runner patterns live in
[`cowork/bridge/patterns.json`](../cowork/bridge/patterns.json).

## Compatibility Status

The supported Claude Code + Codex path is stable for this repo's current v3
goal layout. Claude Code uses line-mode continuation plus the Stop hook; Codex
uses NDJSON `codex exec --json` and `codex exec resume`.

Compatibility is covered by the local bridge, relay, queued, guardrail, lane,
kill-switch, and bidirectional E2E tests. The account-backed live E2E is:

```bash
GOAL_LIVE_E2E=1 ./cowork/bridge/test/test-live-claude-codex.sh
```

That test intentionally calls both authenticated CLIs and consumes quota.

## Relay Flow

When the active runner hits a rate limit or server error:

1. The bridge writes `.goal/handoff/NNNN.md`.
2. The goal moves to `status: "relaying"` with `current.agent` set to the peer.
3. The peer bridge sees the record change, reads the handoff, and runs a turn.
4. The goal returns to `pursuing` after the peer picks it up.
5. If no configured peer has provider headroom, the goal becomes `queued`.

`paused` is never auto-resumed. `relaying` and `queued` are runtime states that
can return to `pursuing` without user input.

Automatic relay is guarded by `GOAL_RELAY_LIMIT_PER_HOUR` to avoid burning
quota on a persistent fault.

## Handoff Envelopes

The canonical envelope template is
[`cowork/handoff/template.md`](../cowork/handoff/template.md). Envelopes are
append-only markdown files with frontmatter and six required sections:

```text
Did
Did not
Next
Do not redo
Open audit items
Evidence
```

Use the parsers instead of ad hoc text scraping:

```bash
. cowork/handoff/parse.sh
handoff_validate .goal/handoff/0007.md
handoff_parse_field .goal/handoff/0007.md from
handoff_parse_body .goal/handoff/0007.md next
```

```typescript
import { parseHandoff, listHandoffs } from "cowork/handoff/parse.ts";

const handoff = parseHandoff(".goal/handoff/0007.md");
const all = listHandoffs(".goal");
```

`goalctl handoff list` and `goalctl handoff show <seq>` expose the same data.

## Role Contract

`.goal/cowork.yml` declares which runner owns each role:

```yaml
version: 1
agents:
  claude:
    runner: claude-code
  codex:
    runner: codex
roles:
  lead: claude
  build: codex
  review: claude
relay:
  on_rate_limit: true
  on_5xx: true
heartbeat_ttl_seconds: 15
```

If the configured peer is not live, relay queues instead of falling back to an
unrelated runner.

## Configuration

| Var | Default | What |
|---|---|---|
| `GOAL_RELAY_LIMIT_PER_HOUR` | `3` | Max automatic relays before auto-pause. |
| `GOAL_HEARTBEAT_TTL_MS` | `15000` | Stale heartbeat threshold. |
| `GOAL_BRIDGE_PATTERNS` | `cowork/bridge/patterns.json` | Runner fault pattern config. |
| `GOAL_HANDOFF_TEMPLATE` | `cowork/handoff/template.md` | Handoff envelope template. |
| `GOAL_BRIDGE_SPAWN_CODEX` | from patterns | Override Codex spawn command. |

## Observability

Relay, queue, heartbeat, and lane events append to `.goal/events.jsonl`. With
`GOAL_OTEL_ENDPOINT` set, `goal-otel-exporter` exports relay metrics over OTLP.

Useful checks:

```bash
goalctl quota
goalctl lanes
goalctl listen --grep relay
```

## Troubleshooting

**Handoff not picked up.** Check `.goal/agents/<runner>.json`,
`.goal/agents/<runner>.log`, and the goal record's `current.agent`.

**State stuck in `relaying`.** Restart the peer bridge, inspect
`goalctl status --json`, then use `/goal:goal resume` if the state needs manual
recovery.

**Queued indefinitely.** Check `goalctl quota`. If providers are exhausted, wait
for `queued_until` or use `goalctl relay` after headroom returns.

**Bridge exits immediately.** Validate `cowork/bridge/patterns.json` or the path
set by `GOAL_BRIDGE_PATTERNS`.
