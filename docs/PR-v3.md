# A stable, Codex-faithful `/goal`

Branch: `feat/v3-session-scoped-goals` — 5 commits, +2470 / -1740 across 30 files.

## Why

`/goal` had four field bugs: concurrent goals in one folder clobbered each
other; runs went idle or self-marked `unmet`; fresh sessions showed a stale
goal status line; Stop-hook errors were noisy. They are not architecture
problems — they are defects in an architecture that was already right.

To confirm that, this work verified the design against the open-source Codex
implementation (`openai/codex`, `core/src/goals.rs`) and against Claude Code
2.1.143. The headline finding:

**Codex uses no LLM to evaluate goal completion, and neither should we.**
Continuation in Codex is a deterministic dispatcher. Completion is the working
model auditing itself and calling `update_goal` — a tool hard-restricted to
`complete` only. The anti-overclaim discipline lives in the continuation
prompt. Claude Code's *native* `/goal` uses a Haiku evaluator because it is a
thin wrapper over a generic prompt-based Stop hook; that is the design this
plugin deliberately does not copy. This plugin stays plugin-based and
Codex-shaped.

## What changed

**Architecture — no evaluator, no model-set failure**
- Continuation is a deterministic Stop-hook dispatcher driven by *observed
  progress* (tool-call count + worktree hash), never a blind re-block and never
  a model verdict.
- Completion is reachable only through the `overclaim` audit skill. The model
  cannot mark a goal failed; a stuck goal parks to resumable `needs-input`.
  `unmet` is removed from the model's vocabulary and from every render path.

**Reliability**
- Session-owned goal resolution (`goal-resolve.sh`), read-only — fixes
  concurrent-goal clobbering (Bug 1) and the stale-status-line inheritance
  (Bug 3).
- Hardened Stop hook (`goal-stop.sh`): `set -u` only, `exec 2>/dev/null`,
  per-goal `mkdir` locks. A hook fire emits zero stderr. If the host UI still
  labels intentional `decision:block` continuations as "Stop hook error",
  `GOAL_STOP_PROMPT_STYLE=compact` keeps auto-continuation reliable while making
  the visible row a one-line nudge.
- Removed the `goal-ticker` daemon. It wrote to `/dev/tty`, which Claude Code
  hooks lost in v2.1.139. The live timer is now `statusLine.refreshInterval`.
- Plugin hooks moved to `hooks/hooks.json` per the current plugin spec; the
  inline `hooks` block is removed from `plugin.json`.

**Token efficiency**
- The dispatcher drives the loop by reference: a ~35-token continuation prompt
  citing the persisted spec, with a full re-paste only on context-loss signals
  (first fire of a session, every 25 ticks, a re-orientation turn). v2
  re-pasted the full objective on every turn.
- Compact Stop-hook mode keeps the same `decision:block` continuation contract
  but collapses the host-visible reason to one line.
- `mcp__goal__create_goal` now accepts and persists the structured `goalframe`
  spec, so the spec is stored once and the dispatcher has something concrete to
  reference. (Codex re-pastes the objective every continuation turn; this is the
  one place the plugin is deliberately leaner than Codex.)

**UX — the cockpit status line**
- `goal-statusline.sh` rewritten: state-driven glyph and colour (circle-dot
  healthy, slashed-circle stalled, dotted-circle needs-input, check achieved),
  an evidence meter, a live timer. Renders only for the owning session;
  terminal states do not stick.
- Interactive mockup shipped at `docs/goal-statusline-cockpit.html`.

**Intake / audit skills** (earlier commits in this branch)
- `goalframe` — structures a raw objective into a verifiable spec.
- `overclaim` — the evidence audit; the only path to `achieved`.

## Verification

- All nine hook scripts pass `bash -n`; all JSON validates.
- `scripts/smoke-v3-harness.sh` green: authoring, templates, the cockpit
  status line across pursuing / stalled / needs-input / achieved (including the
  Bug-3 guard that an unowned session renders nothing), and the MCP tools.
- `scripts/smoke-phase-1.sh` and the migration smoke green; the MCP server
  builds clean (`tsc`) and `mcp/test/smoke.mjs` + `channel-smoke.mjs` pass.
- End-to-end Stop-hook loop: progress -> continue, no-progress -> re-orient ->
  park to `needs-input`, budget reached -> `budget-limited`; zero stderr.
- No `unmet` remains in any live code path — verified by sweep.

## How to apply

No GitHub credentials were available to push. Either:

- git bundle: `git fetch ../goal-v3.bundle feat/v3-session-scoped-goals` then
  check out the branch, or
- apply the `patches/` series with `git am patches/*.patch`.

Then push and open the PR.
