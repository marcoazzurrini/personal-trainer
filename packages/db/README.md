# Database

D1 is the application's only database. This package, `@trainer/db`, owns persistence, not HTTP, coaching decisions or a copy of production records. The API imports it as `@trainer/db/<path>`, which resolves to `src/<path>`.

- `src/client.ts`: constructs Drizzle from the current invocation's D1 binding. No connection pool or global database handle.
- `src/schema/`: typed table and view mappings. Stored integers and full-precision timestamp strings remain unchanged.
- `src/repositories/`: named reads and complete atomic writes. API services receive these operations, not a query builder.
- `src/contracts/`: persistence inputs and results shared across a feature's operations. They do not depend on HTTP schemas.
- `src/storage.ts`: pure precision, calendar, UUID and Unicode conversion functions.
- `src/errors.ts`: database failures without HTTP status codes. The API owns refusal messages and safe diagnostics.
- `src/native.ts`: the contained escape hatch for reviewed complex SQLite queries and assertion batches.
- `src/write.ts`: bounded JSON parameters and affected-row assertions used within atomic writes.
- `migrations/`: the ordered D1 SQL migrations used by development, tests and deployment. Applied migrations keep their names and contents; add a new file for a schema change. Tests protect the four already-released migrations.
- `backup.ts`: the off-account export behind `bun run backup`.
- `testing/`: local D1 helpers shared with the API's D1 tests, imported as `@trainer/db/testing/<file>`. `storage.json` holds independent expectations for the application tables and decimal precision, not runtime configuration or health records.
- `tests/`: schema, migration and storage tests for this package alone. Tests of API code over D1 live in `apps/api/tests/d1/`.

Nothing in this package imports the API, Hono, the dashboard or the plugin; `tests/architecture.test.ts` at the repository root enforces it. API services own validation and arithmetic, and translate database failures into the existing refusal contract. The package has no local environment file. The root `.gitignore` protects nested dependencies, local Worker state, secret files and private snapshot/import outputs.

## Local verification

Run from the repository root with the pinned tool versions:

```sh
bun run --cwd packages/db test
bun run --cwd apps/api test:d1
bun run --cwd apps/api test
```

These tests execute the application inside workerd with disposable D1 bindings. The schema test binding has a sentinel ID, refuses remote bindings and does not persist state. Persistence fixtures have separate nonpersistent databases and block unconfigured external requests. Tests do not load `.env` or contact a production database. No PostgreSQL service or Docker database is required.

The SQLite parser only identifies complete migration statements, including trigger bodies. Tests execute those statements against actual local D1 as well; passing only the parser is not sufficient. Local test results are not evidence of a deployment, hosted limits or a production restore.

## Migration ownership

Wrangler remains the only migration runner. Drizzle does not run migrations when a Worker starts, and production `drizzle-kit push` is not part of this project.

`drizzle.config.ts` describes the SQLite schema for offline tooling. `migrations/meta/0004_snapshot.json` is Kit's generated description of the structure after the four released migrations. It contains table and view definitions, not records or credentials. `_journal.json` anchors that description to the existing `0004_nutrition_writes.sql`; the next generated migration starts at `0005`. This is generation metadata, not a second applied-migration ledger. No generated initial CREATE migration is retained or applied. This ORM conversion changes no schema and requires no migration.

For a future schema change:

1. Update the relevant definition under `src/schema/`.
2. Run `bun run --cwd packages/db generate --name describe_the_change`. Kit compares the definition with its last saved snapshot and writes only the proposed differences.
3. Review the new SQL before applying it. Preserve data, `STRICT`, triggers, views and constraints; add custom SQL when Kit cannot represent a database feature. Never edit an already-released migration.
4. Run `bun run --cwd packages/db check` and the three test commands above. Test migration effects on disposable D1, including existing records, before deployment.

Unchanged generation writes nothing. Tests run the real Kit CLI on temporary copies and apply an example additive column migration to disposable D1. They verify record precision, STRICT tables, indexes, triggers and views survive. CI checks the metadata and runs these tests without production access.

SQL remains authoritative for `STRICT` tables, triggers, view definitions and constraints that the pinned generator cannot faithfully reproduce. A generated table rebuild needs explicit review of those properties. Keep one reviewed SQL history under `migrations/`; do not introduce a second migration executor or ledger.

## Stored representations

Measured decimals use bounded scaled integers. For example, stored `bodyweight.value_kg = 8235` means `82.35 kg`. Decimal ties retain the original PostgreSQL rounding rather than binary-floating-point approximations. Stored instants preserve all six fractional digits; public JSON timestamps retain the existing millisecond format. Correcting another field must not round-trip an omitted timestamp.

Repositories supply Unicode lowercase `name_key` and `alias_key` values, including on rename, without erasing accents or merging normalization variants. Bodyweight persistence also supplies the Europe/Rome date, including daylight-saving changes. Both weekly views include unfinished and future weeks; API readers apply the completed-week cutoff. Other view contracts preserve historical winners and null totals on flagged days without entries.

## Atomic writes

Session writes use the internal version and assertion table introduced by `0002_session_writes.sql`. Triggers advance the version when session facts or sets change. A correction reads a consistent snapshot, validates it, then submits one atomic D1 batch that checks the version and affected rows, writes the change, reads the response and clears its assertion. Failure rolls back the whole batch; the assertion is not a lock held across JavaScript execution.

Only a failed version assertion is retried, at most three attempts. Each attempt reads and validates again. Uncertain failures are not retried. Exhausted contention returns 409 and asks the caller to read the record. Provider calls must not occur inside this retry boundary.

Plan decisions use conditional SQL and affected-row assertions, not a second version counter. Removal or redose with a lost precondition rolls back the whole decision before revalidation. The displaced intent is read inside the INSERT; removal deletes membership, not dose history.

Large writes use bounded JSON parameters in one atomic batch. Session creation and plan writes batch reference lookups while preserving canonical-name, alias and numeric-ID precedence. Tests retain large-write, partial-failure, retry, concurrency, precision and request-replay coverage.
