# RFC: `goal` v3 — session-scoped goals with a continuation dispatcher

Status: proposed
Supersedes: v2 schema + the project-scoped `.goal/state.json` model
Author: pyyush

This document diagnoses the four field bugs against how Codex actually
implements `/goal`, then specifies a v3 architecture that fixes all four and
adds an `overclaim` skill for evidence discipline.

---

## 1. How Codex's `/goal` actually works

The Codex cookbook ("Using Goals in Codex") and the `/goal` use-case doc are
explicit about the architecture. Five load-bearing facts:

1. **A Goal is thread-scoped persisted state.** Quoting the cookbook directly:
   "Goals are implemented as persisted thread state, not as global memory and
   not as project-level instructions ... the objective belongs to the thread."
   The Goal lives with the conversation that has the context — the files
   inspected, commands run, diffs produced.

2. **Continuation is event-driven, not a loop.** "Codex checks for continuation
   only at safe boundaries: after a turn has finished, when no other work is
   pending, when no user input is queued, and when the thread is idle."

3. **The dispatcher is deliberately conservative.** "Plan-only work does not
   trigger continuation. Interruptions pause the objective ... If a continuation
   turn makes no tool call, the next automatic continuation is suppressed so
   Codex does not spin."

4. **Lifecycle authority is split.** "The model can start a Goal and can mark an
   existing Goal complete only when the evidence supports completion. Pausing,
   resuming, clearing, and budget-limited transitions remain controlled by the
   user or the system." There is **no model-reachable "failed" state.** A Goal
   that cannot progress is *blocked* — parked for the user, not terminated by
   the model.

5. **Completion is evidence-gated.** "A Goal should not be marked complete
   because the model believes it is probably done."

The 5-day non-stop Codex run works **because** of (2) and (3): the dispatcher
re-arms after every productive turn and only *suppresses* (does not kill) the
loop when a turn is unproductive. The loop is allowed to run forever **as long
as it is doing real work.**

The current `pyyush/goal` plugin diverges from Codex on (1) and (3), and that
divergence is the direct cause of all four reported bugs.

---

## 2. Root-cause diagnosis

### Bug 1 — concurrent goals from the same folder collide

The v2 data model is **one `.goal/state.json` per project root.** `goal-resolve.sh`
walks up from `$cwd` and binds to whatever single state file it finds. Two
Claude sessions started in the same directory resolve to the *same* file.

The `goal_id` CAS guard only prevents *byte corruption* — it does not prevent
*semantic collision*. Session A sets goal X. Session B runs `/goal <new>`, which
regenerates `goal_id` and overwrites `state.json` with goal Y. Session A's next
`Stop` hook re-reads `SHAPE`, picks up Y's `goal_id`, and now happily drives
**Session B's goal.** Ticks double-count, the two continuation prompts
cross-fire, and the token baseline file (`goal-baseline-${GOAL_ID}`) is shared.

There is no per-session goal identity anywhere in v2. "One goal per directory"
is the schema; concurrency is impossible by construction.

### Bug 2 — the model sits idle, or self-marks the goal `unmet`

Two failure modes, one root cause: **no dispatcher.** The v2 `Stop` hook is a
dumb `{"decision":"block"}` re-injector with no notion of progress.

* **Idle / loop dies.** Claude Code sets `stop_hook_active: true` when a `Stop`
  hook fires *as a result of* a previous `Stop` block. v2's recursion guard does
  `exit 0` on that flag. This is correct for killing a runaway loop — but it
  kills *every* loop. After one forced continuation that ends in another stop,
  the hook goes permanently silent while `status` is still `pursuing`. The user
  sees an idle session and a `pursuing` goal that nothing will ever advance.
  Codex never has this problem because its dispatcher re-arms on *progress*
  rather than relying on a "stop → re-block" recursion that the host runtime is
  actively trying to suppress.

* **Premature `unmet`.** Every continuation prompt tells the model: "If the goal
  cannot continue productively, rewrite the goal file with status `unmet`." On
  any ambiguous turn the model takes the one-token exit and writes `unmet`. The
  MCP `update_goal` tool is correctly complete-only — but the *slash command*
  and the *continuation prompt* still hand the model a direct-write path to a
  terminal failure state. Codex forbids this entirely: the model cannot fail a
  Goal. v2 gives it a failure button and the model presses it.

### Bug 3 — every new session shows the status line

`goal-statusline.sh` calls the same walk-up `resolve_goal`. It finds **any**
`.goal/state.json` in the directory tree — including terminal ones. A brand-new,
unrelated session opened in a folder where a goal ran months ago renders
`Goal achieved (1h 23m)` forever. If a goal is *currently* active from another
session, the unrelated new session renders `Pursuing goal...`.

Worse: `resolve_goal` **writes the session pointer as a side effect of
resolving.** Merely rendering the status line in a new session silently binds
that session to the found goal. The new session is adopted into a goal it never
asked for — which then also feeds Bug 1.

### Bug 4 — `Stop` hook error messages

Concrete defects in `goal-stop.sh`:

* **`set -euo pipefail` + a fragile pipeline.** The transcript token scan
  (`jq ... "$TRANSCRIPT_PATH" | awk ...`) runs over a possibly-huge JSONL file.
  Any `jq` non-zero exit or SIGPIPE aborts the whole hook under `-e`/`pipefail`.
* **Migration writes to stderr.** `goal_migrate_if_needed` does
  `printf 'goal-stop: migration: ...' >&2` on every failure path. **Stderr from
  a `Stop` hook is exactly what Claude Code surfaces to the user as a hook
  error.** This is literally the visible error text.
* **Inline migration on every fire.** Migration runs (and can fail, and can hit
  the lock) on *every* `Stop` invocation, not once.
* **`mktemp` returning success-on-failure.** `tmp=$(mktemp ...) || return 0` —

Follow-up UX hardening: Claude Code may still label an intentional
`{"decision":"block"}` Stop-hook continuation as a "Stop hook error" row in the
transcript UI. That label is host-owned; the plugin cannot rename it. The
mitigation is `GOAL_STOP_PROMPT_STYLE=compact`, which keeps the reliable block
path but shrinks the visible row to a single-line continuation nudge. Do not use
`GOAL_STOP_CONTINUE=0` when the requirement is guaranteed auto-continuation; that
mode is accounting-only and intentionally suppresses the block.
  `write_state` returns `0` (success) when the temp file could not be created,
  so the caller believes the write happened.
* **Lock starvation.** The multi-second transcript `jq` runs *while holding the
  single shared lock*, so a second session's `Stop` hook times out
  (`GOAL_LOCK_TIMEOUT_MS=5000`) and logs `lock-timeout`.
* **`.claude/` assumed writable.** `LOG_FILE`, the migration temp dir, and the
  marker file all live under `.claude/`, which a project-scope install does not
  necessarily create.

---

## 3. v3 architecture

Two principles, both imported from Codex and then extended:

> **A goal is owned by exactly one session.** (Fixes 1 and 3.)
>
> **Continuation is a dispatcher decision driven by observed progress, never a
> blind re-block — and the model can never terminate a goal as failed.**
> (Fixes 2.)

### 3.1 Data model — per-goal files, explicit ownership

```
.goal/
  goals/<goal_id>.json      one file per goal — no shared mutable file
  sessions/<session_id>     text: the goal_id this session owns/adopted
  cursors/<goal_id>         dispatcher progress cursor (tool-call count, wt hash)
  locks/<goal_id>.lock      per-goal lock — concurrent goals never starve
  events.jsonl              all diagnostics go here, never to stderr
  pause                     global kill switch (unchanged)
```

`.goal/` is still located by walking up from `$cwd` (so one project shares one
`.goal/` directory). But a *goal* is no longer "the file at the root" — it is a
record in `goals/`, and **a session acts on a goal only if `sessions/<sid>`
names it.** Two sessions in one folder produce two files in `goals/`. No
collision is possible.

New / changed fields on the goal record:

| field | meaning |
|---|---|
| `owner_session_id` | the session that created the goal |
| `bound_sessions` | sessions currently authorized to drive it (≥1) |
| `status` | `pursuing` · `paused` · `needs-input` · `achieved` · `abandoned` · `budget-limited` |
| `idle_strikes` | consecutive no-progress turns (dispatcher) |
| `last_progress_at` | ISO-8601 of the last turn that made progress |

**`unmet` is removed from the model's vocabulary.** The terminal/parked states
and who may set them:

| status | who sets it | meaning |
|---|---|---|
| `achieved` | model, **only** after an `overclaim` audit passes | objective verified done |
| `needs-input` | dispatcher or model *request* | parked — waiting on the user; **not** failed, fully resumable |
| `paused` | user only | user paused it |
| `abandoned` | user only | user gave up on it (the old `unmet`, now user-owned) |
| `budget-limited` | system only | token budget hit |

The model can reach exactly one terminal state — `achieved` — and only through
the audit. Everything else is the user's or the system's call. This is Codex's
split lifecycle, and it is the entire fix for "the model moves the goal to
`unmet`": the model no longer can.

### 3.2 Resolution — ownership, not walk-up

The resolver (`hooks/goal-resolve.sh`, rewritten) exposes two functions:

* `goal_resolve_owned <session_id> <cwd>` — find `.goal/` by walk-up, read
  `sessions/<sid>`, load that goal. Used by the **`Stop` hook and the status
  line.** It is **read-only** — resolving never creates a binding. Returns
  non-zero if the session owns no goal, or the owned goal's file is gone.

* `goal_discover_project <cwd>` — walk up, list non-terminal goals in `goals/`.
  Used **only by the `/goal` slash command** to *offer* adoption. Never writes.

Consequences:

* **Bug 3 gone.** A fresh session owns nothing → `goal_resolve_owned` returns
  non-zero → the status line prints nothing. Rendering the status line never
  binds a session to a goal. Terminal goals never render in the status line at
  all (completion is reported in-chat by the model; `/goal status` always
  works).
* **Bug 1 gone.** The `Stop` hook only ever acts on the goal the firing session
  owns. Two sessions = two owners = two goal files = two per-goal locks.

A session becomes an owner only by an explicit user action: `/goal <objective>`
(create) or `/goal adopt` (take over a goal discovered in the project — e.g.
after `/clear`, a restart, or to deliberately join another session's goal).

### 3.3 The continuation dispatcher

The `Stop` hook becomes a thin wrapper that sources `hooks/goal-dispatch.sh`.
On every fire, for a goal the session **owns** with `status == pursuing`:

**Step 1 — detect progress in the turn that just ended.**
Progress is true if *any* of:

* the transcript contains ≥1 new `tool_use` block since the per-goal cursor
  (`.goal/cursors/<goal_id>` stores the cumulative unique `tool_use` id count);
* the working tree changed (`git status --porcelain` hash differs from cursor);
* an `mcp__goal__report_progress` call was logged this turn.

A pure-text turn or a plan-mode turn is **not** progress. This is Codex's
"plan-only work does not trigger continuation" and "no tool call ⇒ suppress."

**Step 2 — branch on progress.**

* **Progress** → `idle_strikes = 0`, refresh `last_progress_at`, emit the
  continuation prompt, return `{"decision":"block"}`. The loop continues. This
  may run indefinitely — a healthy 5-day run, like Codex.

* **No progress** → `idle_strikes += 1`.
  * **strike 1** → emit a *re-orientation* prompt — "the last turn made no tool
    calls; choose one concrete next action and run a tool this turn; if you are
    blocked, state exactly what input you need" — and `block` **once**.
  * **strike ≥ 2** → **do not block.** Set `status = needs-input`, append a
    history note `auto-parked: 2 consecutive no-progress turns`, emit a plain
    (non-blocking) message telling the user the goal is parked and why. The goal
    is **parked, not failed.** `/goal resume` re-arms it.

**Step 3 — `stop_hook_active` is no longer a kill switch.**
v2 did `exit 0` on `stop_hook_active=true`, silently killing the loop. v3
treats the flag as just another input to Step 1/2:

* `stop_hook_active && progress` → continue (this is the *normal* steady state
  of a long run; killing it here is the v2 idle bug).
* `stop_hook_active && !progress` → it counts as a strike; one re-orientation,
  then park to `needs-input`.

The host runtime's anti-runaway intent is still satisfied — an *unproductive*
loop terminates within two strikes — but a *productive* loop is never murdered
by the recursion guard. This is the single change that lets v3 match Codex's
multi-day runs.

**Invariant:** the dispatcher never leaves a `pursuing` goal in a state where
nothing will advance it. Every fire ends in exactly one of: `block` (loop
continues), or a status transition to `needs-input` / `budget-limited` /
`achieved` (loop legibly ends, user/status line can see why). There is no
"silent `exit 0` while `pursuing`" path.

### 3.4 Budget

Unchanged in spirit. Token accounting moves *outside* the per-goal lock (scan
the transcript first, lock only for the read-modify-write). On
`tokens_used >= token_budget` the system sets `budget-limited` and the prompt
tells the model to wrap up — never to claim `achieved`.

### 3.5 Hook hardening (Bug 4)

* **No `set -e`, no `pipefail`** in the `Stop` hook. Use `set -u` only; guard
  every external pipeline with `|| true` and check results explicitly. A failed
  `jq` over a transcript degrades to "no token update this fire," never aborts.
* **Nothing is ever written to stderr.** All diagnostics → `.goal/events.jsonl`.
  A `Stop` hook that writes stderr is a `Stop` hook that shows the user an
  error. The migration's `>&2` lines are deleted.
* **Migration is a one-shot script** (`bin/goal-migrate-v3`) run by
  `goal-setup`. The `Stop` hook never migrates.
* **All temp files live in `.goal/`** (always writable — we just resolved a goal
  there). `mktemp` failure returns non-zero and the caller aborts the *write*,
  not the hook.
* **Per-goal locks** (`.goal/locks/<goal_id>.lock`) — goal A's slow transcript
  scan cannot starve goal B.

---

## 4. Skills: `goalframe` (entry) and `overclaim` (exit)

A goal has two failure-prone seams — the moment it is *created* and the moment
it is *declared done*. v3 puts a model-invoked skill at each.

### 4.1 `goalframe` — structure the objective before it becomes a goal

Codex is explicit that the quality of a `/goal` run is set before the run
starts: "a good Goal is more than a larger prompt. It is a compact contract."
Its cookbook names the six things a strong goal defines — outcome, verification
surface, constraints, boundaries, iteration policy, blocked stop condition — and
its weak→strong examples ("Improve performance" → "Reduce p95 latency below
120 ms on the checkout benchmark while keeping the correctness suite green")
show the gap an unframed objective leaves.

`goalframe` (`skills/goalframe/SKILL.md`) runs *inside* `/goal`, before the goal
record is written. It takes the raw objective and emits a structured `spec`:

```json
"spec": {
  "title":        "imperative line, <= 80 chars, injection-safe",
  "outcome":      "what is true when done",
  "verification": "the command / test / artifact that proves it",
  "constraints":  "what must not regress",
  "boundaries":   "what may be touched",
  "iteration":    "how to pick the next action",
  "blocked_when": "when to stop and report",
  "assumptions":  ["inferences made instead of asking the user"]
}
```

It infers aggressively from the repo (test scripts, CI config, `PLAN.md`) rather
than interrogating the user, asks at most one tight round only for genuinely
unguessable gaps, and rejects objectives that should not be goals at all
(one-line edits, "make it better", unrelated backlogs) — Codex's "when not to
use Goals". The raw `objective` is still stored verbatim for provenance.

`goalframe` and `overclaim` share one contract: the `verification` field
`goalframe` writes is precisely the surface `overclaim` audits claims against.
Frame the goal well and the completion check downstream is mechanical.

### 4.2 `overclaim` — evidence discipline before any completion claim

`overclaim` (`skills/overclaim/SKILL.md`) enforces the discipline from Codex's
Deep Hedging example — "keep working through ambiguity while preventing a
plausible artifact from becoming an overclaimed conclusion." It triggers before
the model writes `status: achieved`, before any `report_progress`, and before
the model tells the user something is "done / fixed / passing / working."

It produces a **claim ledger** assigning every requirement one support level —
`confirmed`, `partial`, `proxy-only`, `unverified`, `blocked` — and gates: **a
goal is `achieved` only if every requirement is `confirmed`.** Anything else
means continue or transition to `needs-input`. It is strictly more advanced than
Codex's inline audit paragraph: reusable, produces a durable ledger artifact,
and carries an explicit forbidden-phrasing catalog.

### 4.3 Token-efficient continuation

The structured `spec` is what makes the loop cheap. v2 re-pasted the full
objective (up to 4000 chars) into the continuation prompt on **every tick** — a
multi-day run re-injected it thousands of times. v3 writes the spec to the goal
record **once** (at `/goal` time, via `goalframe`) and the dispatcher drives the
run by *reference*, with two prompt tiers:

| tier | size | content | sent when |
|---|---|---|---|
| **compact** | one line | goal id, title, record path, one-tool-step instruction, `overclaim` reminder | when `GOAL_STOP_PROMPT_STYLE=compact` is set; default installer behavior for a cleaner host transcript |
| **short** | ~35 tokens | goal id, title, record path, `overclaim` reminder — **no objective body** | default (context assumed intact) |
| **full** | spec only (6 compact fields, fenced as untrusted data) | the structured `spec` | first dispatch fire of a session · every `GOAL_REFRESH_EVERY` ticks (default 25) · every re-orientation turn |

The model already has the objective in thread context; the short prompt only
*reminds* it and points at the record to re-read. The full prompt is re-sent
exactly on the signals where context was plausibly lost — a fresh session, a
`/clear`, silent compaction, or a visibly off-track turn. Over a 2000-tick run
that is ~80 full refreshes plus ~1920 short prompts, versus v2's 2000 full
pastes. Because `goalframe` produces a *compact* spec, even a full refresh is a
fraction of a raw-objective paste, and a model re-reading six crisp fields
recovers context far faster than one re-reading a 4000-char paragraph.

The dispatcher references both skills by name rather than inlining their logic,
so the framing and audit rules live in one versioned place.

See `skills/goalframe/SKILL.md`, `skills/goalframe/references/spec-template.md`,
`skills/overclaim/SKILL.md`, and `skills/overclaim/references/claim-ledger.md`.

---

## 5. Migration from v2

`bin/goal-migrate-v3` (run once by `goal-setup`, never by a hook):

1. For each project with a `.goal/state.json`, mint `goals/<goal_id>.json` from
   it (the existing `goal_id` is reused).
2. If the v2 goal is non-terminal, **leave it unowned.** The next `/goal` or
   `/goal adopt` in that project binds a session — v3 never auto-adopts.
3. Map status `unmet` → `abandoned` (it was a terminal failure; now user-owned).
4. Delete `.goal/state.json` only after `goals/<id>.json` is written and
   fsync'd.
5. `GOAL_DISABLE_MIGRATION=1` still skips it.

v1 → v2 migration code is removed from the `Stop` hook entirely.

---

## 6. What ships

| file | role |
|---|---|
| `hooks/goal-resolve.sh` | session-scoped resolver — `goal_resolve_owned`, `goal_discover_project` |
| `hooks/goal-dispatch.sh` | continuation dispatcher — progress detection, strike ladder, tiered (short/full) prompting |
| `hooks/goal-stop.sh` | thin, hardened `Stop` hook — sources the dispatcher |
| `skills/goalframe/SKILL.md` | entry-side skill — structures the objective into a `spec` |
| `skills/goalframe/references/spec-template.md` | spec field rubric + inference defaults |
| `skills/overclaim/SKILL.md` | exit-side skill — evidence-gated completion |
| `skills/overclaim/references/claim-ledger.md` | claim-ledger template + support-level rubric |
| `goal.md` | slash command — invokes `goalframe` on create, stores `spec` |
| `bin/goal-migrate-v3` | one-shot v2 → v3 migration (not shown here; spec in §5) |

Behavior matrix after v3:

| symptom | v2 | v3 |
|---|---|---|
| two sessions, one folder | share & clobber one file | two independent owned goals |
| long autonomous run | dies on `stop_hook_active` | continues while making progress |
| ambiguous turn | model writes `unmet`, goal dead | parks to `needs-input`, fully resumable |
| new session in an old goal dir | status line shows stale goal | status line empty (owns nothing) |
| `Stop` hook hiccup | stderr → visible error | logged to `events.jsonl`, silent |
| objective text per tick | full re-paste (≤4000 chars) every tick | written once; short reference per tick, full spec only on context-loss signals |
| vague objective | pursued as-is, drifts | `goalframe` structures it into a verifiable spec first |
