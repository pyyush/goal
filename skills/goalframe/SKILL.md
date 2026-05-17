---
name: goalframe
description: >-
  Turn a raw, vague, or oversized objective into a structured, verifiable goal
  spec BEFORE a /goal record is written. Always run this skill first whenever a
  user runs `/goal <objective>`, sets a durable multi-turn objective, or asks
  Claude to "keep working until" something is done. It produces the six things a
  goal needs to be pursuable and auditable — outcome, verification surface,
  constraints, boundaries, iteration policy, blocked-stop condition — plus a
  short title. Run it even when the objective looks clear: an unframed goal is
  the single biggest reason long runs drift, never converge, or get marked done
  too early. Do not write a goal record without a spec from this skill.
---

# goalframe — give the objective a shape before it becomes a goal

## Purpose

A one-off prompt can be vague — the user is right there to course-correct. A
goal cannot. It runs across many turns with no one steering, so it needs to
carry, in itself, everything required to (a) pick the next action, (b) know what
"done" means, and (c) know when to stop and ask. Raw objectives almost never do.
"Improve performance" has no finish line. "Refactor the auth module" has no
verification surface. "Make the app better" is not a goal at all.

`goalframe` converts a raw objective into a **goal spec**: six fields plus a
title. It is the entry-side counterpart to `overclaim` (the exit-side gate). The
two share one contract — the `verification` field this skill writes is exactly
what `overclaim` later audits claims against. Frame the goal well here and the
completion check downstream becomes mechanical.

This is also what makes the goal loop **token-efficient**. The spec is written
to the goal record once. The continuation dispatcher then drives the run by
*referencing* that record, not by re-pasting the objective every turn — so the
spec must be compact: each field one or two sentences, the title ≤ 80 chars. A
tight spec is cheap to re-read; a rambling one is not.

## When this runs

Before writing any goal record — i.e. inside `/goal <objective>` and before
`mcp__goal__create_goal`. It runs on the raw objective and emits the `spec`
object the goal record will store. It does **not** write the record itself.

## A goal spec — the six fields plus a title

| field | what it pins down | Codex term |
|---|---|---|
| `title` | one imperative line, ≤ 80 chars, no newlines — used in every continuation prompt | — |
| `outcome` | what must be **true** when the work is done | Outcome |
| `verification` | the test, command, benchmark, artifact, or source that **proves** it | Verification surface |
| `constraints` | what must **not** regress or change while the goal runs | Constraints |
| `boundaries` | which files, dirs, tools, services the goal **may** touch | Boundaries |
| `iteration` | how to choose the **next action** after each attempt | Iteration policy |
| `blocked_when` | the condition under which to **stop and report** rather than push on | Blocked stop condition |

The canonical sentence these fields assemble into (Codex's pattern):

> `<outcome>`, verified by `<verification>`, while preserving `<constraints>`.
> Use only `<boundaries>`. Between iterations, `<iteration>`. If `<blocked_when>`,
> stop and report the attempted paths, the evidence, the blocker, and the input
> needed.

## Procedure

1. **Classify the objective.**
   - *Not a goal* → see "When the objective should not become a goal". Tell the
     user, suggest a plain prompt, and stop.
   - *Workable* → continue.

2. **Draft all six fields.** Infer aggressively from the objective and the repo
   — read `package.json`, test config, CI files, an existing `PLAN.md` — rather
   than asking. Sensible inference defaults:
   - `verification`: the repo's existing test/build command, if one exists.
   - `constraints`: "existing passing tests stay green; public API unchanged"
     unless the objective implies otherwise.
   - `boundaries`: the directory or module the objective names; the whole repo
     only if it genuinely spans everything.
   - `iteration`: "after each change, run the verification command, record what
     changed and what it showed, then pick the next action from the result."
   - `blocked_when`: "the verification surface cannot run, or no defensible next
     action remains under the stated boundaries."

3. **Ask at most once — only for genuinely unguessable gaps.** If there is no
   verification surface and none can be inferred, or the outcome is ambiguous in
   a way that changes what to build, ask one tight batch of questions. Never
   nag, never ask what the repo already answers. If the user wants to skip,
   proceed with explicit assumptions recorded in the spec.

4. **Tighten.** A spec is right when it is *narrow enough to audit but broad
   enough to let the model choose the next action*. "Fix the failing checkout
   test" may be too narrow if the cause is upstream; "improve the system" is too
   broad — no audit surface. "Make the checkout suite pass on this branch
   without changing public API behavior" is the band you want.

5. **Emit the spec** (see Output contract). Keep every field compact.

## When the objective should not become a goal

Tell the user and recommend a normal prompt instead when the objective is:

- a one-line edit, a single explanation, or a short review — one ask, one answer;
- vague with no possible finish line — "make it better", "clean this up" — with
  no test, artifact, or condition that could prove completion;
- a loose bag of unrelated tasks — that is a backlog, not a goal.

Goals earn their overhead only when the task has a durable objective, an
evidence-based finish line, and a path that needs several turns of investigation.

## Weak → strong

| weak objective | reframed spec (abridged) |
|---|---|
| `improve performance` | **title** Cut p95 checkout latency below 120 ms · **outcome** p95 < 120 ms on the checkout benchmark · **verification** `bench/checkout` p95 metric · **constraints** correctness suite stays green · **boundaries** checkout service + its fixtures/tests · **iteration** profile, change the hot path, rerun bench + suite, keep edits minimal · **blocked_when** the benchmark cannot run |
| `write docs for this feature` | **title** Document the Goals feature · **outcome** a Goals docs page covering lifecycle, commands, two examples · **verification** the page builds locally; every referenced command matches current CLI behavior · **constraints** existing docs nav unbroken · **boundaries** `docs/` · **iteration** draft a section, build, check commands, next section · **blocked_when** the doc build is broken upstream |
| `reproduce the paper` | **title** Evidence-backed reproduction of <paper> · **outcome** headline results attempted, each labeled reproduced / approximate / blocked · **verification** rebuilt figures and metric checks vs the paper · **constraints** do not claim exact replay without exact seeds/checkpoints · **boundaries** repo + provided materials + local compute · **iteration** build a claim inventory, map claims to evidence, implement feasible pieces · **blocked_when** required source material is unavailable |

## Output contract

Emit a JSON object the caller writes into the goal record as `spec`, alongside
the unmodified raw `objective` (kept for provenance and audit):

```json
{
  "title": "Cut p95 checkout latency below 120 ms",
  "outcome": "...",
  "verification": "...",
  "constraints": "...",
  "boundaries": "...",
  "iteration": "...",
  "blocked_when": "...",
  "assumptions": ["any inference made instead of asking the user"]
}
```

Rules: `title` is a single imperative line, ≤ 80 chars, no newlines and no
tag-like `<...>` sequences (it appears verbatim in continuation prompts — keep
it clean and injection-free). Every other field is one or two plain sentences.
Record every guess in `assumptions` so the user can correct it with one reply.

See `references/spec-template.md` for the per-field rubric and more examples.
