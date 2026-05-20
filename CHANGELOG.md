# Changelog

## Unreleased — compact Stop-hook UX + slash-command hardening

### UX
- `goal-stop.sh` keeps reliable Stop-hook auto-continuation enabled, but
  supports `GOAL_STOP_PROMPT_STYLE=compact` so Claude Code's visible hook row is
  a one-line nudge instead of the full continuation paragraph/spec.
- `bin/goal-setup` now wires the Stop hook with compact prompt style by default.
  `GOAL_STOP_CONTINUE=0` remains available as an accounting-only escape hatch,
  but it is documented as trading away Stop-hook-forced continuation.
- The `/goal` slash command no longer uses a bare `.goal/goals/*.json` glob, so
  an empty v3 goals directory does not trip zsh's `no matches found` failure.
- The slash command can infer the current Claude session id from the newest
  workspace transcript when Claude does not expose the session env var, so a new
  goal binds to `.goal/sessions/<sid>` and appears in the statusline immediately.

### Tests
- Added `scripts/test-goal-md-preamble.sh` to execute the embedded slash-command
  preambles under zsh.
- Added `hooks/test-stop-quiet.sh` to cover accounting-only mode and compact
  one-line continuation blocks.
- Extended `mcp/test/v3-handshake.mjs` to verify explicit `session_id`
  creation still resolves and renders in the statusline when the MCP server env
  has no session id.

## v0.2.3 — cowork relay + HTTP shim join v3

The last two v2 holdouts — `bin/goal-bridge` (the cowork relay daemon) and
`bin/goal-http-server.ts` (the loopback HTTP shim) — are now on the v3
session-scoped layout. Multi-agent flows (Claude Code ↔ Codex) and IDE
plugins / external dashboards reading goal state over HTTP all drive the
same per-goal records, per-goal locks, and session pointers the MCP /
hooks / goalctl already do.

### `bin/goal-bridge`
- **v3 layout**: reads per-goal records at `.goal/goals/<gid>.json`, takes
  per-goal locks at `.goal/locks/<gid>.lock` for record RMW, and the
  project-coordination lock at `.goal/locks/_coord.lock` for handoff seq
  mint / relay-state transitions. Same paths the MCP and bash hooks use —
  three runtimes serialize against each other correctly.
- **Goal resolution by agent_id**: the bridge tracks its currently-driven
  gid as session state and re-resolves on every state change. Scans
  `.goal/goals/` for a record whose `current.agent === AGENT_ID` (matches
  v2 semantics; v3 just looks in many records instead of one). Logs a
  `multi-match` warning + picks the most-recently-updated record if more
  than one names the agent (cowork is sequential by design; this
  shouldn't normally happen).
- **Watcher** now targets `.goal/goals/` directory instead of the single
  `state.json` file. fs.watch debouncing + 500ms polling fallback
  unchanged. Same trick the MCP server uses for the channel push manager.
- **v2 → v3 forward migration** at bridge startup: atomic-renames
  `.goal/state.json` → `.goal/goals/<gid>.json`, emits `goal.migrated` to
  events.jsonl, leaves the record unowned (RFC §5). Coordinated with the
  MCP / goalctl migrators via the project-coord lock so concurrent
  startups don't race.
- **Handoff envelope writer** stamps the gid in the frontmatter
  (`goal_id:` line) from `state.goal_id`; the fallback bullets now point
  at `.goal/goals/<gid>.json` instead of `state.json`.

### `bin/goal-http-server.ts`
- **Per-goal resolution per request**: the goal a request operates on is
  picked via a 3-tier lookup that mirrors the MCP server's
  `resolveGoalForSession`:
  1. `?goal=<gid>` query param
  2. `X-Claude-Session-Id` (or `X-Goal-Session-Id`) header → session pointer
  3. Single non-terminal goal in the project (single-active)
  Ambiguity (two active goals, no flag/header) returns `409 goal_ambiguous`.
- **`POST /goal`** with `X-Claude-Session-Id` writes both the record AND
  the session pointer. Without a session header, falls back to refusing
  if any active goal already exists (so a non-session caller can't create
  a duplicate it'd never resolve).
- **`PATCH /goal`** + **`GET /goal`** resolve via the 3-tier lookup.
  `PATCH .../clear` removes the record, the matching session pointers,
  and the per-goal lock dir.
- **New `GET /goals`** — list all goals in the project (returns
  `{goals: [{goal_id, status, objective, updated_at}, ...]}`). Counterpart
  of `goalctl list`.
- **Locks**: `PATCH` takes the per-goal lock at `.goal/locks/<gid>.lock`;
  `POST /goal` takes the project-coord lock at `.goal/locks/_coord.lock`.
  Both via proper-lockfile on the same paths the MCP server uses.
- **v1 → v2 → v3 forward migration** at server boot (idempotent, matches
  the MCP / goalctl byte-for-byte).

### Live-verified
- HTTP server end-to-end: GET/POST/PATCH `/goal` and `GET /goals` against
  v3 records, session-pointer resolution, duplicate detection (409),
  pause/resume/clear, 404 post-clear. All routes return the expected
  status codes.
- Bridge startup: agent_id derivation correct, watcher attaches to
  `.goal/goals/`, polling fallback installs, heartbeat written, "no goal
  assigned to me" path logs cleanly.
- Existing v3 test suites (`mcp/test/{smoke,v3-handshake,channel-smoke}.mjs`,
  `scripts/smoke-concurrency.sh`) — all still pass after these changes.

### Notes
- The bridge's existing event surface (`goal.relayed`,
  `goal.relay.guardrail_tripped`, `goal.queued`,
  `goal.handoff.peer_picked_up`, `goal.relay.recovery_seconds`,
  `goal.relay.resumed_from_queue`) is preserved verbatim. v3 only changes
  on-disk locations, not the event schema.
- The HTTP server's existing event surface (`goal.created`, `goal.paused`,
  `goal.resumed`, `goal.budget_changed`, `goal.cleared`,
  `goal.needs_input`) is preserved; `goal.created` now also includes
  `owner_session_id` when a session header was sent.
- **All known v2 → v3 migration paths in the repo are now wired.** The
  five entry points that touch goal state — MCP, hooks (Stop/prompt/notify),
  slash command, `goalctl`, `goal-bridge`, `goal-http-server.ts` — read
  and write the same `.goal/goals/<gid>.json` records under the same
  per-goal locks. A v2 `.goal/state.json` left by an earlier install is
  forward-migrated on first touch by whichever entry point runs first.

---

## v0.2.2 — goalctl, goal-lock, and the concurrency smoke join v3

The previous release left three holdouts on the v2 on-disk shape: `bin/goalctl`,
`hooks/goal-lock.sh`, and `scripts/smoke-concurrency.sh`. They didn't collide
with v3 (different lock paths) but they didn't drive v3 semantics either —
goalctl wrote a single `.goal/state.json` per project, ignored session
ownership, and exposed a `mark-unmet` route the v3 lifecycle no longer has.

This release closes the gap.

### `bin/goalctl`
- **v3 layout**: writes records at `.goal/goals/<gid>.json` and session pointers
  at `.goal/sessions/<sid>`. The `.goal/state.json` path is gone; a stale one
  is forward-migrated on first touch (goalctl emits `goal.migrated` to
  `events.jsonl`, matching the MCP server).
- **Session-owned resolution** for every subcommand: `--goal <gid>` /
  `--session <sid>` flags override; `CLAUDE_SESSION_ID` / `GOAL_SESSION_ID`
  env vars are honored; otherwise falls back to the project's single
  non-terminal goal. Ambiguity (two active, no flags/env) is rejected with a
  clear error rather than picking one silently.
- **New `goalctl adopt <gid>`** — binds the calling session to an existing
  unowned goal (e.g. after v2→v3 migration, or `/clear`, or to deliberately
  join another session's goal). Counterpart to the slash command's create
  flow.
- **New `goalctl list`** — one line per goal in the project (`--json` for
  machine output). Replaces grepping `.goal/goals/` by hand.
- **`mark-unmet` removed.** v3 has no failed state for the model to reach;
  the command now refuses with the v3 guidance (`needs-input` parks
  automatically; only the user clears).
- **Per-goal locks**: every RMW takes `.goal/locks/<gid>.lock`; `create`,
  `replace`, and `lanes release` take the project-coord lock at
  `.goal/locks/_coord.lock`. Same paths the MCP server (proper-lockfile) and
  the bash hooks (inline `mkdir` mutex) use, so all three runtimes serialize
  against each other correctly.
- **`clear` is per-goal**: removes the record + the session pointer +
  per-goal lock/cursor. The `.goal/` tree, other goals, `events.jsonl`, and
  lanes stay intact.
- **`bin/goal-v3`** (the Node helper backing `goalctl watch / history /
  debrief / pr / sync / backlog / template / notifier`) now resolves the goal
  record via the v3 lookup (session pointer → single-active → legacy
  `state.json` last-resort), so watch/history/debrief work against v3
  records without changes to the user-visible UX.

### `hooks/goal-lock.sh`
- Reduced to a **generic `mkdir`-based mutex**. Signature:
  `goal_lock_acquire <lockdir> [timeout_ms] [stale_ms]`. v3 callers pass the
  explicit path (`.goal/locks/<gid>.lock` for per-goal, `.goal/locks/_coord.lock`
  for project-coord). The v2 path-picking logic (`.goal/lock` vs
  `.claude/goal.lock`) is removed — callers know what to lock.
- The v3 hooks (`goal-stop.sh`, `goal-prompt.sh`, `goal-notify.sh`) continue
  to inline this pattern; the helper still exists for `goalctl` and for any
  external script that wants a portable mutex.

### `scripts/smoke-concurrency.sh`
- Rebuilt for the v3 signature: steps 1 and 2 exercise the per-goal lock
  primitive; steps 3 and 4 drive `goalctl --session <sid>` so two parallel
  sessions create two independent goals under per-goal locks; step 5
  (events.jsonl append atomicity) is unchanged. **All 5 steps green** on
  current main.

### Test suite status (this release)
- `mcp/test/smoke.mjs`, `mcp/test/v3-handshake.mjs`, `mcp/test/channel-smoke.mjs`,
  `scripts/smoke-concurrency.sh` — all green.
- `bash -n` clean on every script in `hooks/`, `bin/goalctl`, and `scripts/`.

### Notes (carried from v0.2.1)
- `bin/goal-bridge` and `bin/goal-http-server.ts` still reference
  `.goal/state.json` directly. They sit on the cowork relay path and are not
  exercised by the statusline / Stop-hook loop the previous release fixed.
  A follow-up migrates them to the v3 layout — leaving them in this release
  keeps the multi-agent relay working as before during cutover.

---

## v0.2.1 — MCP server completes the v3 cutover (statusline fix)

The v3 PR (`feat/v3-session-scoped-goals`) rewrote the hooks for session-scoped
ownership but the MCP server kept writing the v2 layout — one `.goal/state.json`
per project. Result: every `/goal` created a record the resolver could never
find, so the statusline cockpit was permanently blank, the Stop-hook
continuation loop never resumed, and the latent `goal-prompt.sh`/`goal-notify.sh`
calls to the non-existent `resolve_goal` symbol aborted silently on `set -e`.

### Fixed
- **MCP `mcp/goal-server.ts`** now writes the v3 layout:
  - per-goal records at `.goal/goals/<goal_id>.json`
  - per-session pointer files at `.goal/sessions/<session_id>` (text content = the gid)
  - per-goal `mkdir` mutex at `.goal/locks/<goal_id>.lock` (matches the bash hooks)
  - cross-goal coordination lock at `.goal/locks/_coord.lock` (lanes, handoff seq, breadcrumbs)
- `create_goal` reads `CLAUDE_SESSION_ID` (falls back to `GOAL_SESSION_ID`),
  writes both the record and the pointer in one tool call, and rejects a
  second active goal for the same session.
- `get_goal` / `update_goal` / all coordination tools resolve via the session
  pointer; a session without a pointer is resolved to the project's unique
  active goal if there's exactly one (no auto-bind on read).
- **v2 → v3 forward migration**: legacy `.goal/state.json` files are moved to
  `.goal/goals/<gid>.json` on first MCP touch, then deleted. The migrating
  record stays **unowned** (RFC §5) — the next `/goal` or `/goal adopt` binds.
- `hooks/goal-prompt.sh` and `hooks/goal-notify.sh` rewritten to use the v3
  resolver (`goal_resolve_owned`). `set -u` only (matching the v3 Stop hook),
  per-goal mkdir mutex inline. No more dependency on the project-level
  `goal-lock.sh` shim — every v3 hook serializes on the same `.goal/locks/<gid>.lock`.

### Tests
- `mcp/test/smoke.mjs` updated to assert the v3 layout (`goals/<gid>.json` and
  `sessions/<sid>` pointer); has an explicit regression guard that `state.json`
  must **not** exist after a v3 create.
- **New: `mcp/test/v3-handshake.mjs`** — end-to-end MCP-write → bash-resolver-read
  round trip. Asserts that `goal_resolve_owned` returns the same gid the MCP
  just minted, that a stranger session renders no statusline segment, that the
  v2→v3 migration runs idempotently and never auto-binds, and that two sessions
  in the same folder produce two independent goals. **This is the test that
  would have caught the original bug.**

### Notes
- `bin/goalctl` and `scripts/smoke-concurrency.sh` still operate on the v2
  `.goal/state.json` and the project-wide `.goal/lock` directory; they do not
  collide with v3 paths (`.goal/goals/`, `.goal/sessions/`, `.goal/locks/`) but
  they don't yet drive v3 semantics. A follow-up migrates them.

---

## v0.2.0 — Codex-faithful goal lifecycle

A `/goal` that is stable, reliable, token-efficient, and never silently lost.
Verified against Claude Code 2.1.143 and the open-source Codex implementation.

### Architecture
- **No LLM evaluator.** Continuation is a deterministic Stop-hook dispatcher;
  completion is the working model auditing itself via the `overclaim` skill and
  calling MCP `update_goal` (complete-only). Mirrors Codex `core/src/goals.rs` —
  Claude Code's native `/goal` uses a Haiku evaluator; this does not.
- **Session-owned goals.** Goals resolve by session ownership, read-only — fixes
  concurrent goals clobbering each other (Bug 1) and fresh sessions inheriting a
  stale status line (Bug 3).
- **No model-set failure.** The model can reach `achieved` only through the
  `overclaim` audit; a stuck goal parks to resumable `needs-input`, never
  `unmet`. `unmet` is removed everywhere.

### Reliability
- Hardened Stop hook: `set -u` only, `exec 2>/dev/null`, per-goal locks — a
  hook fire emits zero stderr, so the "hook error" notices are gone (Bug 4).
- Removed the `goal-ticker` daemon: it wrote to `/dev/tty`, which Claude Code
  hooks lost in v2.1.139. The live timer now uses `statusLine.refreshInterval`.
- Plugin hooks moved to `hooks/hooks.json` per the current plugin spec.

### Token efficiency
- Continuation drives the loop by reference: a ~35-token prompt citing the
  persisted spec, with a full re-paste only on context-loss signals (first
  fire, every 25 ticks, re-orientation). v2 re-pasted the full objective every
  turn.

### Per-goal token + cost tracking
- The Stop hook now accounts each turn's full token `usage` and Claude Code's
  own per-turn `costUSD` (cache- and model-aware) — verified present in the
  CC 2.1.143 transcript. The plugin maintains no price table: the cost figure
  is CC's own, so it cannot drift. If `costUSD` is unavailable, cost stays 0
  and only tokens are reported — never guessed.
- Monotonic delta accounting: the baseline lives inside the goal record
  (`.accounting`), written atomically with the counters. `tokens_used` and
  `cost_usd` only ever rise; a transcript/session swap re-baselines safely
  (at worst a one-fire undercount, never a backward jump). The first fire
  baselines, so pre-goal conversation in the same session is excluded.
  Fixes a v2 bug where a lost side-file baseline reset `tokens_used` to 0.
- `tokens_used` is now fresh input + cache-write + output (was output-only),
  so a token budget caps real consumption, not just visible output.
- `cost_usd` / `cost_usd_final` freeze on `achieved` / `budget-limited`.
- The status line shows the goal's notional cost (`≈$…`) across every state,
  labelled approximate; it is API-equivalent for subscription users, not a bill.

### UX
- New cockpit status line: state-driven glyph + colour, evidence meter, live
  timer. Renders only for the owning session; terminal states do not stick.
  Interactive mockup: `docs/goal-statusline-cockpit.html`.

### Added earlier in this line
- `goalframe` skill — structures a raw objective into a verifiable spec.
- `overclaim` skill — evidence audit; the only path to `achieved`.


All notable changes to the `/goal` plugin are documented here.  
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [Unreleased] — v2 Schema + Migration (Phase 1)

### What changed

#### State directory renamed: `.claude/` → `.goal/`

The runtime state file moves from `.claude/goal.json` to `.goal/state.json`.
The lock moves from `.claude/goal.lock` to `.goal/lock` (same mkdir-mutex
semantics; just a different path post-migration).

Migration is **automatic and one-way** — it fires on the first read by any
v2-aware surface (MCP server, hooks, goalctl, HTTP shim). It is atomic: a temp
file is written and renamed into place before `.goal/` is exposed to other
readers. If migration fails for any reason the error is logged loudly to
`.claude/goal-hook.log` and the original v1 file is left untouched.

#### Schema bumped to `schema_version: 2`

`state.json` gains several additive fields (all optional on v1 reads):

| Field | Purpose |
|-------|---------|
| `schema_version` | Always `2` for v2 files. |
| `compat` | Agent runner IDs that may participate (`["claude-code"]` for solo goals). |
| `roles` | Role assignments for cowork mode (P5+). Null in solo mode. |
| `current` | Which agent is currently active. Null in solo mode. |
| `budget` | Structured budget (supplements the existing `token_budget` field). |
| `lineage` | Per-agent session records. `lineage[0]` is synthesized at migration. |
| `audit` | Optional checklist for deliverable tracking. |
| `handoff_head` | Most recent handoff envelope sequence number (P4+). |
| `queued_until` | Retry timestamp when `status === "queued"` (P3+). |

Two new `status` values are accepted on read: `relaying` and `queued`. These
are runtime-only states introduced in P3 (rate-limit relay). Solo mode never
enters these states.

#### JSON Schema reference

`docs/schema/state.v2.json` — JSON Schema (draft 2020-12) describing the full
v2 state shape. This is documentation and a future tooling reference; runtime
validation is hand-rolled in `mcp/goal-server.ts` (`validateStateV2`).

#### Backward compatibility

- **v1 users see no behavior change.** The migration is transparent and
  automatic. Solo-mode statusline, continuation prompts, and budget tracking
  are byte-identical before and after.
- `.claude/goal.json` is **left in place** after migration for one minor
  version (v2.1 will delete it). This means tools that read the file directly
  still work during the transition window.
- `GOAL_DISABLE_MIGRATION=1` — set this env var to skip migration entirely.
  When set, all readers use the v1 path (`.claude/goal.json`) unchanged. This
  is the escape hatch for users who cannot migrate yet.

### What stays compat

- The `/goal` slash command name is unchanged.
- `goalctl create`, `get`, `status`, `pause`, `resume`, `clear`, `set-budget`,
  `mark-achieved`, `listen`, and `serve-http` all continue to
  work identically. v2 writes include the extra fields; v1 reads still succeed
  because jq filters tolerate unknown fields.
- The three MCP tools (`create_goal`, `update_goal`, `get_goal`) keep their
  input/output shapes. The returned object includes v2 fields when the
  underlying file is v2.
- `goal-stop.sh` (Stop hook), `goal-statusline.sh`, and `goal-lock.sh`
  continue to work for solo Claude Code users with no change to observable
  behavior.

### Deprecation timeline

| Version | Action |
|---------|--------|
| v2.0 (this) | `.claude/goal.json` left in place; `.goal/state.json` is canonical. |
| v2.1 | `.claude/goal.json` deleted after successful migration. |

### Migration details

On the first v2 read for a given project root:

1. If `.goal/` already exists → no-op.
2. If `.claude/goal.json` exists and `.goal/` does not → acquire
   `.claude/goal.lock`, build v2 state from v1 fields, write
   `.goal/state.json`, move lock to `.goal/lock`, write
   `.claude/MIGRATED_TO_GOAL` timestamp marker.
3. All future reads and writes go to `.goal/state.json`.

`lineage[0]` is synthesized at migration time:
- `agent: "claude-code"` — the only runner that could have created a v1 goal.
- `model: "unknown"` — not available in v1 state.
- `started_at` = `created_at` from v1.
- `ended_at` = null if `status` is `pursuing` or `paused`; else `updated_at`.
- `turns` = `tick_count` from v1.
- `tokens` = `tokens_used` from v1.
- `summary: "migrated from v1"`.

### Audit items closed by this phase

| Item | Evidence |
|------|---------|
| a1 | `.goal/` created on first read; verified by `scripts/smoke-phase-1-migration.sh`. |
| a2 | `docs/schema/state.v2.json` + `validateStateV2()` in `mcp/goal-server.ts`. |
| a3 | `scripts/smoke-phase-1.sh` passes unchanged with `GOAL_DISABLE_MIGRATION=1`. |
| a16 | This CHANGELOG section. |
| a17 | `mcp/package.json` `dependencies` unchanged (no new runtime deps). |

---

## [0.1.x] — v1 (previous releases)

See git log for details. Initial release with `.claude/goal.json` state,
three MCP tools, Stop hook, statusline, goalctl, and HTTP shim.
