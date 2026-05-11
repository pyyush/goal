<!--
  cowork/handoff/template.md — canonical handoff envelope template (spec §5.2)

  This file defines the authoritative shape of a .goal/handoff/NNNN.md file.
  Both the bash parser (parse.sh) and the TypeScript parser (parse.ts) derive
  their expected structure from this document. The bridge writer (bin/goal-bridge)
  fills the placeholders below rather than duplicating the format string inline.

  Placeholders use {key} syntax and are replaced by the bridge writer at runtime.
  Required frontmatter keys: seq, from, to, at, reason, goal_id.
  Required body sections (in order): Did, Did not, Next, Do not redo,
    Open audit items, Evidence.

  Sequence numbers are zero-padded to 4 digits (e.g. 0001, 0042). Monotonic.
  The filename IS the ordering — the seq field in frontmatter is the authoritative
  value; the filename is derived from it.

  Reason values (exhaustive enum): planned | rate_limit | budget_step_down |
    error | user
-->
---
seq: {seq}
from: {from}
to: {to}
at: {at}
reason: {reason}
goal_id: {goal_id}
---

## Did
{did}

## Did not
{did_not}

## Next
{next}

## Do not redo
{do_not_redo}

## Open audit items
{open_audit}

## Evidence
{evidence}
