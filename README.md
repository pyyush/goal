# `/goal` for Claude Code

Give [Claude Code](https://claude.com/claude-code) a durable objective and walk away — it pursues across turns, survives `/clear` and auto-compaction, auto-pauses on rate-limit / API errors, and only stops when the goal is genuinely done. A faithful port of [OpenAI Codex CLI](https://github.com/openai/codex)'s `/goal` command (codex-cli 0.128.0) implemented as a slash command + a handful of hooks.

Works in both Claude Code CLI and the Claude desktop / IDE clients — they share the same `.claude/` configuration.

## Quickstart

```bash
git clone https://github.com/pyyush/claude-goal-command
cd claude-goal-command
./install.sh user        # or: ./install.sh project
```

Restart Claude Code, then in any project:

```
/goal Refactor the auth module to use the new session API; run tests until green
```

That's it. The model continues working on the goal across every turn until it audits as `achieved`, declares `unmet`, hits a rate limit (auto-pause), or you run `/goal pause`.

## What this gives you

- **Persistent objective.** Set it once with `/goal <objective>`. Stored in `.claude/goal.json` per project — survives `/clear`, session restart, `--resume`, auto-compaction.
- **Auto-continuation.** A Stop hook injects a continuation prompt after every turn while the goal is `pursuing`, mirroring Codex's app-server runtime.
- **Subscription-friendly defaults.** No token budget, no time limit. The goal keeps moving until it's done.
- **Auto-pause on errors.** A Notification hook detects rate-limit / quota / 5xx / overload / auth / timeout patterns and pauses the goal cleanly.
- **Status line indicator.** A drop-in helper for your statusLine command that shows `Pursuing goal (5m)` / `Goal paused (/goal resume)` / `Goal achieved (1h23m)` etc. — exact label wording from Codex's TUI bottom-pane indicator, single magenta color (theme-adaptive ANSI 35), compact token formatting (`12.5K / 50K`).
- **Kill switch.** `touch .claude/goal.pause` halts the loop instantly from any terminal.
- **Single-objective audit.** Before claiming `achieved`, the model is forced to build a prompt-to-artifact checklist mapping every requirement to concrete evidence — no false positives from "I implemented it" intuition.

## Commands

```
/goal <objective>     Set or replace the active goal; starts pursuing immediately
/goal                 Show status (and tick the loop manually if no Stop hook)
/goal status          Show status only — never tick
/goal pause           Pause the auto-continuation loop
/goal resume          Resume; the next turn picks up automatically
/goal clear           Delete the goal (rm -f .claude/goal.json)
/goal achieved        Manually mark complete — runs an audit first, refuses if it fails
/goal unmet           Manually mark blocked
/goal budget <N>      Set a positive-integer token budget (advisory soft stop)
```

Subcommands are case-insensitive on the first whitespace-separated token (`/goal Pause`, `  /goal resume  ` both work). Anything that isn't a recognized subcommand is treated as a new objective with original casing preserved.

## Examples

```
/goal Migrate the user model from SQLAlchemy 1.4 to 2.0; update all callers; tests must pass
```
Goes turn after turn touching files, running tests, fixing failures. Auto-pauses if it hits a rate limit; resumes when you run `/goal resume`.

```
/goal Add full keyboard navigation to the dashboard component; ensure WCAG 2.2 AA conformance
```
The completion audit means it won't declare done until it can point at concrete WCAG criteria coverage, not just "looks good."

```
/goal Bisect the regression in test_auth.py introduced between v1.4.0 and v1.5.2 and open a PR with a fix
```
Long-running multi-tool flow: git, pytest, gh. Survives compactions because the goal context is re-injected every turn.

```
/goal pause
# do something else, then later:
/goal resume
```

## Setup

Two scopes are supported:

- **User scope** (`~/.claude/`) applies to every project on your machine. Recommended.
- **Project scope** (`./.claude/`) is per-repo. Useful if you want different hooks per project, or to commit hook config.

### One-command install

```bash
./install.sh user      # or: ./install.sh project
```

The installer copies the command + 4 hooks, merges hook entries into your `settings.json` (with a diff prompt if it already exists, plus a backup), and adds `.claude/goal.json` etc. to `.gitignore` for project installs.

### Manual install

If you'd rather do it by hand:

```bash
# user scope
mkdir -p ~/.claude/commands ~/.claude/hooks
cp goal.md      ~/.claude/commands/goal.md
cp hooks/*.sh   ~/.claude/hooks/
chmod +x ~/.claude/hooks/*.sh
```

Then merge into `~/.claude/settings.json`. **User-scope hooks must use absolute paths** — Claude Code runs hook commands from the project's working directory, not from `~/.claude/`:

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

For project scope, drop the `$HOME/` prefix. `settings.json.example` ships with project-scope paths.

The state file (`.claude/goal.json`) is per-project regardless of where the hooks live — it's read relative to whatever directory you launch Claude Code in.

### Status line indicator

The helper outputs a single colored segment matching Codex's TUI labels exactly:

| State | Label |
|---|---|
| `pursuing` (no budget) | `Pursuing goal (5m)` |
| `pursuing` (with budget) | `Pursuing goal (12.5K / 50K)` |
| `paused` | `Goal paused (/goal resume)` |
| `achieved` | `Goal achieved (1h23m)` |
| `unmet` *(port-only)* | `Goal unmet (/goal status)` |
| `budget-limited` | `Goal abandoned (50K / 50K)` |

Color: a single magenta (named ANSI 35) for every state — same as Codex, and theme-adaptive (terminals remap named ANSI to be readable on both dark and light backgrounds, so it works on either).

Set `GOAL_STATUSLINE_STYLE=dim` for a softer, reference-style look (`\033[2;35m`), or `GOAL_STATUSLINE_STYLE=plain` for monochrome.

To wire it in, append to your existing statusLine command (typically `~/.claude/statusline-command.sh`):

```bash
if [ -x "$HOME/.claude/hooks/goal-statusline.sh" ]; then
    cwd=$(echo "$input" | jq -r '.cwd // ""')
    sid=$(echo "$input" | jq -r '.session_id // ""')
    goal_seg=$(bash "$HOME/.claude/hooks/goal-statusline.sh" "$cwd" "$sid" 2>/dev/null)
    [ -n "$goal_seg" ] && segments+=("$goal_seg")
fi
```

(Adapt variable names to match your existing script — `$input` is the JSON Claude Code passes to your statusLine, `$cwd` is the session's working directory, `$sid` is the session UUID. Passing `sid` enables sticky goal lookup across `/cwd` shifts via the session pointer file.)

If you don't have a statusLine command yet, set one up via `/statusline` inside Claude Code, or set `statusLine.command` in your `settings.json`.

## Configuration

Everything is opt-in. Default behavior assumes a subscription user who wants the goal to keep moving.

| Setting | Default | What it does |
|---|---|---|
| `GOAL_MAX_TICKS` | `0` (unlimited) | Optional cap on continuation cycles. Set to a positive integer to enable. |
| `GOAL_MAX_SECONDS` | `0` (unlimited) | Optional wall-clock cap. Useful for API-billed runs. |
| `GOAL_AUTOPAUSE_ON_PROMPT` | `0` (off) | Set to `1` for Codex-style "pause on every user input." Default keeps the goal moving across user prompts. |
| `/goal budget <N>` | unset | Token-budget soft stop (advisory; the model updates `tokens_used` per turn). |

Set env vars in your shell or in `~/.claude/settings.json`:

```json
{
  "env": {
    "GOAL_MAX_SECONDS": "86400",
    "GOAL_AUTOPAUSE_ON_PROMPT": "1"
  }
}
```

## Behavior in adverse conditions

The state file lives on disk, independent of conversation context. Most disruptions are transparent:

| Scenario | What happens |
|---|---|
| `/clear` | Conversation cleared; goal persists. Stop hook re-injects the continuation prompt on the next turn. |
| Auto-compaction | Same — compaction summarizes in-context history; goal context is re-injected fresh after compaction. |
| Rate limit / 429 | Notification hook auto-pauses the goal. Run `/goal resume` after recovery. |
| API error / 5xx | Same — Notification hook detects common error patterns and pauses. |
| Session restart | Goal persists. Next time you open Claude Code in the project, the Stop hook fires after your first turn and continuation resumes. |
| Crash / kill | State file is written atomically (`mktemp` + `mv` on the same filesystem); even mid-write crashes don't corrupt `goal.json`. |

## Safety mechanisms

1. **Notification hook** auto-pauses on `rate limit`, `quota`, `overloaded`, 5xx, auth/authorization errors, timeouts.
2. **Kill switch** — `touch .claude/goal.pause` from any terminal halts the loop on the next Stop hook invocation. Remove the file to re-enable.
3. **Optional ceilings** — `GOAL_MAX_TICKS` / `GOAL_MAX_SECONDS` env vars (off by default).
4. **Recursion guard** — the Stop hook respects `stop_hook_active` to prevent tight recursion within a chain.
5. **Atomic state writes** — same-filesystem `mktemp` + `mv` so concurrent or crashed writes can't truncate `goal.json`.
6. **Symlink refusal** — the hook refuses to follow a symlinked `goal.json`.
7. **`goal_id` CAS** — every goal has a UUID stamped on it at create/replace. All hook write paths assert the on-disk `goal_id` still matches the one they read at hook entry; if the goal was replaced mid-flight, the stale write is dropped and logged. Modeled on Codex's `goal_id` versioning in `state/src/runtime/goals.rs`.

### Observability

Each hook invocation appends one JSON line to `.claude/goal-hook.log`:

```bash
tail -f .claude/goal-hook.log
```

```json
{"ts":"2026-05-06T20:15:03Z","pid":12345,"hook":"stop","event":"tick","note":"tick=3 tokens=1200 time=180s"}
{"ts":"2026-05-06T20:18:07Z","pid":12350,"hook":"notify","event":"auto-pause-error","note":"rate limit"}
```

### Threat model

- **Drive-by injection.** A repo with a planted `.claude/goal.json` will inject its objective into the model on the first turn after you `cd` into it (with user-scope hooks). Don't commit `.claude/goal.json` (the included `.gitignore` excludes it). The hook refuses symlinked state files but does trust file *contents* — treat `.claude/` from cloned repos like any other untrusted code.
- **Prompt injection via objective.** The objective text is wrapped in `<untrusted_objective_<random-nonce>>...</untrusted_objective_<random-nonce>>` per turn, and any literal `</untrusted_objective...>` in the objective is stripped. Tag-close escapes are infeasible.

## How it maps to Codex

| Codex piece | This port |
|---|---|
| `/goal` slash command | `.claude/commands/goal.md` |
| App-server runtime continuation (auto-loop) | `.claude/hooks/goal-stop.sh` (Stop hook returning `{"decision":"block"}`) |
| `templates/goals/continuation.md` | Inline content of `goal-stop.sh` |
| `templates/goals/budget_limit.md` | Inline content of `goal-stop.sh` (budget branch) |
| `update_goal` tool | Claude rewrites `.claude/goal.json` via the Write tool |
| Persistent state (app-server) | `.claude/goal.json` on disk |
| Lifecycle states | `pursuing \| paused \| achieved \| unmet \| budget-limited` |
| TUI `Goal paused (/goal resume)` indicator | `.claude/hooks/goal-statusline.sh` (statusLine helper) |
| Pause on `Ctrl-C` interrupt | `.claude/hooks/goal-notify.sh` (Notification hook on rate-limit / API-error) |

The Stop hook is the engine: when a turn ends with `status="pursuing"`, the hook returns `{"decision":"block","reason":"<continuation prompt>"}` and Claude Code forces another turn. Same shape as Codex's app-server, just routed through Claude Code's hook system.

## Differences from Codex `/goal`

| | Codex CLI | This port |
|---|---|---|
| Token tracking | Real, runtime-counted | Advisory; the model updates `tokens_used` per turn (best effort). Off by default. |
| Budget transition | Intra-turn, mid-stream | At the end of the turn that exceeded the budget |
| Auto-pause trigger | Explicit user interrupt (`Ctrl-C` mid-turn) | Notification hook on rate-limit / API errors; opt-in pause-on-every-prompt |
| `unmet` state | Not a Codex state | Used here for hard-blocked goals |
| Subcommands | `pause`, `resume`, `clear` only | Plus `status`, `achieved`, `unmet`, `budget` |
| Status writes | Model can only mark `complete` via `update_goal` tool | Model writes status directly to `.claude/goal.json` (rule-enforced via dispatch instructions; `goal_id` CAS catches stale writes) |
| Multiple concurrent goals | One per thread | One per project (file-based) |
| Hard ceilings | None (runtime-bounded) | Optional, off by default |
| Status-line label | "Pursuing goal", "Goal paused (/goal resume)", "Goal achieved", "Goal abandoned" | **Same wording**, magenta color (single-color match), via `hooks/goal-statusline.sh` |
| Plan mode | Continuation suppressed | No equivalent — Claude Code hooks have no Plan-mode signal |
| Concurrency | `goal_id` CAS in SQL UPDATE; per-thread row | `goal_id` CAS in jq filters; per-project file with same-FS atomic writes |

## File layout (project scope)

```
your-project/
├── .claude/
│   ├── commands/
│   │   └── goal.md              # the slash command
│   ├── hooks/
│   │   ├── goal-stop.sh         # auto-continuation engine
│   │   ├── goal-notify.sh       # auto-pause on rate-limit / API error
│   │   ├── goal-prompt.sh       # opt-in auto-pause on user input
│   │   └── goal-statusline.sh   # statusLine helper
│   ├── settings.json            # hook registration
│   ├── goal.json                # state (gitignored)
│   ├── goal-hook.log            # one JSON line per hook invocation (gitignored)
│   └── goal.pause               # presence = kill switch (gitignored)
└── .gitignore
```

## Troubleshooting

**The goal isn't auto-continuing.** Check that the Stop hook is registered:
```bash
jq '.hooks.Stop' ~/.claude/settings.json    # or .claude/settings.json for project scope
```
You should see one entry pointing to `goal-stop.sh`. If not, re-run `./install.sh`.

**Restart Claude Code.** Hook changes are picked up at session start. After install or settings changes, fully quit and reopen.

**Status line isn't showing the goal.** Confirm:
1. `~/.claude/hooks/goal-statusline.sh` exists and is executable.
2. Your statusLine command parses `cwd` from stdin and includes the snippet from the [Status line indicator](#status-line-indicator) section.
3. There's actually a goal: `cat .claude/goal.json` — the helper outputs nothing when there's no goal.

**The hook fires but does nothing.** Tail the log:
```bash
tail -f .claude/goal-hook.log
```
Common events: `recursion-guard` (within an active continuation chain — normal), `not-pursuing` (status isn't `pursuing` — that's the intended exit), `malformed` (state file is corrupted — `/goal clear` and start over).

**Goal is stuck in a paused state after a rate-limit pause.** Run `/goal resume`. If you want auto-resume after rate-limit recovery, that's not currently possible (Claude Code doesn't expose API-recovery events to hooks).

**Bash 3.2 / `objective's` parse errors.** Already fixed — the heredoc has no apostrophes that bash 3.2 mis-tokenizes. If you're still seeing parse errors, you might be running an older copy. Re-run `./install.sh`.

**Concurrent Claude Code sessions on the same project.** Both Stop hooks will fire on their own turn end and write to the same `goal.json`. Atomic writes prevent corruption, but tick counts can race. Don't expect tight reproducibility under concurrent use.

## Requirements

- `bash` 3.2 or newer (macOS default works; tested against 3.2 and 5.x).
- `jq` on `PATH`. Install via `brew install jq` (macOS) or `apt-get install jq` (Linux).
- On Windows: run via WSL, or rewrite the hooks in PowerShell / Python.

## Contributing

Issues and PRs welcome. The codebase is intentionally small (4 hooks, 1 slash command, 1 installer) and audit-driven — see commit history for the design rationale.

## Source attribution

The continuation and budget-limit prompts are adapted from [`codex-rs/core/templates/goals/`](https://github.com/openai/codex/tree/main/codex-rs/core/templates/goals) in the Codex repository. Lifecycle states and the `<untrusted_objective>` framing follow the same source (with a per-turn random nonce added for prompt-injection hardening).

## License

[MIT](LICENSE).
