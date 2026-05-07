# `/goal` for Claude Code

A port of [OpenAI Codex CLI](https://github.com/openai/codex)'s `/goal` command (codex-cli 0.128.0) to [Claude Code](https://claude.com/claude-code), implemented as a slash command plus two hooks. Works in both Claude Code CLI and the Claude desktop / IDE clients — they share the same `.claude/` configuration.

A goal is a durable objective attached to a project that Claude pursues across turns until it is `achieved`, `unmet`, `paused`, cleared, or `budget-limited`.

## How it maps to Codex

| Codex piece | This port |
|---|---|
| `/goal` slash command | `.claude/commands/goal.md` |
| App-server runtime continuation (auto-loop) | `.claude/hooks/goal-stop.sh` (Stop hook returning `{"decision":"block"}`) |
| `templates/goals/continuation.md` | Inline content of `goal-stop.sh`, ported verbatim with `<untrusted_objective>` framing intact |
| Auto-pause on user input | `.claude/hooks/goal-prompt.sh` (UserPromptSubmit hook) |
| `update_goal` tool | Claude rewrites `.claude/goal.json` directly |
| Persistent state (app-server) | `.claude/goal.json` on disk — survives `/clear`, sessions, `--resume` |
| Lifecycle states | `pursuing \| paused \| achieved \| unmet \| budget-limited` (identical) |
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

# Don't commit per-project goal state
echo '.claude/goal.json' >> .gitignore
```

### User scope

User-scope hooks live in `~/.claude/`, but Claude Code runs hook commands from each project's working directory. That means **the hook command must use an absolute path**, otherwise it'll look for `.claude/hooks/goal-stop.sh` inside whichever project you happen to be in.

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
/goal budget <N>      Set a token budget (soft stop)
```

With hooks installed, `/goal <objective>` is usually the only command you need — Claude works the loop on its own until it audits as `achieved`, declares `unmet`, hits the budget, or you interrupt with a new prompt (auto-pauses).

## Optional: scheduled ticking with `/loop`

If you'd rather not use the Stop hook for auto-continuation but still want timed checks (e.g. polling a deployment), use Claude Code's built-in `/loop`:

```
/loop 5m /goal
```

This ticks `/goal` every 5 minutes during the session — useful for goals that involve waiting on external state. Session-scoped, auto-expires after about 7 days.

For maximum autonomy, combine: hooks drive in-session continuation, `/loop` adds an extra periodic kick if the loop ever stalls.

## Differences from Codex `/goal`

With hooks installed, the only material gaps are:

| | Codex CLI | This port |
|---|---|---|
| Token tracking | Real, runtime-counted | Advisory; the model updates `tokens_used` per turn (best effort) |
| Multiple concurrent goals | One active per thread | One active per project (file-based) |
| App-server API surface | External tooling can query goal state | File-based — read `.claude/goal.json` directly |

Without hooks, you fall back to manual ticking via `/goal`.

## File layout after a project-scope install

```
your-project/
├── .claude/
│   ├── commands/
│   │   └── goal.md
│   ├── hooks/
│   │   ├── goal-stop.sh        # runtime continuation
│   │   └── goal-prompt.sh      # auto-pause on input
│   ├── settings.json           # hook registration
│   └── goal.json               # state (gitignored)
└── .gitignore
```

## Source

The continuation prompt is adapted from [`codex-rs/core/templates/goals/continuation.md`](https://github.com/openai/codex/blob/main/codex-rs/core/templates/goals/continuation.md) in the Codex repository. Lifecycle states and the `<untrusted_objective>` framing follow the same source.

## License

[MIT](LICENSE).
