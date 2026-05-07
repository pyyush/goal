# `/goal` for Claude Code

A port of [OpenAI Codex CLI](https://github.com/openai/codex)'s `/goal` command (codex-cli 0.128.0) to [Claude Code](https://claude.com/claude-code), implemented as a slash command plus two hooks. Works in both Claude Code CLI and the Claude desktop / IDE clients — they share the same `.claude/` configuration.

A goal is a durable objective attached to a project that Claude pursues across turns until it is `achieved`, `unmet`, `paused`, cleared, or `budget-limited`.

## How it maps to Codex

| Codex piece | This port |
|---|---|
| `/goal` slash command | `.claude/commands/goal.md` |
| App-server runtime continuation (auto-loop) | `.claude/hooks/goal-stop.sh` (Stop hook returning `{"decision":"block"}`) |
| `templates/goals/continuation.md` | Inline content of `goal-stop.sh` |
| `templates/goals/budget_limit.md` | Inline content of `goal-stop.sh` (budget branch) |
| Auto-pause on user input | `.claude/hooks/goal-prompt.sh` (UserPromptSubmit hook) |
| `update_goal` tool | Claude rewrites `.claude/goal.json` directly |
| Persistent state (app-server) | `.claude/goal.json` on disk — survives `/clear`, sessions, `--resume` |
| Lifecycle states | `pursuing \| paused \| achieved \| unmet \| budget-limited` |
| Token budget | Advisory; enforced by hook when `tokens_used >= token_budget` |

The Stop hook is the key piece. When Claude finishes a turn and a goal is `pursuing`, the hook returns `{"decision":"block","reason":"<continuation prompt>"}` — Claude Code then forces another turn with that prompt as context. This is exactly what Codex's app-server does, just implemented through Claude Code's hook system instead of a built-in runtime.

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
cp hooks/goal-stop.sh     .claude/hooks/
cp hooks/goal-prompt.sh   .claude/hooks/
chmod +x .claude/hooks/*.sh

# Register hooks: merge settings.json.example into .claude/settings.json
# (or use /hooks inside Claude Code to add them via the UI)

# Don't commit per-project goal state or hook logs
printf '.claude/goal.json\n.claude/goal-hook.log\n.claude/goal.pause\n' >> .gitignore
```

### User scope

User-scope hooks live in `~/.claude/`, but Claude Code runs hook commands from each project's working directory. That means **the hook command must use an absolute path**, otherwise it will look for `.claude/hooks/goal-stop.sh` inside whichever project you happen to be in.

```bash
mkdir -p ~/.claude/commands ~/.claude/hooks
cp goal.md                ~/.claude/commands/goal.md
cp hooks/goal-stop.sh     ~/.claude/hooks/
cp hooks/goal-prompt.sh   ~/.claude/hooks/
chmod +x ~/.claude/hooks/*.sh
```

Then merge into `~/.claude/settings.json`, replacing `.claude/hooks/...` with the absolute path:

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          { "type": "command", "command": "bash $HOME/.claude/hooks/goal-stop.sh" }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          { "type": "command", "command": "bash $HOME/.claude/hooks/goal-prompt.sh" }
        ]
      }
    ]
  }
}
```

The state file (`.claude/goal.json`) is still per-project — it lives in whatever directory you run Claude Code from.

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

With hooks installed, `/goal <objective>` is usually the only command you need — Claude works the loop on its own until it audits as `achieved`, declares `unmet`, hits the budget, hits a hard ceiling, or you interrupt with a new prompt (auto-pauses).

Subcommands are case-insensitive and trimmed (`/goal Pause`, `  /goal resume  ` both work). Anything that isn't a recognized subcommand is treated as a new objective with original casing preserved.

## Safety

The Stop hook auto-continues every turn while `status="pursuing"`. To prevent runaway loops (e.g. the model never transitions state, or `tokens_used` is never updated), the hook enforces three independent safety mechanisms:

| Mechanism | Default | Override | Behavior on hit |
|---|---|---|---|
| **Tick ceiling** | 50 continuations | `GOAL_MAX_TICKS=N` | Goal auto-marked `unmet`; loop stops |
| **Wall-clock ceiling** | 7200 seconds (2h) | `GOAL_MAX_SECONDS=N` | Goal auto-marked `unmet`; loop stops |
| **Token budget** | unset | `/goal budget <N>` | Goal auto-marked `budget-limited`; model wraps up |

Set the env vars in your `~/.claude/settings.json` under `env`, or `export` them in your shell.

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

Tail it to debug stuck goals or unexpected pauses.

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
| Token tracking | Real, runtime-counted | Advisory; the model updates `tokens_used` per turn (best effort) |
| Budget transition | Intra-turn, mid-stream | At the end of the turn that exceeded the budget (next Stop hook) |
| Auto-pause trigger | Explicit user interrupt (`Ctrl-C` mid-turn) | Any non-`/goal` UserPromptSubmit while `status="pursuing"` |
| `unmet` state | Not a Codex state — Codex has `Active / Paused / BudgetLimited / Complete` only | Used here for hard-blocked goals and ceiling auto-stops |
| Subcommands | `pause`, `resume`, `clear` (everything else is treated as a new objective) | Plus `status`, `achieved`/`complete`, `unmet`/`blocked`, `budget <N>` |
| Status writes | Model can only mark `complete` via `update_goal`; everything else is user/system | Model writes status directly to `.claude/goal.json` |
| Multiple concurrent goals | One active per thread | One active per project (file-based) |
| External API | App-server lets external tooling read goal state | File-based — read `.claude/goal.json` directly |
| Plan mode | Goal continuation suppressed in Plan mode | No equivalent (no Plan-mode signal in hooks) |
| Hard ceilings | None (runtime-bounded) | Tick + wall-clock ceilings to backstop the absent runtime |

Without hooks installed, you fall back to manual ticking via `/goal`.

## File layout after a project-scope install

```
your-project/
├── .claude/
│   ├── commands/
│   │   └── goal.md
│   ├── hooks/
│   │   ├── goal-stop.sh        # runtime continuation + ceilings
│   │   └── goal-prompt.sh      # auto-pause on user input
│   ├── settings.json           # hook registration
│   ├── goal.json               # state (gitignored)
│   ├── goal-hook.log           # one JSON line per hook invocation
│   └── goal.pause              # presence = kill switch (gitignored)
└── .gitignore
```

## Source

The continuation and budget-limit prompts are adapted from [`codex-rs/core/templates/goals/`](https://github.com/openai/codex/tree/main/codex-rs/core/templates/goals) in the Codex repository. Lifecycle states and the `<untrusted_objective>` framing follow the same source (with a per-turn nonce added).

## License

[MIT](LICENSE).
