# goal-mcp-server

MCP server component of the **goal** plugin. A small Node + TypeScript server that exposes the `/goal` lifecycle as **native model-side tools** so Claude Code (and Claude Desktop) can call them as structured tool uses rather than writing `goal.json` via the generic `Write` tool.

Tools exposed (namespace as seen by the model: `mcp__goal__*`):

| Tool          | Purpose                                                                                                |
| ------------- | ------------------------------------------------------------------------------------------------------ |
| `create_goal` | Create a goal. Fails if a `pursuing` or `paused` goal already exists. Generates a fresh UUIDv4 `goal_id`. |
| `update_goal` | Mark the current goal `achieved`. Only `status: "complete"` is valid (asymmetric on purpose).            |
| `get_goal`    | Return the current goal state plus computed `remaining_tokens` and `elapsed_seconds`.                    |

The server reads and writes `.claude/goal.json` at the **goal root** with the same on-disk schema as `bin/goalctl`. Hooks, `goalctl`, and this MCP server share one source of truth.

## Install (local build)

```bash
cd mcp
npm install
npm run build      # emits dist/goal-server.js
```

## Register with Claude Code CLI and Claude Desktop

Both surfaces read `~/.claude.json`. Add an `mcpServers.goal` entry:

```jsonc
{
  "mcpServers": {
    "goal": {
      "command": "node",
      "args": ["/absolute/path/to/goal/mcp/dist/goal-server.js"]
    }
  }
}
```

Or, if you prefer running directly from a published npm package once available:

```jsonc
{
  "mcpServers": {
    "goal": {
      "command": "npx",
      "args": ["-y", "goal-mcp-server"]
    }
  }
}
```

After editing, restart Claude Code (CLI) or quit and reopen Claude Desktop.

### Verifying the server is wired up

In a Claude Code session, the model should now see tools `mcp__goal__create_goal`, `mcp__goal__update_goal`, and `mcp__goal__get_goal`. From the host shell you can confirm the server starts cleanly:

```bash
node /absolute/path/to/mcp/dist/goal-server.js < /dev/null
# (it will sit waiting for stdio input; Ctrl-C to exit)
```

## Goal-root discovery

Order, mirrors the bash `hooks/goal-resolve.sh`:

1. `GOAL_ROOT` env var if set (use to pin the root in CI/testing).
2. Walk up from `process.cwd()` to the nearest enclosing `.claude/goal.json`, stopping at `$HOME`.
3. `$HOME/.claude/goal-sessions/<session_id>.goal` pointer file (resolved via `CLAUDE_SESSION_ID` or `GOAL_SESSION_ID`).
4. For `create_goal`, fall back to `process.cwd()`. For `update_goal` / `get_goal`, return a structured `no_active_goal` error.

## Correctness rules (also enforced by tests)

- Every write is **atomic**: write to `tmp/goal.json.tmp` in `.claude/`, fsync, then `rename(2)` to `goal.json`.
- Every write is preceded by an exclusive **lock** on `.claude/` via `proper-lockfile` (stale 30 s).
- Every write **CAS-checks `goal_id`**: if it shifted between read and re-read under the lock, `update_goal` returns `goal_id_mismatch`.
- Lifecycle transitions emit a JSONL line to `.claude/goal-events.jsonl` (`goal.created`, `goal.completed`).

## Structured error codes

`create_goal` / `update_goal` / `get_goal` may return `{ error: { code, message, details? } }` in the tool result with one of:

- `no_active_goal`
- `goal_exists_and_active`
- `goal_id_mismatch`
- `invalid_input`
- `file_lock_failed`
- `io_error`

## Debug logging

`stdout` is the MCP transport. Diagnostics go to `stderr` only when `GOAL_MCP_DEBUG=1` is set.

## Coordination with hooks and `goalctl`

This server does not modify hooks, the slash command, or `goalctl`. Behavior on disk is wire-compatible with the existing bash implementation. If the MCP server is unavailable, the hook-based flow continues to work (degraded: no native tools).
