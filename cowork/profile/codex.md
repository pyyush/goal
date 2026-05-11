# Codex

Capability card for the Codex runner in the /goal cowork subsystem.
Written for spec §5.6. This card distinguishes between what is **known**,
what is **assumed**, and what is **unknown (TODO)** — do not treat the TODO
sections as implemented. Surface Q1/Q2 answers to eng-lead before P3 ships.

---

## Surface

**CLI (`codex-cli`).**

Codex runs as a command-line process. The bridge (`goal-bridge codex`) spawns it
as a child process and monitors its stderr for failure signals.

**Session model: TBD (Q2).**

**TODO (Q2):** Does each `codex` invocation represent a stateless one-shot prompt,
or does it maintain an in-process conversation thread across turns? The answer affects
how the continuation mechanism works (append-prompt-and-re-invoke vs. push-into-live-session).
See spec §18 Q2. Do not assume either model until confirmed.

*Current assumption (provisional, may be wrong):* Codex CLI is invoked once per goal
session and keeps an interactive conversation open on stdin. The bridge monitors stderr
and injects continuation prompts via stdin. This assumption drives the P3 design; it
is flagged here so it can be corrected when Q2 is answered.

---

## Edit semantics

**TBD.**

**TODO (Q2):** Does Codex apply file edits atomically? Does it auto-stage or auto-commit?
Does it use patch-apply semantics, full rewrites, or something else? This affects lane
lease conflict detection (P5) and rollback safety.

*Current assumption:* Codex edits files via its own tool calls. No auto-commit assumed.
Actual behavior should be verified against the codex-cli docs/source before P3 ships.

---

## Tool inventory

Tools available to Codex during a /goal session are **TBD** pending codex-cli docs review.

Known/assumed:
- File read/write (likely similar to Claude Code's Edit/Write)
- Shell command execution (likely similar to Bash tool)
- **No `/goal` MCP server integration assumed** — the bridge (`goal-bridge codex`) is the
  cowork primitive for Codex, not a shared MCP server. If Codex gains MCP support this
  card should be updated.

**TODO (Q1/Q2):** Confirm full tool list and whether any MCP push channel is exposed
at runtime. See spec §18 Q1 + Q2.

---

## Failure signals

**Rate limit (429):**

*Primary signal (P2 default):* stderr regex matching. The bridge watches the Codex
process stderr for patterns in `cowork/bridge/patterns.json`:
- `429`
- `rate ?limit` (case-insensitive)

When matched, the bridge writes `.goal/agents/<agent_id>.fault` with `kind: "rate_limit"`.

**TODO (Q1):** Does Codex expose a structured 429/5xx signal — e.g. a specific exit code,
a JSON object on stderr, or a dedicated error channel — or does the bridge rely entirely
on the stderr regex approach? A structured signal would make detection more robust and
less prone to false positives from user-generated output that happens to contain "429".
Answer must be known before P3 ships relay logic that acts on this fault.
See spec §18 Q1.

**Server errors (5xx):**

Same stderr regex approach. Patterns:
- `5\d{2}` (matches 500, 502, 503, etc.)
- `internal server error`

**TODO (Q1):** Same structured-signal question as for 429. If Codex writes a JSON error
envelope on exit, that should be preferred over regex matching.

**Timeout / hang:**
- No built-in signal known yet. The bridge's heartbeat TTL (default 15s, per spec §3 N4)
  is the fallback mechanism for detecting a stalled Codex session.

---

## Continuation mechanism

**TODO (P3 + Q1/Q2):** Not implemented in P2. The P2 bridge writes a JSONL line to
`.goal/agents/<agent_id>.continue` as a placeholder. Real injection is deferred to P3.

The intended P3 mechanism (provisional — subject to Q1/Q2 answers):

**Option A — stdin injection** (assumed for P3 planning):
When the bridge detects `status: pursuing` and `current.agent` matches its own agent_id,
it writes a continuation prompt to the Codex process stdin. This requires that the Codex
process keeps stdin open in an interactive loop (see Q2 session model assumption above).

**TODO (Q1):** Is stdin injection the right channel? If Codex exposes an MCP push
endpoint or JSON-RPC interface at runtime, that would be preferable (lower latency,
structured, bidirectional). Confirm before implementing P3 injection.

**TODO (Q2):** If the Codex session model is one-shot (each invocation is independent),
stdin injection is not applicable. Instead, continuation would require re-invoking
`codex` with the continuation prompt prepended to the context. The bridge would need to
manage session state externally (e.g. a transcript file). Confirm session model before P3.

**P2 behavior (current):**
The bridge appends a JSONL line to `.goal/agents/<agent_id>.continue` containing:
```json
{
  "ts": "<ISO-8601>",
  "agent_id": "<id>",
  "trigger": "state-change",
  "status": "pursuing",
  "session": null,
  "objective": "<first 200 chars>"
}
```
P3 reads this file and performs actual delivery via whichever mechanism Q1/Q2 resolve to.
