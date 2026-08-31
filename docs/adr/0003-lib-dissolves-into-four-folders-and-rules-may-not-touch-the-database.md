# `lib/` dissolves into four folders, and `rules/` may not touch the database

`lib/` was a junk drawer whose name carried no information. Thirty-three lines
of pure calendar arithmetic sat beside the throttled orchestration of an
external weight scale, beside the Zod factories every route validates with,
beside multi-table reads of the intake record. Nothing was wrong with any of
those files. What was wrong is that a reader had to open each one to learn what
it was, every time, and that no file in there could be said to be in the wrong
place, because the folder made no claim a file could violate.

So the thirteen files are now four folders. `rules/` holds the arithmetic and
the laws the database cannot express: the Forbes energy math, the
measure/dose/effort relationships, the macro checks, the calendar. `record/`
holds the reads and writes extracted from routes so far. `http/` holds the
request shapes and the error envelope. `outside/` holds the two third-party
clients. The names are the point: a folder earns one by saying both what is
inside it and what that code may not do. A folder named for a technical layer
and defended by nothing is `lib/` renamed, and it decays the same way.

Only one such rule is actually true today, and only that one is enforced:
nothing under `rules/` may import `db.ts`. `record/` is deliberately not
described as owning database access, because it does not — `routes/` still
holds plenty of its own SQL: a hundred and ten queries across those files,
twenty of them in `routes/exercises.ts` alone. Claiming a boundary the
repository does not keep would be worse than claiming none, because the first
reader to find the exception stops believing any of the names.

## Why `ApiError` is allowed in the pure folder

The obvious purity rule is stricter — no database *and* no HTTP. We measured
it. It leaves exactly one file, `expenditure.ts`, because `nutrition.ts`,
`training.ts` and `dates.ts` all throw `ApiError`. A folder with one file in it
is not a boundary, it is a file with a longer path.

But the count is not the argument. The client of this API is a model, and a
refusal sentence is the thing that tells it what a correct call looks like —
ADR-0002 calls that prose the actual contract, and it is the reason the
validation rewrite was allowed to happen at all. The code that knows *why*
something is refused is the code that should write the sentence explaining it.
Splitting status selection into a layer below would put half of one message in
each of two modules, to protect an abstraction that buys nothing here: this
service has one transport and will not grow a second. The coupling is also
thinner than it looks. Both Hono imports in `http/errors.ts` are `import type`
and are erased at compile, so nothing crosses at runtime in either design.

The rule that survives, then, is the narrow one. `rules/` may refuse a call. It
may not ask the database anything.

## Consequences

`tests/rules_purity_test.ts` walks every import specifier under `rules/`,
resolves the relative ones, and fails naming the file and line that reached
`db.ts`. Without it the boundary would last about a month; the first author who
needs one more number would fetch it rather than take a parameter, and the
suite would stay green while the folder's name quietly stopped being true. The
test asserts that one rule and nothing more, which is why it says nothing about
`record/` or about `@hono/*`.

That rule is worth more than the layout it currently describes. The deepening
work ahead will move these files again, possibly into domain modules that cut
across all four folders. "The code that decides may not read" survives that;
"expenditure lives in `rules/`" does not.

Two placements are not the obvious sort. `withings_sync.ts` is with the record
rather than with `outside/`, because it imports `db.ts` and writes rows; the
client it wraps is import-free and stays in `outside/`. And `doc_names.ts` sits
at the top level rather than in a `documents/` folder of its own. The coaching
documents are the product rather than a third party, so it is no sibling of
`withings.ts`, but one file is not a folder either. It can move when
`routes/docs.ts` joins it.

`routes/` was not touched. Nothing about it improves by being renamed, and the
work that dissolves it is a different decision. The move itself was `git mv`
and import rewrites only: no file contents changed beyond the paths, and every
refusal sentence in the repository is byte-identical to what it was before.
