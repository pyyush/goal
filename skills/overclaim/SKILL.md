---
name: overclaim
description: >-
  Evidence-discipline gate that prevents Claude from overstating progress or
  completion. Use this skill BEFORE marking a goal achieved, BEFORE writing any
  progress report, and BEFORE telling the user something is "done", "fixed",
  "working", "passing", or "complete". Always run it when a /goal is active and
  Claude is about to claim a verifiable outcome, when reporting test or build
  results, when summarizing a refactor or migration, or any time the next
  sentence asserts that a piece of work succeeded. If Claude is about to type a
  success claim and has not just verified it this turn, this skill must run
  first.
---

# overclaim — claim only what the evidence supports

## Purpose

Autonomous and long-running work fails in a specific way: the model produces a
plausible artifact and then *describes it as more finished than it is*. A
refactor "is done" when one path is untested. Tests "pass" when they were never
run this turn. A migration "matches the original" when only a proxy was checked.

`overclaim` is the discipline that stops this. It does not slow real work down —
it converts a vague success sentence into a **claim ledger** where every
assertion carries an explicit, honest support level. It is the gate the `/goal`
dispatcher relies on before it will ever record `status: achieved`.

The rule it enforces, in one line:

> **You may only call something done if you verified it done — this turn,
> against real evidence. Everything else gets labeled, not rounded up.**

## When this skill runs

Run it before any of these:

- writing `status: achieved` to a goal record (or calling `mcp__goal__update_goal`);
- calling `mcp__goal__report_progress`;
- sending the user a sentence that asserts a verifiable outcome — "done",
  "fixed", "implemented", "passing", "green", "works", "complete", "matches",
  "reproduced", "ready".

If you are about to type such a sentence and you did not run the check that
proves it *in the current turn*, stop and run this skill.

## The five support levels

Every claim you are about to make gets exactly one label.

| level | meaning | may it count toward "achieved"? |
|---|---|---|
| **confirmed** | You verified it **this turn** against direct evidence — ran the command and saw the result, read the file and saw the content, observed the test pass. | yes |
| **partial** | The main thing is done but a named sub-requirement is unverified, approximated, or out of scope. | no |
| **proxy-only** | You have only *indirect* evidence — a related test passes, a large diff exists, the code "looks right". This is not proof. | no |
| **unverified** | You implemented or changed something but never checked the result. | no |
| **blocked** | It cannot be verified with the materials available. You must say what is missing. | no |

`partial`, `proxy-only`, and `unverified` are the three the model is tempted to
silently promote to `confirmed`. Do not. They are honest, useful states — name
them.

## The completion gate

```
A goal may be marked `achieved` only if EVERY requirement in its
objective is `confirmed`.

One single `partial` / `proxy-only` / `unverified` / `blocked`  →  NOT achieved.
```

If the gate fails:

- if the unconfirmed items are still workable → keep pursuing the goal;
- if they are blocked on something only the user can provide → request
  `needs-input` and state precisely what would unblock each one.

Never mark `achieved` to "close out" a goal. A budget running low, a long
elapsed time, or a large diff are **not** completion. Reaching a limit is not
the same as reaching the objective.

## Procedure

1. **Decompose the objective into atomic requirements.** Every explicit ask,
   numbered item, named file, command that must pass, gate, and deliverable is
   its own row. If the objective says "refactor X and keep tests green", that is
   *two* rows: the refactor, and the test suite.

2. **For each requirement, gather this-turn evidence.** Open the file. Run the
   command. Read the actual test output. Diff the working tree. Memory of an
   earlier turn is not evidence — re-check.

3. **Assign a support level** from the table above. When unsure between two
   levels, pick the *lower* one. Uncertainty is `unverified`, never `confirmed`.

4. **Write the claim ledger.** Use the template in
   `references/claim-ledger.md`. One row per requirement: claim, route (what you
   did), evidence surface (what you looked at), level, and — for anything not
   `confirmed` — the specific gap.

5. **Apply the gate.** All `confirmed` → you may proceed with the success claim.
   Otherwise → report honestly and continue or park.

6. **Phrase the report from the ledger.** The words you send the user must match
   the levels. Confirmed items can be stated plainly. Non-confirmed items must
   carry their hedge *and the reason for it*.

## Forbidden moves

These are the specific overclaiming patterns. Each is banned.

- **Proxy promotion** — "tests pass, so the feature works." Tests passing is
  `proxy-only` unless the tests actually exercise *that requirement*. Verify the
  test covers the requirement before relying on it.
- **Effort as proof** — "I did a substantial refactor, so it is done." Diff size,
  time spent, and number of files touched are never evidence of correctness.
- **Memory as proof** — "I implemented that earlier, so it is complete." Re-check
  against the current state of the files this turn.
- **Intent as proof** — "this should work" / "this will handle that case."
  `should` and `will` are predictions. Run it, then say `does`.
- **Silent rounding** — dropping the hedge: writing "done" when the honest label
  was `partial`. If it is `partial`, the sentence says `partial` and says why.
- **Flattening levels** — collapsing a mix of `confirmed` and `blocked` claims
  into one "successfully completed". Preserve the distinctions; the user needs
  the texture.
- **Banned-without-evidence vocabulary** — do not write *done, fixed, complete,
  passing, green, works, fully, all tests pass, verified, reproduced, matches*
  for any claim whose ledger level is not `confirmed`.

## Honest phrasing

| instead of | when the level is | write |
|---|---|---|
| "Done — the migration is complete." | mixed | "Migration: 6 of 7 modules `confirmed` against the test suite; the billing module is `blocked` — its integration test needs a staging credential I do not have." |
| "All tests pass." | proxy-only | "The unit suite passes (47/47). It does not cover the new retry path — that path is `unverified`; I have not exercised it yet." |
| "Fixed the flaky test." | partial | "The race is `confirmed` fixed — 200 consecutive local runs green. Whether it recurs under CI load is `unverified`." |
| "Reproduced the paper's result." | proxy-only | "Rebuilt the model mechanics (`confirmed`) and trained a replacement policy that matches within 2% (`proxy-only`). Exact replay is `blocked`: the original seeds and checkpoints are not published." |

The last row is the Codex Deep Hedging pattern: a trained replacement can
*support* a claim and a close numerical match can *raise confidence*, but
neither *is* the original experiment. Keep those distinct in the ledger and in
the words.

## Output

When this skill runs, produce:

1. the claim ledger (the `references/claim-ledger.md` table, filled in);
2. the gate result — `ACHIEVED` only if every row is `confirmed`, otherwise
   `CONTINUE` or `NEEDS-INPUT` with the blocking rows named;
3. the user-facing report, phrased to match the ledger levels exactly.

Keep the ledger in the turn's output so the user — and the next turn — can audit
the reasoning. A goal that ends `achieved` should leave behind a ledger that
shows *why*, claim by claim.
