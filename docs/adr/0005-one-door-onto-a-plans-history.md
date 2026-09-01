# One door onto a plan's history

Three endpoints used to change a mesocycle. `POST /{id}/revisions` changed the
plan and recorded why, refusing with 422 when the call changed nothing and
pointing at its sibling. `POST /{id}/decisions` existed for exactly the case
`/revisions` refused: a review outcome of "hold", a declared light week, a local
back-off. And `PATCH /{id}` renamed a plan **or ended it**, writing nothing to
the log at all.

They are now one: `POST /mesocycles/{id}/decisions`. Send change fields and it
is a change; send none and it is a note; send `ended_on` and it is an ending
that finally carries its reason. `PATCH` renames a plan and does nothing else.

## Why the split could not be justified

Nothing said why there were two. Not `reference/planning`, not
`tasks/programming`, not an ADR — in a repository where every refusal carries
its reason, that absence was the finding rather than the starting point. The two
calls were mutually exclusive by construction: one required a change, the other
required its absence. The 422 that taught the coach which door to use existed
only because there were two doors.

The glossary settled the name. `CONTEXT.md` has **Decision** and has never had
"Revision", and `GET /{id}/decisions` already read the rows `POST /revisions`
wrote. Keeping the write on a path the read did not use would have been two
names for one thing.

The precedent was already here and pointed the same way. `POST /intake` is
"exactly one of `meal`, `food` or `adhoc_kcal`" — one endpoint, three mutually
exclusive optional field groups, a 422 when the count is not one. Three
alternatives, shipped and documented; this needed two. The precedent cited
against the merge, `7c2f600`, refused `grams` alongside `kcal` because the two
produced a *contradictory* row: macros describing the grams while an overridden
field said otherwise. Change fields present or absent are not in conflict, and
there is no third reading.

## The ending was the real defect

`PATCH` with `ended_on` wrote `update mesocycles set …` and no decision row.
Ending frees the track for the next plan; it is the most consequential thing
that happens to a mesocycle. Three places said it could not happen silently —
`CONTEXT.md`'s definition of a decision, the comment above the revision handler,
and `tasks/programming` saying so to the coach — and all three were false. The
initial migration had said it too, in a column comment: *"earlier than planned =
cut short, why is in decisions"*.

The documents papered over it by asking for two calls: `PATCH` the date, then
write a decision saying what happened. Two calls, not atomic, and nothing
enforcing the second. One file over, `nutrition_targets` does the opposite and
explains why — a goal change registers its `phase_switch` event automatically,
"because the coach should not have to remember to do this".

## What it fixes underneath

`writeOnce` looks a `request_id` up by table, which assumes one table has one
writer. That held at every site but this one. Because two endpoints appended to
`mesocycle_decisions` and the lookup asked only whether the id had been seen,
four crossings answered **200 for work that never happened** — including an id
spent on a note and then sent to a revision, where the plan change silently did
not happen.

One endpoint settles which door spent the id. `scope` settles which plan: the
lookup now narrows to the row's owner, and a genuine cross-plan reuse falls
through to the write, where the unique constraint refuses it with a 409. Loudly,
which is the point — the previous behaviour was a quiet success for a decision
that was never recorded.

This is what the reverted first attempt was reaching for. That change scoped the
predicate and added a `changed_the_plan` column plus a migration to tell a
revision's row from a decision's, which is schema, forever, to hold an
unexamined split in place. With one door there is nothing to discriminate.

## Consequences

The API the coach talks to changed, so the coaching documents moved with it:
`reference/planning`'s "Revising mid-mesocycle" is now "Changing a plan",
`tasks/programming` and `tasks/evaluation` no longer instruct the two-call
ending, and `CONTEXT.md`'s **Decision** widened to cover a review that changed
nothing — with "Revision" added as a word to avoid, since the concept survives
in prose but the endpoint does not.

A call that changes the plan now answers **201**, not 200. The old handler
argued it changed a plan that already existed so there was no created row to
announce, but there always was one: the decision. Its retry replay is exact now, read from the row
rather than recomputed — though the `mesocycle` beside it is still current
state, which later decisions may have moved on, and the response says so instead
of promising "the plan as revised".

`ended_on: null` still reopens a plan ended by mistake, because the old `PATCH`
distinguished an explicit null from an absent field and nothing about this
decision argues for removing that.

Two questions this deliberately did not answer. Whether the log should record
which rows changed the plan — `GET /decisions` and session generation both read
a history that cannot tell a change from a hold, and that is what
`changed_the_plan` would buy, independent of how many endpoints there are. And
whether ending a plan in the same call as revising it should be refused as
incoherent; it is allowed, and nothing has needed it to be otherwise.
