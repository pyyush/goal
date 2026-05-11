# Claude Code

Capability card for the Claude Code runner in the /goal cowork subsystem.
Written for spec §5.6. Used by `goal-bridge` and the relay protocol to understand
how this runner operates.

---

## Surface

**CLI + desktop + IDE + web.**

Claude Code runs as a CLI (`claude`) and integrates into desktop editors (VS Code,
JetBrains, etc.) and the claude.ai web interface. The /goal plugin targets the CLI
surface; the Stop hook fires at the end of every assistant turn.

**Session model:** per-conversation continuity. A single Claude Code session
corresponds to one conversation thread. Tool calls, file reads, and bash outputs
are all in-context for that thread. Sessions are ephemeral — model state does not
persist across separate `claude` invocations, but the goal state file (`.goal/state.json`)
and filesystem artifacts do persist and provide continuity.

---

## Edit semantics

Claude Code edits files using the built-in Edit/Write/Read tools. Edits are applied
directly to the working tree.

- **No auto-commit.** The model uses the Bash tool to invoke `git` explicitly when
  a commit is needed. No implicit staging or auto-commit happens on behalf of the model.
- **Atomic file edits.** The Edit tool performs atomic in-place replacements. The Write
  tool overwrites files. Neither stages to git.
- **Bash tool** is used for `git add`, `git commit`, `git push`, test runners,
  package managers, and any other shell command.

---

## Tool inventory

Tools available to Claude Code during a /goal session:

| Tool | Description |
|------|-------------|
| `Bash` | Run shell commands with full environment (node, jq, git, npm, etc.) |
| `Read` | Read file contents (absolute paths) |
| `Edit` | Exact string replacement in files |
| `Write` | Create or overwrite files |
| `MCP tools` | Any MCP servers configured in the session (including /goal's own MCP server) |
| `/goal MCP tools` | `create_goal`, `update_goal`, `get_goal` — model-side state access |

The `/goal` Stop hook and MCP server are the primary cowork primitives for Claude Code.
The Stop hook fires at the end of every turn and drives continuation via the `decision: block`
mechanism (see §7 B2 for how the bridge interacts with this).

---

## Failure signals

**Rate limit (429):**
- Surfaces in the Claude API response as a 429 HTTP error.
- Claude Code CLI surfaces this as an error message in the turn output — typically
  text like "Too Many Requests" or "rate limit exceeded" in the assistant's response
  or the tool error output.
- **Does NOT appear as a clean 429 line to the bridge's runner stderr** — the Claude
  Code process itself does not exit with a parseable 429 stderr line the way a raw
  HTTP client would.
- TODO: How the bridge (`goal-bridge claude-code`) detects a rate limit for the local
  Claude Code runner is TBD. Options: (a) parse the bridge's own log for 429 patterns
  in tool error JSON, (b) watch for the model writing a special marker, (c) monitor
  the session transcript for rate-limit messages. This is an open design question for
  P3 — the `rate_limit` patterns in `patterns.json` apply to stderr of the spawned
  child, which for Claude Code is not the primary signal channel.

**Server errors (5xx):**
- Same channel as 429 — appear in turn output / API error, not raw stderr.
- The bridge's `server_error` stderr patterns may catch some cases if the CLI
  prints raw HTTP status codes to stderr, but this is not guaranteed.

**Timeout / hang:**
- No built-in timeout signal. The Stop hook ceiling (`GOAL_MAX_SECONDS`) is the
  configured safety valve.

---

## Continuation mechanism

**Stop hook** (`hooks/goal-stop.sh`).

The Stop hook fires at the end of every assistant turn. If `status === "pursuing"`,
it emits a `decision: block` JSON response that forces Claude Code into another turn
with a continuation prompt. This is the canonical continuation mechanism for Claude Code.

The bridge's B2 continuation write (`.goal/agents/<id>.continue`) is a P2 placeholder.
For Claude Code running locally, the Stop hook already handles continuation. The
`.continue` file is intended for P3 integration when two agents handoff across sessions.

**Interaction with goal-bridge:**
- `goal-bridge claude-code` watches `.goal/state.json`. When `current.agent` is set
  to this bridge's agent_id, it writes to `.continue` (P2 placeholder per §7 B2).
- In a typical solo Claude Code workflow, `goal-bridge` is not needed — the Stop hook
  handles everything. The bridge becomes relevant only in cowork mode where Codex or
  another agent needs to detect that Claude Code has stalled or rate-limited.
