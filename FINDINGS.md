# FINDINGS

This is a durable, append-by-PR record of what conductor actually did when
run against real changes: this repo's own dogfood runs, other Vault &
Compass repos, or public downstream projects that install the umbrella. A
gate result that only lives in a terminal scroll or a closed pull request
evaporates; this file is the place it lands instead, so false-positive and
false-negative classes accumulate across runs instead of being rediscovered
by the next person who hits them.

A run that found nothing still gets a row. "It caught nothing" is itself a
datum: it is the only way to tell whether the umbrella (or one of the three
gates it runs) is blind on that input or the base rate of real issues in it
is genuinely low. Log the clean run, not just the interesting one.

## Format

One row per run. Append new rows at the bottom, in chronological order. Do
not edit or delete existing rows; if a verdict turns out to be wrong on
later review, append a new row that corrects it and say which row it
corrects.

Verdict is one of: true positive, false positive, true negative, false
negative, could-not-run.

| Date | What was scanned (repo/artifact + version) | What the gate said | Verdict | Follow-up |
|---|---|---|---|---|
| 2026-01-01 (EXAMPLE) | example-app (git SHA abc1234) + conductor 0.4.0, conductor run | conductor: clean, nothing blocked. 2 gate(s) ran. | true negative | none |
| 2026-09-18 | A pull request with an empty diff, gated through conductor's intent stage with intent-guard-version pinned to 1.5.1 | intent-guard refused the umbrella's --paths "" (the empty change set conductor sends for an empty diff) as a missing value and printed usage text instead of a report; conductor read that as a failed gate | could-not-run | Fixed in conductor 0.4.3: the intent-guard-version default moved from 1.4.0 to 1.5.2, which accepts an explicit empty list. Never pin intent-guard-version to 1.5.1 here. See CHANGELOG.md, [0.4.3] - 2026-09-18. |

## How to add an entry

Open a pull request that appends one row to the table above. Any seat may
open it, human or agent. Keep the table chronological. A clean run (true
negative) and a run the gate could not complete (could-not-run) are both
worth recording, not just the runs that found something.
