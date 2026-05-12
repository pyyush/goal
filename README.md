<p align="center">
  <img src="docs/banner.svg" alt="goal — persistent objectives for Claude Code" width="100%">
</p>

<p align="center">
  A <a href="https://code.claude.com/docs/en/plugins">Claude Code plugin</a> that bundles a <code>/goal</code> slash command, lifecycle hooks, an MCP server with a push channel, and a statusline indicator — so the model keeps pursuing a long objective across turns until it audits as done, hits its budget, or gets paused.
</p>

---

## v2: cowork

`/goal` v2 adds multi-agent cowork: multiple agents (Claude Code, Codex) can pursue the same goal sequentially, with state stored in a shared `.goal/` directory that any agent can read and continue from. The goal is the unit of work; agents are interchangeable runners against a shared protocol. A v1 solo user sees no behavior change — cowork is opt-in via a `cowork.yml` file.

Cowork survives rate limits automatically. When one agent hits a 429 or 5xx error, the bridge writes a handoff envelope to `.goal/handoff/NNNN.md`, transitions state to `relaying`, and the peer agent picks up from exactly where the first left off. If all configured agents are throttled simultaneously, state transitions to `queued` with a `retry_at` timestamp. Normal pursuit resumes automatically once headroom is restored. A relay guardrail caps automatic handoffs at 3 per hour; beyond that the goal auto-pauses and notifies the user.

See [`docs/cowork.md`](docs/cowork.md) for the full protocol, lifecycle, and configuration reference.

---

## How this relates to Claude Code's built-in `/goal`

Claude Code now ships an official [`/goal`](https://code.claude.com/docs/en/goal) command. Use the built-in command first when you want one Claude Code session to keep working until a condition is met. This repo is the persistence, control, and cowork layer for teams that need the goal to outlive one session and move between runners.

| Capability | Claude Code built-in `/goal` | This repo |
|---|---|---|
| Scope | Session-scoped; one active goal per session. `/clear` removes an active goal, and `--resume` restores the condition with fresh turn/time/token baselines. | Project-scoped state in `.goal/state.json`; survives `/clear`, compaction, session restarts, and multiple Claude Code windows. |
| Completion check | A small fast evaluator model checks the conversation after each turn. It does not run tools or inspect files independently. | Audit-gated completion with explicit evidence, MCP progress tools, status history, and terminal states for `achieved`, `unmet`, `paused`, and `budget-limited`. |
| Control surface | `/goal <condition>`, `/goal`, `/goal clear`, non-interactive `claude -p "/goal ..."` support. | Slash command plus `goalctl`, loopback HTTP, MCP tools, push channel, statusline, templates, debriefs, and git-backed state sync. |
| Rate limits | Stays within the current Claude Code provider/session. | Cowork can relay on 429/5xx between Claude Code and Codex, queue when both providers are throttled, and resume when headroom returns. |
| Best fit | Simple single-session autonomous work with a clear transcript-verifiable condition. | Long-running project work, public release checklists, CI/scheduled control, multi-session coordination, and Claude ↔ Codex handoffs. |

The naming overlap is intentional historical continuity, not a claim to replace Anthropic's implementation. For single-session Claude automation, the official command is the most direct path. Install this repo when you need durable project state, richer controls, or cross-agent cowork. In scopes where this plugin is enabled, `/goal` is this project-scoped implementation; disable the plugin in that scope to use Claude Code's built-in command there.

---

## What you get

- **`/goal <objective>`** — set a durable goal. State persists at `.goal/state.json` across `/clear`, `/compact`, `--resume`, and session restarts.
- **Auto-continuation** — a `Stop` hook returns `{decision:"block"}` after each turn while the goal is `pursuing`. The loop shape matches Claude Code's built-in `/goal`, with explicit lifecycle states and durable project state layered on top.
- **Push channel** — the bundled MCP server declares the `claude/channel` capability and pushes short "keep working" messages into idle sessions, so unattended runs don't stall.
- **Token budget that bites** — the hook reads the session transcript, deltas output tokens against a per-goal baseline, and flips status to `budget-limited` with a wrap-up steering message when the budget is hit.
- **Audit-gated completion** — the model can only declare `achieved` after a prompt-to-artifact checklist clears. No false positives from "I implemented it" intuition.
- **Concurrent-session safe** — all four writers (slash command, hooks, MCP server, `goalctl`) coordinate through a single mutex at `.goal/lock`.
- **v3 harness surfaces** — live statusline timing, `goalctl watch`, scoped progress tools, breadcrumbs, history/debriefs, templates, backlog, PR scaffolding, notifications, webhooks, and git-based state sync.
- **CLI + Desktop** — both surfaces read the same `~/.claude.json`, so one install covers both.

## Install

Paste this to Claude Code / Cursor / any coding agent — or run it in a terminal:

```bash
git clone https://github.com/pyyush/goal ~/goal && cd ~/goal && ./bin/goal-setup --non-interactive
```

That clones the repo, installs the hooks, builds the MCP server, and patches `~/.claude.json` in one shot. Then **restart Claude Code** (CLI or quit-and-reopen Desktop) so the hooks and MCP server register.

<details>
<summary>Manual install (interactive prompts)</summary>

```bash
git clone https://github.com/pyyush/goal
cd goal
./bin/goal-setup            # interactive — prompts for scope, MCP server, statusline
# or: ./install.sh user     # minimal: hooks only, no MCP server, no statusline
```

`goal-setup` flags: `--dry-run` (preview), `--non-interactive` (accept defaults), `--scope user|project`.

</details>

## Quickstart

```text
/goal Refactor the auth module to use the new session API; run tests until green
```

The model now keeps working on this across every turn until it can audit it as `achieved`, declares `unmet`, or you intervene with `/goal pause` / `/goal clear`.

## Commands

```text
/goal <objective>          set or replace the active goal
/goal                      show 1-line status (the Stop hook handles continuation)
/goal status               full status, never continues
/goal pause | resume       pause / unpause the auto-continuation loop
/goal achieved             mark complete — runs the audit first, refuses on a fail
/goal unmet [note]         mark blocked
/goal budget <N>           set a positive-integer token budget
/goal clear                delete the goal
```

Subcommands are case-insensitive on the first token. Anything else is treated as a new objective.

## Architecture

<p align="center">
  <img src="docs/architecture.png" alt="goal architecture — writers sharing .goal/state.json under a lock" width="100%">
</p>

`.goal/state.json` is the single source of truth. All four writers — the slash command, the hooks, the MCP server, and the headless `goalctl` / HTTP shim — coordinate through a `proper-lockfile`-compatible mkdir mutex at `.goal/lock`. Each write is atomic (`mktemp` + `rename(2)`) and CAS-guarded by `goal_id`, so a write from a stale view is rejected even if the lock somehow leaks.

## Lifecycle

<p align="center">
  <img src="docs/lifecycle.png" alt="goal lifecycle — pursuing, paused, achieved, unmet, budget-limited" width="100%">
</p>

A goal lives in one of five states. Transitions are user-initiated (`pause` / `resume` / `clear` / `unmet`), model-initiated (only `achieved`, and only after an audit), or runtime-driven (`budget-limited` when `tokens_used ≥ token_budget`). The MCP `update_goal` tool is deliberately asymmetric — the model cannot pause, resume, or modify its own budget. Those are user / orchestrator decisions.

## Concurrency

Run multiple Claude Code sessions on the same project — CLI + Desktop side by side, two CLI sessions in different terminals — and `goal` stays consistent. Tunables: `GOAL_LOCK_TIMEOUT_MS` (default 5000), `GOAL_LOCK_STALE_MS` (default 30000). A stuck lock auto-recovers when the owning PID is gone or the hold exceeds the stale threshold.

A concurrency stress test ships at [`scripts/smoke-phase-1.sh`](scripts/smoke-phase-1.sh) — 20 parallel atomic increments serialize to 20 with the lock; without it 18 of 20 updates are lost.

## Headless / SDK drive (`goalctl`)

For CI, scheduled jobs, IDE plugins, multi-agent orchestrators:

```bash
goalctl create "Ship the migration" --budget 5000
goalctl status --json | jq '.remaining_tokens'
goalctl pause / resume / clear
goalctl set-budget 10000
goalctl mark-unmet "blocked on review"
goalctl listen --grep created          # tail .goal/events.jsonl
goalctl serve-http --port 7474         # local HTTP RPC (127.0.0.1 only)
goalctl watch                          # read-only live dashboard
goalctl template list
goalctl pr --json                      # scaffold PR title/body/labels; no push
goalctl sync push / sync pull          # sync .goal via goal-state branch
```

The HTTP shim exposes `GET / POST / PATCH /goal` and `GET /events?since=<iso>` (NDJSON stream). No auth — loopback bind only. See [`bin/goal-http-server.ts`](bin/goal-http-server.ts) for the full surface.

## MCP server (native tools + push channel)

The MCP server in [`mcp/`](mcp/README.md) exposes native tools the model calls as structured tool uses:

| Tool | Behavior |
|---|---|
| `mcp__goal__create_goal` | Create a goal. Fails if one is already active. |
| `mcp__goal__update_goal` | Mark complete. Asymmetric: only `status: "complete"` is accepted. |
| `mcp__goal__get_goal` | Return current state + computed `remaining_tokens` and `elapsed_seconds`. |
| `mcp__goal__report_progress` | Mark one audit item passed/failed with evidence. |
| `mcp__goal__report_stuck` | Escalate a stuck audit item; repeated attempts pause the goal. |
| `mcp__goal__record_breadcrumb` | Append an approach/outcome breadcrumb and refresh the preamble. |
| `mcp__goal__queue_message` / `mcp__goal__steer_message` | Route queued and mid-turn session messages. |

The same server declares the `claude/channel` capability with channel id `goal/continue`. It pushes a short *"continue working — call `get_goal()` if you need the objective"* message into the session at boot, after `.goal/state.json` mtime bumps (debounced against the Stop hook), and optionally on a timer (`GOAL_PUSH_INTERVAL_SECONDS=N`). This is what closes the *idle continuation* gap: when the model has finished a turn and no Stop hook has fired in a while, the channel re-engages it.

Channel kill switches: `touch .goal/pause`, `GOAL_CHANNEL_DISABLE=1`, status not `pursuing`, budget exhausted, or any active ceiling. Every push outcome is logged to `.goal/events.jsonl` for audit.

## Statusline

Adds one magenta segment to your statusline, showing the live goal state:

| State | Label |
|---|---|
| `pursuing` (no budget) | `Pursuing goal (5m)` |
| `pursuing` (with budget) | `Pursuing goal (12.5K / 50K)` |
| `paused` | `Goal paused (/goal resume)` |
| `achieved` | `Goal achieved (1h 23m)` |
| `unmet` | `Goal unmet (/goal status)` |
| `budget-limited` | `Goal abandoned (50K / 50K)` |

Cowork modes (when `cowork.yml` present or `current.agent` set):

| State | Label |
|---|---|
| `pursuing` (cowork-active) | `cowork: codex→build \| claude=review idle \| 8/14 audited` |
| `relaying` | `Relaying claude-code → codex…` |
| `queued` | `Queued — retry at 14:47 (anthropic + openai throttled)` |

The timer reflects **active pursuit time** — paused intervals are excluded, not wall-clock from when the goal was set. `goal-setup` wires it for you. `GOAL_STATUSLINE_STYLE=dim|plain` for softer / monochrome.

For v3 goals, the statusline uses the baseline+delta live-time fields in `state.json`, shows final time/token snapshots after terminal transitions, displays heartbeat freshness, and marks stale token observations with `*`.

## Configuration

| Var | Default | What |
|---|---|---|
| `GOAL_MAX_TICKS` | `0` (unlimited) | Hard cap on continuation cycles. |
| `GOAL_MAX_SECONDS` | `0` (unlimited) | Wall-clock cap. Useful for API-billed runs. |
| `GOAL_AUTOPAUSE_ON_PROMPT` | `0` | Set to `1` to pause on every user prompt. |
| `GOAL_PUSH_INTERVAL_SECONDS` | unset | Channel timer push, off by default. |
| `GOAL_CHANNEL_DISABLE` | `0` | Set to `1` to disable just the push channel. |
| `GOAL_CHANNEL_DEBOUNCE_MS` | `5000` | Channel skip-window after a Stop-hook tick. |
| `GOAL_LOCK_TIMEOUT_MS` | `5000` | Mutex acquire timeout. |
| `GOAL_LOCK_STALE_MS` | `30000` | Stale-lock takeover threshold. |
| `GOAL_OTEL_ENDPOINT` | unset | When set, `goal-otel-exporter` ships metrics to this OTLP HTTP endpoint. |

## Safety

- **`<untrusted_objective>` framing.** The objective is wrapped in nonce-tagged tags so a malicious goal can't smuggle higher-priority instructions. The model is explicitly told to treat the objective as data.
- **Audit-gated `achieved`.** Every claim of completion forces a prompt-to-artifact checklist before the goal flips to terminal-success.
- **Asymmetric model tool.** `update_goal` only accepts `complete`. The model cannot pause, resume, mark-unmet, or modify its own budget.
- **Kill switch.** `touch .goal/pause` halts the loop instantly from any terminal — no chat access required.
- **Auto-pause on errors.** A `Notification` hook detects rate-limit / 5xx / overload / auth / timeout patterns and pauses the goal so it doesn't burn ticks against a degraded API.
- **Local-only headless surfaces.** `goalctl serve-http` binds `127.0.0.1` only.

## Observability

`goal-otel-exporter` tails `.goal/events.jsonl` and emits OpenTelemetry counters (`goal.created`, `goal.completed`, `goal.unmet`, `goal.budget_limited`) and histograms (`goal.token_count`, `goal.continuation_turns`, `goal.elapsed_seconds`), all keyed by `goal_id`. Without `GOAL_OTEL_ENDPOINT` set it emits OTLP/JSON to stdout for piping.

## Troubleshooting

**Loop isn't firing.** Check `jq '.hooks.Stop' ~/.claude/settings.json` — should reference `goal-stop.sh`. Restart Claude Code after install.

**Status line missing.** `~/.claude/hooks/goal-statusline.sh` must be executable and your statusLine command must pass `cwd` + `session_id` from its stdin JSON. The bundled statusline (`statusline.sh`) handles both.

**Goal stuck after rate-limit.** In cowork mode, rate limits relay to a peer or enter `queued` until provider headroom returns. In solo Claude Code mode, run `/goal resume` after the provider recovers.

**Hook fires but nothing happens.** `tail -f .claude/goal-hook.log`. Common: `recursion-guard` (inside a continuation chain — normal), `not-pursuing` (intended exit), `malformed` (`/goal clear` and start over).

## Requirements

- macOS or Linux (Windows via WSL)
- `bash` 3.2+, `jq`, `uuidgen`
- Node 18+ (for the MCP server and HTTP shim — optional but recommended)

## License

[MIT](LICENSE)
