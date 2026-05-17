# Goal spec — field rubric and template

The artifact `goalframe` produces. Written into the goal record as `spec`.
Keep it compact: the continuation dispatcher re-reads it, so every wasted
sentence is a recurring token cost.

## Template

```json
{
  "title":        "<imperative, <= 80 chars, no newlines, no <...> >",
  "outcome":      "<what is TRUE when done>",
  "verification": "<the command / test / artifact that PROVES it>",
  "constraints":  "<what must NOT regress>",
  "boundaries":   "<what may be touched>",
  "iteration":    "<how to pick the next action>",
  "blocked_when": "<when to stop and report instead of pushing on>",
  "assumptions":  ["<inferences made instead of asking>"]
}
```

## Per-field rubric

**title** — what a human glances at to know the run. Imperative voice ("Cut",
"Migrate", "Make ... pass"). It is injected verbatim into every continuation
prompt, so it must be a single clean line: no newlines, no `<tag>`-like
sequences, ≤ 80 chars. This field is why the loop can continue without
re-pasting the whole objective.

**outcome** — a state, not an activity. "p95 < 120 ms" not "work on latency".
If you cannot phrase it as something that is either true or false, the goal is
not yet shaped — keep framing or send it back as not-a-goal.

**verification** — the single most important field. Name the *concrete* thing
that settles it: a command and its pass condition, a benchmark and a threshold,
an artifact and a property. "Tests pass" is weak — *which* tests, and do they
exercise the outcome? This field is the surface `overclaim` audits every claim
against; if it is vague, completion can never be checked.

**constraints** — the guardrails. Usually "existing passing tests stay green"
and "public API / observable behavior unchanged" unless the objective is itself
a behavior change. State what a correct-but-reckless change would break.

**boundaries** — scope of allowed edits. Prefer the narrowest true scope: the
module the objective names, its tests, its fixtures. Whole-repo boundaries are a
smell — they usually mean the outcome is too broad.

**iteration** — the loop policy. A good default: "after each change, run
<verification>, record what changed and what it showed, then choose the next
action from that result; keep edits minimal and targeted." This is what keeps a
long run from thrashing.

**blocked_when** — the honest stop. When should the model park to `needs-input`
rather than grind? Typical: "the verification surface cannot run", "a required
credential / dataset / decision is missing", "no defensible next action remains
under the boundaries". A goal with no `blocked_when` will either spin or
overclaim when it hits a wall.

**assumptions** — every gap you filled by inference instead of asking. This is
what lets the user correct the framing with a single reply instead of an
interview.

## Inference defaults (use these instead of asking)

| missing | infer |
|---|---|
| verification | the repo's existing test or build command (`package.json` scripts, `Makefile`, CI config) |
| constraints | "existing passing tests stay green; public API unchanged" |
| boundaries | the directory/module named in the objective |
| iteration | "change → run verification → record result → pick next action" |
| blocked_when | "verification cannot run, or no defensible next step remains in scope" |

Only ask the user when a gap is genuinely unguessable AND changes what gets
built — most often a missing or ambiguous `verification`, or an `outcome` that
forks into materially different deliverables.

## Worked example

Raw objective: `migrate the storage layer to the new async client and keep
everything working`

```json
{
  "title": "Migrate storage layer to the async client",
  "outcome": "all storage call sites use the async client; legacy sync client is unreferenced",
  "verification": "`npm test` green (213 tests) AND `grep -r SyncStore src/` returns no hits",
  "constraints": "no public API change to the storage module; existing tests stay green",
  "boundaries": "src/storage/ and its tests; call sites elsewhere only where they invoke storage",
  "iteration": "migrate one call site or module, run the storage tests, commit, pick the next from the grep list",
  "blocked_when": "the async client lacks an equivalent for a sync API in use, or tests need infra not available locally",
  "assumptions": [
    "verification suite is `npm test` (from package.json)",
    "'everything working' means the existing test suite, not a manual QA pass"
  ]
}
```

This spec is narrow enough to audit (two concrete checks) and broad enough to
let the model choose call-site order. The two assumptions are exactly the
things the user can correct in one line if the inference was wrong.
