# Goal switches are derived from eating plans

A saved nutrition target is the eating plan from its `effective_from` date. The
API used to save a second fact in `nutrition_events` when a target changed the
goal. That made saving a plan a two-table transaction with a table-wide lock,
but did not make the event history correct: a backdated target could change the
next transition without repairing its event, and same-day revisions could
leave switches between goals that never governed separate days.

ADR-0005 cited automatic registration as the precedent for keeping a plan and
its consequences together. That requirement stands; maintaining a second event
row does not. ADR-0006's topic ownership and route/database boundary stand.
ADR-0007 permits this derivation because comparing saved goals is arithmetic,
not a coaching decision.

## One effective history

`nutrition_goal_switches` selects the highest target id on each effective date,
then compares each winner with the previous date's winner. A different goal
produces one `phase_switch` on the new target's effective date. The first date
has no previous goal and produces none. A calorie or protein revision with the
same goal on a later date produces no new switch.

For example, a cut on Monday followed by maintenance on Friday yields one
Friday switch. Backdating maintenance to Wednesday moves the switch to
Wednesday; Friday is now a continuation. Replacing Wednesday with gain yields
cut-to-gain on Wednesday and gain-to-maintenance on Friday. Replacing Friday
with cut compares Friday with Wednesday, not with Friday's superseded row.
All saved targets and their decisions remain in the history.

The event list, active transients, expenditure damping, and finished weeks read
`nutrition_effective_events`, which combines these derived switches with the
recorded events. Window filters run after the full-history comparison. Future
events appear in the history but do not damp before their day. The existing
inclusive fourteen-day cutoff and the expenditure window's end date do not
change.

## Withdrawal without rewriting the plan

Recorded event ids remain positive. Automatic ids are the negative of the
winning target id. This keeps response ids numeric and disjoint without a
second identity allocator. The existing DELETE route accepts both signs.

Deleting a recorded event still deletes that row. Deleting an automatic event
sets `phase_switch_suppressed` on its target, leaving the eating plan and its
decision intact. Every reader excludes that automatic event. A suppression
belongs to that target even if a later backdate changes its predecessor; it
does not suppress a new replacement target. There is no restoration endpoint.
A repeated deletion, a superseded target's event id, or a target that currently
has no switch returns 404 rather than claiming work happened.

The suppression column is event bookkeeping, not a mutable target field in the
API. It avoids a separate suppression table and foreign-key lifecycle for one
bit of intent. A same-date replacement has a new automatic id; callers must
read the current events rather than keep an obsolete id indefinitely.

## Compatibility and existing records

The 201 target response retains `phase_switch_registered`. It now means that
the newly saved target derives an unsuppressed switch at response time, not
that another row was inserted. It does not summarize changes to later targets
caused by backdating. The 200 retry response remains the original target alone;
no arithmetic or registration is replayed. Target writes no longer lock the
whole table or insert events. A transaction still covers the insert and its
response read, so a failed response query cannot leave an unacknowledged save.

Manual POST events, including explicit `phase_switch` events, remain independent
facts with unchanged ids, request ids, notes, and retry behaviour. Event and
withdrawal response shapes are unchanged. The DELETE parameter now also accepts
negative ids, and the OpenAPI descriptions explain their meaning.

Existing recorded switches have no reliable source marker. A null request id or
a generated-looking note is not proof that a row was automatic. The migration
therefore preserves every existing event unchanged. A legacy recorded switch
can overlap a derived one; both are visible and independently withdrawable.
No guessed matching rule silently removes an explicit event. Damping still
uses the presence of a transient, not its count, so duplicate claims do not
multiply damping. Their independent dates remain significant if a backdate
changes only the derived history.

A previously deleted automatic event left no suppression record. That lost
intent cannot be reconstructed without guessing; a newly derived historical
switch may therefore need explicit dismissal after migration. This limitation
is preferable to deleting legacy facts or inventing provenance. Review the
combined events after migration, withdrawing obsolete recorded switches and
dismissing any derived switches that should not affect the estimate.

## Boundaries held by tests

Tests cover the effective-date winner, the first date, unchanged goals,
backdating before and between existing plans, retries and concurrent saves,
manual and legacy-looking events, negative-id withdrawal, repeated or invalid
deletions, and agreement between event, state, expenditure, and weekly readers.
An injected failure on event insertion proves saving a target no longer writes
`nutrition_events` at all. A failed response query rolls the target back and
allows the same request id to be retried. A private-schema migration test checks
that legacy rows survive unchanged while existing targets produce switches.
