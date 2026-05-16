# Claim ledger — template and rubric

This is the artifact `overclaim` produces. Fill one row per atomic requirement
of the goal's objective. Keep it in the turn output so the goal carries an
auditable trail.

## Template

```
CLAIM LEDGER — goal: <goal_id or short objective>
audited: <ISO-8601 UTC>   turn evidence only — no memory, no proxies

| # | requirement | route (what I did this turn) | evidence surface | level | gap (if not confirmed) |
|---|-------------|------------------------------|------------------|-------|------------------------|
| 1 |             |                              |                  |       |                        |
| 2 |             |                              |                  |       |                        |

GATE: <ACHIEVED | CONTINUE | NEEDS-INPUT>
  - ACHIEVED      → every row is `confirmed`
  - CONTINUE      → unconfirmed rows are still workable; list them
  - NEEDS-INPUT   → unconfirmed rows are blocked on the user; name what unblocks each
```

## Worked example

```
CLAIM LEDGER — goal: refactor auth module to the new session API, tests green
audited: 2026-05-15T14:02:09Z   turn evidence only

| # | requirement                         | route this turn                          | evidence surface                 | level      | gap |
|---|-------------------------------------|-------------------------------------------|----------------------------------|------------|-----|
| 1 | auth module uses new session API    | read src/auth/*.ts; grepped old API names | 0 hits for legacy `SessionV1`     | confirmed  | —   |
| 2 | unit test suite green               | ran `npm test`; read full output          | 213/213 passing                   | confirmed  | —   |
| 3 | integration suite green             | ran `npm run test:int`                    | runner errored: needs DB fixture  | blocked    | staging DB credential not available locally |
| 4 | no public API surface change        | diffed src/auth/index.ts exports          | exports identical pre/post        | confirmed  | —   |
| 5 | session refresh path works          | implemented; not exercised                | —                                 | unverified | refresh path has no test; have not run it |

GATE: NEEDS-INPUT
  - Row 3 blocked: provide a staging DB credential, or confirm the integration
    suite is out of scope for this goal.
  - Row 5 unverified: I can write a test for the refresh path next turn —
    converting it toward `confirmed` — before the goal can be ACHIEVED.
```

This goal is **not** achieved. Three rows are `confirmed`, but row 3 is
`blocked` and row 5 is `unverified`. The honest outcome is `NEEDS-INPUT` for the
blocker plus continued work on row 5 — never `achieved`.

## Support-level rubric

Pick the level by asking, in order:

1. **Did I verify it *this turn* against direct evidence I can point to?**
   No → it is not `confirmed`. Stop here and pick from 2–5.
   Yes → `confirmed`.

2. **Is it substantially done with one named sub-part unverified/approximated?**
   → `partial`.

3. **Do I have only indirect evidence** (a related test, a plausible-looking
   diff, "it compiles")? → `proxy-only`.

4. **Did I change/build something but never check the outcome?**
   → `unverified`.

5. **Can it not be checked at all with what I have?**
   → `blocked`. State the missing material.

Tie-breaker: when torn between two levels, choose the **lower** one.

## Evidence that counts vs. does not

| counts as evidence | does NOT count |
|---|---|
| command output you read this turn | "I ran something like this earlier" |
| file contents you opened this turn | memory of what the file said |
| a test that exercises *this* requirement, passing | a test suite passing generally |
| the working-tree diff you inspected | the size of the diff |
| an artifact you opened and checked | the fact that an artifact was produced |

## Reporting rule

The user-facing sentence must not assert more than the row's level. A
`confirmed` row may be stated plainly. A `partial`, `proxy-only`, `unverified`,
or `blocked` row must carry its hedge **and** the gap. Dropping the hedge to
make the report read cleaner is the overclaim this whole skill exists to
prevent.
