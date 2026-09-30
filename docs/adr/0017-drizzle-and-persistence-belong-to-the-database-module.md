# Drizzle and persistence belong to the database module

Status: accepted. This supersedes ADR-0006's decision to keep queries beside API
routes and not adopt an ORM, and ADR-0015's placement of storage conversions in
`api/`. It does not change the API's exclusive ownership of the record or the
meaning of any recorded fact.

## Why change

The database directory should own persistence, not only its migrations and
tests. Drizzle provides typed SQLite queries over the existing Cloudflare D1
binding. Putting the client, table definitions, conversions and persistence
operations together makes that responsibility explicit without adding another
package, database, transport or dependency-injection framework.

This trades some feature locality for a capability boundary. A feature can need
changes in both `api/` and `db/`; the benefit must be that application code cannot
construct a query or accidentally split an atomic write. Moving files without
establishing that boundary would not justify the trade.

## Responsibilities

`db/client.ts` constructs Drizzle from the D1 binding supplied by an invocation.
It does not read process environment variables, create a connection pool or
retain a process-global database handle. Schema declarations may be immutable
module-level values; a database bound to an environment may not.

`db/schema/` describes stored tables and views. `db/repositories/` owns queries
and complete atomic persistence operations. `db/storage.ts` owns stored-value
conversion. `db/errors.ts` classifies database failures without HTTP status
codes, user-facing refusal messages, provider credentials or raw SQL in errors.
None of these modules imports `api/`, Hono, the web application or the plugin.

API entrypoint composition supplies repositories to application services.
Routes keep parsing requests, calling named operations and formatting responses.
Application services keep validation, arithmetic, workflow decisions and the
bounded revalidation loops required after a known concurrency conflict. Pure
rules remain unable to reach persistence. The API translates database failures
into the existing refusal contract and redacted diagnostic envelope.

Repositories expose operation-shaped functions, not Drizzle builders, raw D1
handles or a generic CRUD framework. A correction saves all related changes
and checks its preconditions within one atomic database operation. Internal row
types and storage representations do not become public HTTP schemas. Repository
input and output contracts belong to `db/`; they do not import API request types.

Withings provider calls, configuration, scheduling workflow and `waitUntil`
remain in the API. Credential reads, conditional rotation saves, account guards,
measurement writes and watermark updates belong to persistence. Provider calls
must never enter a database retry loop. The dashboard and coach continue to use
the API; neither receives a database client or binding.

## Data and migration safety

ORM adoption changes code, not stored records or the schema. The four released
D1 migrations retain their exact names and bytes. Wrangler remains the only
migration executor and `d1_migrations` remains its ledger. There is one SQL
history in `db/migrations/`; Drizzle tooling does not establish a second runner.

Stable Drizzle and Drizzle Kit releases are pinned. Kit configuration is local
and contains no production credentials. Generated SQL is a draft for review,
not authority to recreate an existing table or discard a database feature.
Kit-generated metadata is baselined against the released schema, whose mappings
are checked on disposable D1. The snapshot describes the result of the four
released migrations and its generation journal anchors to the existing
`0004_nutrition_writes.sql`. Its index starts at 4 so the next generated file is
`0005`, without renaming the released history. Only the metadata is retained;
no generated initial CREATE migration is added or replayed. `db:generate`
compares future definitions with that snapshot and `db:check` validates the
metadata. Tests prove unchanged generation writes nothing and an additive
migration preserves records and database features on disposable D1. Production
`push`, remote introspection and `pull --init` are not part of this conversion.

SQL migrations remain authoritative for STRICT tables, triggers, views, checks
and features not faithfully represented by the pinned generator. Drizzle schema
mapping tests must detect omissions. No deployment may silently weaken those
properties when a table is rebuilt.

D1 batches remain atomic. A failed version or affected-row assertion must abort
inside the same batch as the changes; inspecting a successful result afterward
is not a substitute. Keep assertion statements adjacent to the writes whose
`changes()` they test. Use Drizzle's D1 batch API or an explicitly contained
native batch where required, not callback transactions across JavaScript reads.

Preserve scaled-integer rounding and bounds, six fractional timestamp digits,
Rome dates, Unicode keys, null and omission distinctions, immutable targets,
request replay semantics and bounded JSON parameters. Retry only known stale
preconditions after fresh reads and validation. Unknown write outcomes and
provider credential rotation are not automatically retried.

## Verification and delivery

Establish boundary tests and a schema mapping first. Convert bodyweight as one
end-to-end slice, then convert other features without moving mixed stores
wholesale. Temporary unconverted paths must remain explicit and tested; remove
them as each slice moves rather than retaining two permanent database clients.

Database tests run against disposable D1 inside workerd. API contract tests
protect response shapes, status codes and refusal text. Preserve concurrency,
partial-failure, request replay, precision and provider-safety coverage. Check
bundle size and local Worker behavior; local measurements do not establish
hosted CPU limits or production performance.

This decision authorizes no production database operation, deployment, commit
or deletion of retained recovery material. Those remain separate actions.
