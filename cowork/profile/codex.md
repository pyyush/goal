# Codex

Capability card for the Codex (OpenAI `codex-cli`) runner in the /goal cowork
subsystem. Written for spec §5.6.

This card was **rewritten with sourced facts** after spec §18 Q1/Q2 research.
Original assumption-heavy version (P2) replaced. Sources are listed at the
bottom; verify against current upstream docs before relying on edge cases.

---

## Surface

**CLI, two modes:**

- **Interactive TUI** — `codex` (no subcommand). Long-lived terminal UI.
  Not used by the cowork bridge.
- **Headless / non-interactive** — `codex exec`. Runs a single task to
  completion, emits events to stdout/stderr, exits when the agent says the
  task is done. **This is the mode the cowork bridge uses.**

Codex is also bundled as a desktop / IDE extension, but the cowork primitive
is the CLI's `exec` mode.

---

## Session model

**One-shot per `codex exec` invocation.** Each `codex exec [PROMPT]` call
starts a session, runs to completion, and exits. There is **no long-lived
stdin-streaming session model** for cowork to push prompts into.

**Continuation across turns** is done via session resume:

- `codex exec resume --last` — resume the most recent session in the cwd.
- `codex exec resume <SESSION_ID>` — resume by UUID. Add `--all` to look
  across cwds.

Resume re-invokes with prior conversation context preserved and accepts a
new instruction (either as the prompt argument or via stdin with `-`).

**Implication for the bridge:** the cowork loop for Codex is **spawn a fresh
`codex exec resume <sid> --json -` process per continuation turn**, with the
new prompt piped on stdin. Not stdin-injection into a live process.

---

## Edit semantics

Codex applies file edits via its own tool calls inside the sandbox set by
`--sandbox` (default: `workspace-write`). Sandbox modes:

- `read-only` — Codex cannot mutate the workspace.
- `workspace-write` — edits limited to the workspace root.
- `danger-full-access` — no sandbox; full filesystem + network. Avoid.

**No auto-commit.** The user (or another agent) is responsible for `git add`
/ `git commit`. Each `exec` run leaves edits in the working tree.

`--ephemeral` skips persisting session files; useful for one-off runs but
breaks the resume model. Cowork should not use `--ephemeral`.

`--ignore-rules` and `--yolo` (a.k.a.
`--dangerously-bypass-approvals-and-sandbox`) **must not** be set by the
bridge — those bypass safety controls.

---

## Tool inventory

Built-in tools available to a `codex exec` run:

- File read/write/edit (sandboxed per `--sandbox`).
- Shell command execution (sandboxed).
- Web search.
- Plan / reasoning emission (visible as `item.*` events in `--json` mode).
- Image attachment via `--image PATH[,PATH...]` (input only).

**MCP integration: Codex is an MCP client, not a server.**

- Codex consumes external MCP servers configured in
  `~/.codex/config.toml` or via `codex mcp add <name>`.
- Both STDIO and Streamable HTTP transports are supported.
- Codex does **not** expose its own MCP server interface — there is no
  inbound push channel for another agent to send prompts or tool calls.
  This is the definitive answer to spec §18 Q2.

**Cowork-relevant consequence:** the only way to drive Codex from outside
is process spawning. The /goal MCP server (`mcp/goal-server.ts`) can be
registered with Codex as one of its MCP servers — that gives Codex access
to `get_goal` / `update_goal` / `create_goal` while it runs — but the
bridge's continuation prompts still flow via fresh `codex exec resume`
invocations, not via MCP push.

---

## Failure signals

**Use `codex exec --json` and parse the NDJSON event stream.** This is the
structured signal spec §18 Q1 was asking about; it exists.

Documented event types from `--json`:

| Event | Meaning |
|-------|---------|
| `thread.started` | Session begins. Includes `session_id`. |
| `turn.started` | Codex begins a reasoning + tool-use turn. |
| `turn.completed` | Turn finished cleanly. Payload includes `usage.{input_tokens, cached_input_tokens, output_tokens}` for token accounting. |
| `turn.failed` | Turn failed. **Primary rate-limit + 5xx signal.** |
| `error` | Out-of-band error. |
| `item.*` | Streaming items (agent message, command exec, file change, MCP call, web search, plan update, …). |

**Rate limit (429):** detected via `turn.failed` or `error` events. The
event payload contains the upstream error description; pattern-match on the
payload (`429`, `rate_limit`, `Too Many Requests`) for classification.
Codex itself **does not document a dedicated exit code** for rate limits —
the process exits non-zero on submission failure but the same exit happens
for auth, network, MCP-server errors, etc. **Don't rely on exit code
alone; parse the event stream.**

**Server errors (5xx):** same approach. `turn.failed` with a 5xx-shaped
payload.

**Quota visibility outside an active session:** Codex enforces a dual
window — 5-hour and weekly. Inside an interactive session, the `/status`
slash command shows remaining limits. Outside an active session there is
no documented programmatic quota query. The bridge cannot pre-check
headroom; it must **probe by attempting a turn and reading the failure**.

**Timeout / hang:** no built-in signal documented. The bridge's heartbeat
TTL (15s default per spec §3 N4 + §5.5) is the fallback for stalled
sessions.

---

## Continuation mechanism

**Spawn-per-turn with `codex exec resume`.** No stdin streaming, no MCP
push.

For the first turn of a Codex-driven session:

```
codex exec --json [-c key=value ...] [PROMPT]
```

Capture the `session_id` from the first `thread.started` event and persist
it in `.goal/agents/<agent_id>.json` (extending §5.7 with a
`runner_session` field is reasonable; the bridge already writes this file).

For each subsequent turn:

```
echo "<continuation prompt>" | codex exec resume <session_id> --json -
```

Per-turn flags the bridge should set:

- `--json` — required. The bridge consumes the NDJSON stream.
- `--sandbox workspace-write` — explicit, don't drift to default.
- `--cd <project root>` — set workspace root explicitly.
- `--ignore-user-config` — optional but reduces variance across user
  installs. Only set if the goal uses a per-project profile.

The bridge:

1. Spawns the resume invocation with the continuation prompt on stdin.
2. Tails stdout (`--json` events) line by line.
3. On `turn.completed` — accumulate `usage.output_tokens` into the goal's
   token budget; check status; either schedule the next tick or transition.
4. On `turn.failed` / `error` — write `.goal/agents/<id>.fault` (P2
   plumbing). The relay logic (P3) reads the fault and decides whether to
   transition the goal to `relaying`.
5. On process exit — if the agent self-terminated cleanly (last event was
   `turn.completed` with the agent's "done" signal), let it. Otherwise
   treat as fault.

**P2 status:** The bridge currently writes JSONL prompt records to
`.goal/agents/<id>.continue` as a placeholder. P3 replaces that with the
spawn-per-turn loop above.

---

## Open follow-ups for P3

- Confirm the exact `turn.failed` payload shape on a real 429 (the docs
  describe the event but don't give a sample payload). Plan: capture one
  during P3 development by deliberately exhausting a low-quota dev account,
  or by mocking the OpenAI endpoint.
- Decide whether to register the /goal MCP server with Codex by default
  during install, or leave it as a manual `codex mcp add`. P5 install-flow
  question; not needed for P3.
- Settle on the per-turn sandbox policy. `workspace-write` is the safe
  default; some advanced cowork flows may want `read-only` for review-role
  ticks (see §5.5 `roles.review`).

---

## Sources

Verified against OpenAI's developer docs as of 2026-05-11.

- [Codex CLI overview](https://developers.openai.com/codex/cli)
- [Non-interactive mode (`codex exec`)](https://developers.openai.com/codex/noninteractive)
- [Command line options reference](https://developers.openai.com/codex/cli/reference)
- [Model Context Protocol (Codex MCP usage)](https://developers.openai.com/codex/mcp)
- [Pricing & usage limits (5-hour + weekly window)](https://developers.openai.com/codex/pricing)
- [Configuration reference](https://developers.openai.com/codex/config-reference)
