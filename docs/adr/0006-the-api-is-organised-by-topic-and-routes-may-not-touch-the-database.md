# The API is organised by topic, and routes may not touch the database

`rules/`, `record/`, `http/` and `routes/` sort this API by the technical job a
file does. They are replaced by folders named for what the code is about —
`training/`, `nutrition/`, `body/`, `surfaces/` — each holding its own HTTP
surface, its own rules and its own queries. `routes/` dissolves into them.

The rule that makes this more than a rename: **a file that declares HTTP routes
may not import `db.ts`.** It parses the request, calls one named function, and
shapes the answer. The query lives in the topic module beside it, and that
module opens its own transaction.

Such a file is identified by its name — `*.routes.ts` — rather than by sniffing
its contents for `createRoute`. Content is not a reliable signal: `routes/docs.ts`
declares its one route with a plain `.get()` and holds no `createRoute` at all,
while `routes/withings.ts` holds both — three plain handlers registered above
the token middleware and one `createRoute` below it — so a per-file content
check classifies it two ways at once. The convention is chosen, not discovered,
and the migration is what establishes it. `index.ts` is outside the
rule by construction: it is the composition root, not a route file, and it
imports `db.ts` for the `select 1` behind `/health` — a liveness ping that
exists to keep the project from being paused, and not domain data. That is the
only place the client is reached outside a topic, and it is named here so the
next reader does not think it was overlooked.

## The measurement that decided it

The previous argument for keeping the current shape was that the boundary would
guard nothing: no file outside `training/` queries a training table, and the
four copies of "a day's intake" that started this programme all lived inside
what would become one folder. Both facts are true and neither is the point. A
boundary is not only a guard against a crossing; it is where a change lands.

So the question became: when this system changes, what does the change touch?
Sixty commits that altered the API, with the two structural refactors and the
initial scaffolds set aside:

| | one folder | more than one |
|---|---|---|
| sorted by topic | **71%** | 29% |
| sorted by technical job (today) | 33% | 67% |

Forty-one per cent of commits change exactly one topic and are forced across
more than one of today's folders. That number is the cost of the current
arrangement, paid on nearly half of all work, and it is what Ousterhout means by
information leakage: one decision, filed in three places, because a feature
always needs some arithmetic, some SQL and some request shape, and those are not
three decisions.

The same history says which topics are real, counting only commits that touched
one topic and nothing else: `training` 16, `nutrition` 15, `body` 7,
`surfaces` 5, and `memory` **zero**. `user_context` has never changed on its
own. It is not a domain and does not get a folder; it goes where its only two
readers are.

The domains were derived from that record rather than from `CONTEXT.md`. The
glossary does not partition the code — two of its sections describe training,
it has no entry for bodyweight or bodyfat at all, and **Alias** is defined as
spanning exercises, foods and meals, so it names something no single folder can
hold.

## Why the folder was never the gate

The ticket that raised this asked which folders to create, and treated that as
the thing blocking the deepening work. It is not. Placement is the cheap half —
ADR-0003 established that when it moved thirteen files with `git mv` and import
rewrites and changed no file's contents.

The expensive half, and the one that has to be decided first, is the rule about
the database. Twenty of the twenty-two route files import `db.ts` and hold
eighty-one queries between them. That is why the routes are shallow: a route
can reach the database, so there is nothing a topic module could hide from it,
and no amount of renaming folders creates something to hide. Take the reach
away and every one of those eighty-one queries has to move behind a function
named for an operation, in a module that owns the data. The depth is a
consequence of the rule, not of the layout.

This is the same rule ADR-0003 already proved, applied one folder further out.
That ADR said the narrow purity rule was worth more than the layout it described
and would survive a move into domain modules. It has, and it now has a sibling:
`rules/` may not read, and the HTTP surface may not read either.

## The pattern is not new

What each topic module gets is a service layer of transaction scripts, in
Fowler's sense: one function per operation the API offers, handling a single
request end to end. `logIntake`, `recordDecision`, `correctFood`. The name
matters only because it comes with a known failure, and the failure is the thing
to avoid.

That failure is the anemic repository: wrapping each query in a function of its
own, so `select * from foods where id = $1` becomes `getFoodById`, and
eighty-one queries become eighty-one one-line functions that hide nothing. That
is more files and more indirection for the same knowledge — a shallow module by
Ousterhout's definition and worse than what is here now. The test each
extraction has to pass is whether it hides a rule or only a `select`.
`logIntake` hides the exactly-one-of-three refusal, the scale bounds, the macro
snapshot and the all-or-nothing insert. `getFoodById` hides nothing and stays
private, or stays inline.

For the same reason the transaction handle stays inside the module. The obvious
reading of "a domain function taking `Tx`" puts `Tx` in the route's vocabulary,
and `Tx` comes from `db.ts` — the rule would be broken by its own remedy, and
every function would need a with-transaction variant. So the route calls
`logIntake(input)`, and `logIntake` calls `sql.begin` and passes `Tx` to its own
private helpers. `Tx` appears in no signature a route can see.

Nothing further is adopted. No dependency injection, no ORM, no interfaces
standing in for test doubles, no ports and adapters. Those earn their cost with
more than one database, more than one transport, or more than one developer, and
this has one of each.

## What does not move

Some code belongs to no topic and is not evidence of a failed boundary. The
calendar, which holds the only place the Rome clock is *asked of Postgres* — the
`now() at time zone 'Europe/Rome'` fragment, one site — and is imported by
eleven files; `writeOnce`, used by every topic; the request-shape factories
in `http/schema.ts`, used by twenty-one of twenty-two route files; the
name-resolution engine that serves exercises, foods and meals alike; the alias
route factory mounted five times across two topics. These are cross-cutting by
nature and already deep. They keep a shared home, and a topic folder importing
them is not a boundary violation.

`bodyweight` and `bodyfat` become `body/` on the strength of seven commits that
touched nothing else, even though their only reader is nutrition's expenditure
arithmetic. If that reading turns out to be wrong, `body/` folds into
`nutrition/` and nothing else changes.

## Consequences

Each topic folder holds its HTTP surface beside its rules: `nutrition/`
gets `intake.routes.ts` next to `intake.ts`, and an `index.ts` that hands its
routers to the composition root. The alternative — keeping `routes/` as a thin
transport ring above the topics — was rejected because it rebuilds the split
this decision exists to remove: a nutrition change would still land in two
folders, which is the 41% again in a new spelling.

The `createRoute` declarations do not shrink and do not move out of their topic.
They are between forty and fifty per cent of every route file, they generate
`/openapi.json`, and they have to sit at the `.openapi()` call. This decision
does not make the API smaller. It makes a change to one thing land in one place.

Two tests read the layout, and both need rewriting rather than repointing — not
at the end, but before the topic that first invalidates them.

`tests/openapi_test.ts` scans the `routes/` directory for handlers registered
without a declaration. Its exposure is not that the folder disappears: a missing
directory makes `Deno.readDir` throw, and the test fails loudly. It is that the
folder is *drained one topic at a time* — after the first topic moves, the
directory still exists and the test silently stops checking the files that left.
Coverage falls with every PR and nothing reports it. So the fix is not a
non-empty guard, which stays green with a single file remaining; it is to walk
the whole tree for `*.routes.ts`, which is the convention this decision
establishes.

`tests/auth_matrix_test.ts` reads `index.ts` as text and depends on `app.route`
and `app.use` appearing in a particular order to decide which paths answer
without a bearer token. It also asserts that at least twenty guarded mounts
exist, and there are twenty-four today — so consolidating mounts behind topic
modules breaks that floor early rather than eventually, and the rewrite is
forced by the second topic rather than deferred to the last. What it holds down
is a security property, which makes it the most careful part of the migration
rather than the largest.

The work lands one topic at a time, each independently shippable, and the folder
that a topic's files end up in is the last step of its own migration rather than
a prior move of everything at once. Nothing is renamed until something is
deepened, so no folder ever makes a claim the code inside it does not yet keep.

Two questions this deliberately leaves open. Whether `surfaces/` is one thing —
a filesystem reader for the coaching documents and a GitHub client for coach
issues share no table and no function, and five commits touching both is thin
evidence for a folder. And whether `rules/` survives as a name once each topic
owns its own arithmetic: the purity rule it carries is about a capability rather
than a place, and it may end up asserted against every topic's pure files
wherever they sit.
