# /goal cowork — reference

> The goal is the unit of work; agents are interchangeable runners against a shared protocol.

`/goal` cowork lets two agents — Claude Code and Codex — pursue the same goal sequentially, handing off state through a shared directory. Neither agent is hardcoded as primary. The goal persists across handoffs, rate-limit events, and session restarts. Solo users who never create `cowork.yml` see no behavior change.

---

## Mental model

A `/goal` objective lives in `.goal/state.json`. Any agent that can read that file and write atomically to `.goal/` is a valid runner. When one agent stops (rate limited, budget exhausted, user-directed), it writes a handoff envelope describing what it did and what comes next. The next agent reads the envelope and continues from exactly that point.

This is different from orchestration frameworks that pipeline agents through a coordinator. There is no coordinator here. The goal file is the coordinator. Agents are stateless with respect to each other — they share nothing except the `.goal/` directory.

---

## Agent-neutral state primitives

All cowork state lives under `.goal/` in your project root.

```
.goal/
  state.json          single source of truth (schema v2)
  handoff/
    0001.md           handoff envelopes, monotonic seq
    0002.md
  agents/
    <agent_id>.json   per-agent heartbeat (updated every 5s)
  quota.json          per-provider rate-limit headroom
  cowork.yml          role contract (opt-in, P5)
  lanes.json          path-glob leases (P5)
  pause               touch to halt all agents immediately
```

`state.json` is the authoritative source for current status, current agent, handoff head, and audit checklist. Every write is atomic (`mktemp` + `rename(2)`) and CAS-guarded by `goal_id`. No two writers can interleave updates.

`quota.json` tracks provider headroom independently of the user's token budget. The bridge maintains this file; `goalctl quota` shows the current state.

`agents/<agent_id>.json` is a heartbeat file. Each running bridge writes to it every 5 seconds. The statusline reads these files to show which agents are active vs. idle.

---

## The bridge

The bridge (`bin/goal-bridge`) is the runtime daemon for Codex and other non-Claude-Code agents. Claude Code has its own Stop-hook continuation mechanism; the bridge is the equivalent for agents that lack a hook system.

One bridge per agent session. The bridge:

- Watches `.goal/state.json` for changes (debounced 500ms).
- Writes a heartbeat to `.goal/agents/<id>.json` every 5s.
- For ndjson runners (Codex): spawns a fresh process each turn, feeds it a continuation prompt, reads the NDJSON event stream.
- Detects rate-limit (429) and server-error (5xx) patterns in runner output.
- On fault: writes a handoff envelope and transitions state to `relaying`.
- Honors `.goal/pause` — stops within one tick.

Start the bridge with `goalctl`:

```bash
goalctl bridge start codex --root /path/to/project
```

Stop it:

```bash
goalctl bridge stop codex
```

Or install the command, hooks, and MCP server first:

```bash
./bin/goal-setup --non-interactive
goalctl bridge start codex --root /path/to/project
```

The bridge binds no sockets. All coordination is file-based.

---

## Lifecycle — new states

Solo mode uses five states: `pursuing`, `paused`, `achieved`, `unmet`, `budget-limited`. Cowork adds two runtime states:

| State | Meaning | How you get here | How you leave |
|---|---|---|---|
| `relaying` | Mid-handoff; current agent is the peer | 429/5xx in current agent | Peer completes first turn → `pursuing` |
| `queued` | All configured agents throttled | No peer with headroom | Retry timer fires, headroom restored → `pursuing` |

Only `relaying` and `queued` auto-resume. `paused` never does.

Full transition table:

```
pursuing → relaying     : 429/5xx detected in current agent
relaying → pursuing     : peer picks up (first successful turn)
relaying → queued       : no peer with headroom
queued   → pursuing     : retry timer fires + headroom restored
pursuing → paused       : user /goal pause, or relay guardrail tripped
queued   → pursuing     : auto-resume (no user action required)
```

---

## The relay protocol

When an agent hits a rate limit:

1. The bridge detects the 429 or 5xx pattern in runner output (patterns configurable in `cowork/bridge/patterns.json`).

2. The bridge writes a handoff envelope to `.goal/handoff/NNNN.md` with `reason: rate_limit`. Sequence numbers are zero-padded to 4 digits and monotonic. The file is written atomically.

3. `state.json` is updated atomically: `status: relaying`, `current.agent: <peer>`, `handoff_head: NNNN`.

4. The peer bridge detects the state change (its file watcher fires), reads the handoff envelope, and injects its content into the next continuation prompt.

5. After the peer's first successful turn, `status` returns to `pursuing`.

6. If no peer has headroom (both providers throttled), `status: queued` and `queued_until` is set to `max(quota.providers[*].limit_reset_at)`. Bridges poll with exponential backoff (30s base, 5min cap) and auto-resume when headroom is restored.

If the handoff write itself fails (disk full, permission error), the bridge aborts the relay and transitions to `paused` rather than leaving state in an inconsistent position.

**Guardrail:** more than 3 automatic relays per hour on the same goal triggers auto-pause and a user notification. This prevents a feedback loop from a persistent fault burning through both providers' quota. The limit is configurable via `GOAL_RELAY_LIMIT_PER_HOUR`.

What the user sees during a relay:

```
Relaying claude-code → codex…
```

And after the peer picks up:

```
cowork: codex→build | claude-code=lead idle | 3/8 audited
```

---

## The handoff envelope

Each handoff is a markdown file at `.goal/handoff/NNNN.md`. The canonical shape is defined in [`cowork/handoff/template.md`](../cowork/handoff/template.md).

```markdown
---
seq: 0007
from: claude-code
to: codex
at: 2026-05-11T14:32:00Z
reason: rate_limit
goal_id: <uuid>
---

## Did
- migrated 4/6 files
- tests red on auth/session*

## Did not
- did not touch oauth flow (lane held by review)

## Next
- implement session refresh in src/auth/session.ts
- get auth.session.test.ts to green

## Do not redo
- migration scaffolding (audit a1 passed)

## Open audit items
- a3: pnpm test passes
- a4: no `any` types introduced

## Evidence
- src/auth/session.ts
- tests/auth/session.test.ts (failing: refresh_token)
```

Reason values: `planned | rate_limit | budget_step_down | error | user`.

Envelopes are append-only. They are never modified after write. The `seq` in frontmatter is the canonical ordering; the filename is derived from it.

Both a bash parser (`cowork/handoff/parse.sh`) and a TypeScript parser (`cowork/handoff/parse.ts`) are provided for reading envelopes in shell scripts and Node consumers respectively.

**Bash parser** (sourceable):

```bash
. cowork/handoff/parse.sh
handoff_validate .goal/handoff/0007.md      # exits 0 or non-zero with message
seq=$(handoff_parse_seq .goal/handoff/0007.md)
from=$(handoff_parse_field .goal/handoff/0007.md from)
bullets=$(handoff_parse_body .goal/handoff/0007.md next)
```

**TypeScript parser**:

```typescript
import { parseHandoff, listHandoffs, readHandoffBySeq } from 'cowork/handoff/parse.ts';

const envelope = parseHandoff('.goal/handoff/0007.md');
console.log(envelope.from);   // "claude-code"
console.log(envelope.next);   // string[]

const all = listHandoffs('.goal');   // sorted by seq, returns absolute paths
const env = readHandoffBySeq('.goal', '7');  // pads to "0007"
```

`goalctl handoff list` and `goalctl handoff show <seq>` expose these from the CLI.

---

## Role contract (cowork.yml, opt-in)

The role contract declares which agent plays which role. It is absent by default; its absence means solo mode. A minimal example:

```yaml
# .goal/cowork.yml
version: 1
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
  on_rate_limit: true
  on_5xx:        true
heartbeat_ttl_seconds: 15
```

Role assignments appear in the statusline:

```
cowork: codex→build | claude-code=lead idle | 8/14 audited
```

The bridge parses `cowork.yml` when selecting a peer. If the configured peer runner is not live, the relay stays queued instead of falling back to an unrelated runner. The statusline also uses the role contract so users can see which live agent is leading, building, or reviewing.

For an account-backed smoke test across the installed CLIs, run:

```bash
GOAL_LIVE_E2E=1 ./cowork/bridge/test/test-live-claude-codex.sh
```

That test intentionally calls both Claude Code and Codex, so it is opt-in and should be run only when those CLIs are authenticated and quota is available.

---

## Profile cards

Each agent has a capability card under `cowork/profile/`. These document the interface each agent exposes — useful when writing continuation prompts or debugging handoff gaps.

- [`cowork/profile/claude-code.md`](../cowork/profile/claude-code.md) — Claude Code: surface (CLI + Desktop), session model, edit semantics, tool inventory, failure signals, continuation mechanism.
- [`cowork/profile/codex.md`](../cowork/profile/codex.md) — Codex: surface (CLI), ndjson event stream, session IDs, failure signals, continuation via bridge stdin injection.

Users may add profiles for additional agents. The directory is not enumerated by any tooling in P4.

---

## What stays the same for solo users

- The `/goal` slash command is unchanged.
- State still lives at `.goal/state.json` (migrated from `.claude/goal.json` on first run — see migration path in `CHANGELOG.md`).
- All five v1 lifecycle states work identically.
- The statusline shows the same labels as v1 when `current.agent` is null and `cowork.yml` is absent.
- No new dependencies are required for solo use.
- T8 (the v1 solo regression suite) must pass with no `cowork.yml` present.

---

## Configuration

| Var | Default | What |
|---|---|---|
| `GOAL_RELAY_LIMIT_PER_HOUR` | `3` | Max automatic relays before auto-pause. |
| `GOAL_HEARTBEAT_TTL_MS` | `15000` | Stale heartbeat threshold for agent cleanup. |
| `GOAL_BRIDGE_PATTERNS` | `cowork/bridge/patterns.json` | Override path to runner fault patterns. |
| `GOAL_HANDOFF_TEMPLATE` | `cowork/handoff/template.md` | Override path to handoff envelope template. |
| `GOAL_BRIDGE_SPAWN_CODEX` | (from patterns.json) | Override spawn command for Codex runner. |

---

## Observability

The bridge emits NDJSON events to `.goal/events.jsonl` for each relay, handoff, and queue entry:

```jsonl
{"ts":"...","type":"goal.relayed","goal_id":"...","reason":"rate_limit","from":"...","to":"...","handoff_seq":"0001"}
{"ts":"...","type":"goal.queued","goal_id":"...","queued_until":"...","providers_throttled":"anthropic,openai"}
{"ts":"...","type":"goal.relay.recovery_seconds","goal_id":"...","recovery_seconds":47}
```

With `GOAL_OTEL_ENDPOINT` set, `goal-otel-exporter` ships these as OpenTelemetry counters and histograms (`goal.relayed`, `goal.queued`, `goal.handoff.gap_seconds`, `goal.relay.recovery_seconds`). Without it, they emit to stdout as OTLP/JSON.

---

## Troubleshooting

**Handoff not picked up by peer.** Check `.claude/goal-hook.log` and `.goal/agents/<runner>.log` for `relay-pickup` and `ndjson-loop-start` events from the peer bridge. Verify the peer bridge is running by checking `.goal/agents/<runner>.pid` or restarting it with `goalctl bridge start codex`, and confirm the state file shows `current.agent` equal to the peer's agent_id.

**State stuck in `relaying`.** The peer bridge is not running or crashed. Restart it: `goalctl bridge start codex`. If state is inconsistent, run `goalctl status --json` to inspect, then `/goal resume` to force back to `pursuing`.

**Queued indefinitely.** Check `goalctl quota` for provider headroom. If all providers show `exhausted`, headroom is set heuristically from the last 429 `Retry-After` header. Wait for the `queued_until` timestamp or run `goalctl relay` to manually request a peer handoff.

**Relay guardrail tripped.** More than 3 automatic relays fired in one hour. Check `.goal/relay-log.jsonl` for the relay history. Run `/goal resume` after addressing the underlying fault.

**Bridge exits immediately.** The bridge exits if it cannot read `cowork/bridge/patterns.json`. Verify the path with `GOAL_BRIDGE_PATTERNS` env var and that the file is valid JSON.
