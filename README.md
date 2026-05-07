# `/goal` for Claude Code

A port of [OpenAI Codex CLI](https://github.com/openai/codex)'s `/goal` command (codex-cli 0.128.0) to [Claude Code](https://claude.com/claude-code), implemented as a slash command plus a few hooks. Works in both Claude Code CLI and the Claude desktop / IDE clients — they share the same `.claude/` configuration.

A goal is a durable objective attached to a project that Claude pursues across turns until it is `achieved`, `unmet`, `paused`, cleared, or `budget-limited`.

**Design priority is subscription users.** The defaults assume you want the goal to *keep moving* — through user input, through `/clear`, through auto-compaction — and only pause when something actually breaks (rate limit, API error). Token budgets exist for API users but are off by default.

## How it maps to Codex

| Codex piece | This port |
|---|---|
| `/goal` slash command | `.claude/commands/goal.md` |
| App-server runtime continuation (auto-loop) | `.claude/hooks/goal-stop.sh` (Stop hook returning `{"decision":"block"}`) |
| `templates/goals/continuation.md` | Inline content of `goal-stop.sh` |
| `templates/goals/budget_limit.md` | Inline content of `goal-stop.sh` (budget branch) |
| `update_goal` tool | Claude rewrites `.claude/goal.json` directly |
| Persistent state (app-server) | `.claude/goal.json` on disk — survives `/clear`, sessions, `--resume` |
| Lifecycle states | `pursuing \| paused \| achieved \| unmet \| budget-limited` |
| TUI status indicator (`Goal paused (/goal resume)`) | `.claude/hooks/goal-statusline.sh` (helper for your statusLine) |
| Pause on `Ctrl-C` interrupt | `.claude/hooks/goal-notify.sh` (Notification hook — pauses on rate-limit / API error) |
| Pause on every user prompt | `.claude/hooks/goal-prompt.sh` (UserPromptSubmit hook, **opt-in** via `GOAL_AUTOPAUSE_ON_PROMPT=1`) |

The Stop hook is the engine. When Claude finishes a turn and a goal is `pursuing`, the hook returns `{"decision":"block","reason":"<continuation prompt>"}` — Claude Code then forces another turn. This is the same shape as Codex's app-server runtime, just implemented through Claude Code's hook system.

## Requirements

- `bash` and `jq` on `PATH`. macOS ships both (the hooks are tested against bash 3.2).
- On Windows, run via WSL or rewrite the hooks in PowerShell / Python.

## Install

Two scopes are supported. **Project scope** confines `/goal` to one repo; **user scope** makes it available across every project on your machine.

### Project scope

```bash
# From your project root
mkdir -p .claude/commands .claude/hooks
cp goal.md                .claude/commands/goal.md
cp hooks/*.sh             .claude/hooks/
chmod +x .claude/hooks/*.sh

# Register hooks: merge settings.json.example into .claude/settings.json
# (or use /hooks inside Claude Code to add them via the UI)

# Don't commit per-project goal state or hook artifacts
printf '.claude/goal.json\n.claude/goal-hook.log\n.claude/goal.pause\n' >> .gitignore
```

### User scope

User-scope hooks live in `~/.claude/`, but Claude Code runs hook commands from each project's working directory. **The hook command must use an absolute path**, otherwise it'll look for `.claude/hooks/goal-stop.sh` inside whichever project you're in.

```bash
mkdir -p ~/.claude/commands ~/.claude/hooks
cp goal.md      ~/.claude/commands/goal.md
cp hooks/*.sh   ~/.claude/hooks/
chmod +x ~/.claude/hooks/*.sh
```

Then merge into `~/.claude/settings.json`, replacing `.claude/hooks/...` with absolute paths:

```json
{
  "hooks": {
    "Stop": [
      { "hooks": [{ "type": "command", "command": "bash $HOME/.claude/hooks/goal-stop.sh" }] }
    ],
    "Notification": [
      { "hooks": [{ "type": "command", "command": "bash $HOME/.claude/hooks/goal-notify.sh" }] }
    ],
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "bash $HOME/.claude/hooks/goal-prompt.sh" }] }
    ]
  }
}
```

(The `UserPromptSubmit` registration is harmless without `GOAL_AUTOPAUSE_ON_PROMPT=1` — the hook is a no-op until you set the env var. Leave it registered if you might want to flip the toggle later.)

The state file (`.claude/goal.json`) is per-project — it lives in whatever directory you run Claude Code from.

### Status line indicator

To get a `Goal pursuing` / `Goal paused (/goal resume)` segment on your status line (à la Codex), call `goal-statusline.sh` from your existing statusLine command and append its output as a segment. From a typical statusline-command.sh:

```bash
input=$(cat)
cwd=$(printf '%s' "$input" | jq -r '.cwd // .workspace.current_dir // ""')
# ... your existing segments ...

if [ -x "$HOME/.claude/hooks/goal-statusline.sh" ]; then
    goal_seg=$(bash "$HOME/.claude/hooks/goal-statusline.sh" "$cwd")
    [ -n "$goal_seg" ] && segments+=("$goal_seg")
fi
```

The helper outputs nothing when there's no goal, and an ANSI-colored single-line label otherwise.

## Usage

```
/goal <objective>     Set/replace the active goal; starts pursuing immediately
/goal                 Show status (and tick the loop manually if you didn't install hooks)
/goal status          Show status only, never tick
/goal pause           Pause continuation
/goal resume          Resume + tick
/goal clear           Delete the goal
/goal achieved        Manually mark complete (runs an audit first; refuses if not done)
/goal unmet           Manually mark blocked
/goal budget <N>      Set a positive integer token budget (soft stop)
```

With hooks installed, `/goal <objective>` is usually the only command you need — Claude works the loop on its own until it audits as `achieved`, declares `unmet`, hits the budget, hits a hard ceiling, or a rate-limit / API error pauses it.

Subcommands are case-insensitive on the first whitespace-separated token (`/goal Pause`, `  /goal resume  ` both work). Anything else is treated as a new objective with the original casing preserved.

## Behavior in adverse conditions

The state file lives on disk independent of the conversation, so most disruptions are transparent:

- **`/clear`** — clears the conversation context, not the goal. The Stop hook re-injects the goal continuation on the next turn; the model resumes from actual file state (per the continuation prompt's "avoid repeating work" instruction).
- **Auto-compaction** — same. Compaction summarizes the in-context history; the goal context is re-injected fresh after compaction completes.
- **Rate limit / API error** — the Notification hook (`goal-notify.sh`) detects rate-limit / quota / 5xx / overload / auth / timeout patterns in Claude Code notifications and auto-pauses the goal. When the runtime recovers, run `/goal resume` to continue. (If Claude Code doesn't fire a Notification on errors, the goal naturally stalls anyway — no Stop hook fires while the API is unreachable — and resumes when you next interact.)
- **Session ends / restart** — the goal persists. Next time you open Claude Code in the project, the Stop hook fires after your first turn and continuation resumes.

## Safety

The Stop hook auto-continues every turn while `status="pursuing"`. **By default there are no time or tick limits** — a goal will pursue indefinitely until it's `achieved`, `unmet`, paused, or interrupted by a rate-limit / API error. The real safety mechanisms are:

1. **Notification hook** — auto-pauses on rate-limit / API-error / timeout / overload notifications. Pick up with `/goal resume`.
2. **Kill switch** — `touch .claude/goal.pause` from any terminal halts the loop instantly.
3. **Manual control** — `/goal pause`, `/goal clear`, or `/goal unmet`.

If you also want hard caps on top of those (e.g. you're on metered API and want a belt-and-suspenders cap), set either or both of:

| Env var | Purpose | Behavior on hit |
|---|---|---|
| `GOAL_MAX_TICKS` | Cap continuation cycles per goal | Goal auto-marked `unmet`; loop stops |
| `GOAL_MAX_SECONDS` | Cap wall-clock seconds per goal | Goal auto-marked `unmet`; loop stops |
| `/goal budget <N>` | Cap token usage (advisory) | Goal auto-marked `budget-limited`; model wraps up |

Both env vars default to `0` (unlimited). Set to a positive integer to enable. Place them in your `~/.claude/settings.json` under `env`, or `export` them in your shell.

### Kill switch

If you need to stop a stuck loop without going through the chat:

```bash
touch .claude/goal.pause
```

The Stop hook checks for this file at the very top and exits cleanly. Remove the file to re-enable continuation.

### Observability

Each hook invocation appends one JSON line to `.claude/goal-hook.log`:

```json
{"ts":"2026-05-06T20:15:03Z","pid":12345,"hook":"stop","event":"tick","note":"tick=3 tokens=1200 time=180s"}
```

Tail it (`tail -f .claude/goal-hook.log`) to debug stuck goals, unexpected pauses, or auto-pause-error events from the Notification hook.

### Threat model

- **Drive-by injection.** If you `cd` into a repo that contains a planted `.claude/goal.json` and your hooks are user-scope, the Stop hook will see `status="pursuing"` and inject the planted objective into the model on the first turn. The hook refuses to follow symlinked state files, but it does trust file *contents*. Don't commit `.claude/goal.json` (the included `.gitignore` excludes it), and treat `.claude/` from cloned repos with the same caution as any other untrusted code.
- **Prompt injection via objective.** The objective text is wrapped in `<untrusted_objective_<random-nonce>>...</untrusted_objective_<random-nonce>>` tags before being injected as the continuation prompt. The nonce changes per turn and any literal `</untrusted_objective...>` substring is stripped from the objective, making tag-close escapes infeasible.

## Optional: scheduled ticking with `/loop`

If you'd rather not use the Stop hook for auto-continuation but still want timed checks (e.g. polling a deployment), use Claude Code's built-in `/loop`:

```
/loop 5m /goal
```

This ticks `/goal` every 5 minutes during the session — useful for goals that involve waiting on external state. Session-scoped, auto-expires after about 7 days.

For maximum autonomy, combine: hooks drive in-session continuation, `/loop` adds an extra periodic kick if the loop ever stalls.

## Differences from Codex `/goal`

This port has the same lifecycle and the same `<untrusted_objective>` framing (with hardening), but Claude Code's runtime is different from Codex's app-server, and a few behaviors necessarily diverge:

| | Codex CLI | This port |
|---|---|---|
| Token tracking | Real, runtime-counted | Advisory; the model updates `tokens_used` per turn (best effort). Off by default. |
| Budget transition | Intra-turn, mid-stream | At the end of the turn that exceeded the budget (next Stop hook) |
| Auto-pause trigger | Explicit user interrupt (`Ctrl-C` mid-turn) | Notification hook on rate-limit / API error patterns; opt-in pause-on-every-user-prompt via `GOAL_AUTOPAUSE_ON_PROMPT=1` |
| `unmet` state | Not a Codex state — Codex has `Active / Paused / BudgetLimited / Complete` only | Used here for hard-blocked goals and ceiling auto-stops |
| Subcommands | `pause`, `resume`, `clear` (everything else is a new objective) | Plus `status`, `achieved`/`complete`, `unmet`/`blocked`, `budget <N>` |
| Status writes | Model can only mark `complete` via `update_goal`; everything else is user/system | Model writes status directly to `.claude/goal.json` |
| Multiple concurrent goals | One active per thread | One active per project (file-based) |
| External API | App-server lets external tooling read goal state | File-based — read `.claude/goal.json` directly |
| Plan mode | Goal continuation suppressed in Plan mode | No equivalent (no Plan-mode signal in hooks) |
| Hard ceilings | None (runtime-bounded) | None by default; optional tick / wall-clock ceilings via env vars |

Without hooks installed, you fall back to manual ticking via `/goal`.

## File layout after a project-scope install

```
your-project/
├── .claude/
│   ├── commands/
│   │   └── goal.md
│   ├── hooks/
│   │   ├── goal-stop.sh         # runtime continuation + ceilings
│   │   ├── goal-notify.sh       # auto-pause on rate-limit / API error
│   │   ├── goal-prompt.sh       # opt-in auto-pause on user input
│   │   └── goal-statusline.sh   # status line helper (call from your statusLine)
│   ├── settings.json            # hook registration
│   ├── goal.json                # state (gitignored)
│   ├── goal-hook.log            # one JSON line per hook invocation
│   └── goal.pause               # presence = kill switch (gitignored)
└── .gitignore
```

## Source

The continuation and budget-limit prompts are adapted from [`codex-rs/core/templates/goals/`](https://github.com/openai/codex/tree/main/codex-rs/core/templates/goals) in the Codex repository. Lifecycle states and the `<untrusted_objective>` framing follow the same source (with a per-turn nonce added).

## License

[MIT](LICENSE).
