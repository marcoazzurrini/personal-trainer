# Dose history is the source of truth

`mesocycle_exercise_doses` is the only store of a plan exercise's weekly dose.
`mesocycle_exercises` keeps membership, role, priority and notes, but no longer
keeps a second copy of the current dose and unit. The API still returns
`weekly_dose` and `weekly_dose_unit` on plan exercises, and `dose` and
`dose_unit` in training state and weekly delivery. This is a storage change,
not a new coaching rule or a new response shape.

## Why one copy

The history already answers what a finished week asked for. Keeping a current
number beside it means every creation, addition and redose must write the same
fact twice. There is no independent meaning to the current copy. A plan that
asked for 9 sets before a decision and 12 afterwards needs both history rows,
not a third place that repeats 12.

Current reads choose the latest `effective_from` not after today, with the
largest `id` breaking same-day ties. A future plan is previewed as of its start,
so its initial dose is visible before training begins. Additions and redoses
made before that start take effect at the start, not earlier: otherwise the
initial, future-dated row would hide the later decision. Once the plan starts,
a decision takes effect on its Rome day. Weekly delivery keeps its existing
week-end cutoff and ordering. It does not acquire a join to current membership.

## Membership and decisions remain independent

A history row never makes an exercise a current member. Removal deletes only
membership; historical doses and delivered work remain. Readdition creates a
new membership row and appends the explicitly supplied dose. A redose checks
and locks current membership before appending, so retained history is not
permission to redose a removed exercise. The membership lock also serializes
redoses with removal and with other redoses of the same exercise.

ADR-0005 still holds: the decision and all requested changes share one
transaction. Failure to record the decision rolls back membership and dose
changes. A hold appends no dose. Retrying a request appends nothing and returns
the original decision beside the current plan, not a historical plan snapshot.
ADR-0006 still keeps SQL in topic modules; ADR-0007 still leaves judgments to
the coach. This decision replaces the fast-path duplication introduced by the
legacy dose-history migration, not those boundaries.

## Existing records are not rewritten

`20260809240000_dose_history.sql` backfilled each then-current dose at the
plan's start. It explicitly could not recover redoses made before history
existed. That migration remains immutable. Its baseline is retained as recorded;
this change neither claims to recover earlier numbers nor extracts them from
prose.

The new migration preserves every dose row byte-for-byte and checks that each
current member's applicable history agrees with its old current columns before
dropping those columns. Missing history or disagreement stops the migration.
This includes a legacy pre-start redose hidden by a later effective date. Such
records need reconciliation from recorded evidence, not an invented change
at migration time. No second backfill silently replaces a known 9-to-12 history
with 12 from the start.

Positive-dose and supported-unit checks move to the history table. Their old
constraint names remain intentionally: those names select the existing public
refusal messages. Invalid historical rows stop the migration as well, including
rows for exercises no longer in the plan.

The old and new API binaries are not compatible with each other's schema.
Apply the migration with the matching API release through the existing startup
migration path; do not run an old writer after dropping its columns.
