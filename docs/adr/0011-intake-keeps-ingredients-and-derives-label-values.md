# Intake keeps ingredients and derives label values

An intake entry records what was eaten: a food and grams, or an ad-hoc estimate.
A saved meal supplies the ingredients and quantities at logging time. Later
recipe edits do not change those facts. Food edits mean corrections to a label,
not a change of product, so corrected labels must affect historical totals.

Previously, food-backed entries also copied the food's macros. Correcting a
food rewrote every linked entry inside the same transaction. That duplicated
information without adding history: the policy deliberately erased those old
numbers whenever a label was corrected.

## Decision

Ordinary food-backed entries store no macros. The `intake_values` view derives
them from the food and recorded grams, rounded to one decimal place. Both the
entry display and `daily_intake` use that view, so daily totals, expenditure,
and weekly protein coverage cannot accidentally keep reading old snapshots.
Unknown fiber remains unknown, and ad-hoc estimates retain their own numbers.

The food update is now a single write. Its response still reports the number
and date range of linked entries affected, rather than claiming the history is
unchanged. A concurrent macro correction detected after validation answers 409
instead of applying a correction checked against an obsolete label.

## Overrides are the exception, not a second source of ordinary totals

Explicit per-entry macro overrides remain possible. They store the complete
effective macro set and the food's macro revision. A subsequent food correction
increments that revision and makes old overrides inapplicable. This preserves
the existing blanket-retroactivity behavior without updating intake entries.
Renaming a food, changing its source description, or resending identical macros
does not invalidate overrides. Equality uses PostgreSQL's stored decimal
precision: sending 100.01 when the label stores 100.0 is not a correction.
Correcting grams clears an override. Changing only an entry's date or note
does not clear it.

A new partial override starts from the effective values, not an obsolete
stored override. Otherwise correcting only protein after a food correction
could silently revive old calories. The override update reads the values and
the revision in one SQL statement. Omitted fields use the UPDATE's current
target row, not a self-joined snapshot, so waiting for a concurrent correction
does not undo that correction or restore quantities from before a grams edit.

The migration removes matching snapshots and retains differing historical
values as overrides, including unknown fiber. It cannot determine why values
differ, so it does not discard them or invent a reason. No production data is
changed until the migration is deliberately deployed.

## Routine writes

Logging one food or an estimate needs one INSERT, not a transaction wrapper.
A saved meal uses one bulk INSERT: either every ingredient is saved or none is.
Registry creation still groups parent and owned rows atomically. Alias and
classification inserts are bulk operations; deleting an unused registry item
cascades only its owned supporting rows, never historical intake or training.
Token expiry cleanup is housekeeping rather than part of token creation.

## Boundaries retained

This supersedes the macro-copying implementation described in ADR-0006 and the
original nutrition migration, not the responsibility boundary. The API still
stores facts and computes arithmetic; the coach still decides what to eat.
The PostgreSQL runtime remains in place. Simplifying transactions is not a
commitment to D1 and is not a Workers migration.
