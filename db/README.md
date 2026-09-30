# Database

D1 is the application's only database. This directory contains its schema history and isolated persistence tests, not a copy of production records.

- `migrations/`: the ordered D1 SQL migrations used by development, tests and deployment. Applied migrations keep their names and contents; add a new file for a schema change. Tests protect the four already-released migrations.
- `tests/`: D1 schema, persistence and Worker integration tests, with their local helpers and Worker entry points. `fixtures/storage.json` holds independent expectations for the application tables and decimal precision, not runtime configuration or health records.

The API's storage conversion functions live in `api/shared/storage.ts`. The root package owns the commands and dependencies; there is no separate DB package or local environment file. Root `.gitignore` protects nested dependencies, local Worker state, secret files and private snapshot/import outputs.

## Local verification

Run from the repository root with the pinned tool versions:

```sh
bun run test:d1
bun run test:api
```

These tests execute the application inside workerd with disposable D1 bindings. The schema test binding has a sentinel ID, refuses remote bindings and does not persist state. Persistence fixtures have separate nonpersistent databases and block unconfigured external requests. Tests do not load `.env` or contact a production database. No PostgreSQL service or Docker database is required.

The SQLite parser only identifies complete migration statements, including trigger bodies. Tests execute those statements against actual local D1 as well; passing only the parser is not sufficient. Local test results are not evidence of a deployment, hosted limits or a production restore.

## Stored representations

Measured decimals use bounded scaled integers. For example, stored `bodyweight.value_kg = 8235` means `82.35 kg`. Decimal ties retain the original PostgreSQL rounding rather than binary-floating-point approximations. Stored instants preserve all six fractional digits; public JSON timestamps retain the existing millisecond format. Correcting another field must not round-trip an omitted timestamp.

The API supplies Unicode lowercase `name_key` and `alias_key` values, including on rename, without erasing accents or merging normalization variants. It also supplies the Europe/Rome date for bodyweight, including daylight-saving changes. Both weekly views include unfinished and future weeks; API readers apply the completed-week cutoff. Other view contracts preserve historical winners and null totals on flagged days without entries.

## Atomic writes

Session writes use the internal version and assertion table introduced by `0002_session_writes.sql`. Triggers advance the version when session facts or sets change. A correction reads a consistent snapshot, validates it, then submits one atomic D1 batch that checks the version and affected rows, writes the change, reads the response and clears its assertion. Failure rolls back the whole batch; the assertion is not a lock held across JavaScript execution.

Only a failed version assertion is retried, at most three attempts. Each attempt reads and validates again. Uncertain failures are not retried. Exhausted contention returns 409 and asks the caller to read the record. Provider calls must not occur inside this retry boundary.

Plan decisions use conditional SQL and affected-row assertions, not a second version counter. Removal or redose with a lost precondition rolls back the whole decision before revalidation. The displaced intent is read inside the INSERT; removal deletes membership, not dose history. ADR-0013 still owns historical dose selection.

Large writes use bounded JSON parameters in one atomic batch. Session creation and plan writes batch reference lookups while preserving canonical-name, alias and numeric-ID precedence. Tests retain large-write, partial-failure, retry, concurrency, precision and request-replay coverage.

## Retired transfer tooling

The PostgreSQL transfer is complete. Its historical SQL, exporter, converter, verification command and disposable PostgreSQL comparison suite are preserved in Git at commit `f11c43d`, not maintained as a second active database toolchain. Their removal does not change the D1 schema or stored records. The historical header in `0001_record.sql` refers to the PostgreSQL directory at the time of the transfer; the released file remains byte-for-byte unchanged.

[ADR-0015](../docs/adr/0015-workers-and-d1-replace-the-managed-vps.md) records this retirement. The [cutover receipt](../docs/cloudflare-cutover.md) identifies the verified transfer and private recovery archive. Keep every retained backup and its existing retention policy; retiring source code does not authorize deleting recovery material. New backups and restores use the current D1 procedures in [the recovery runbook](../docs/hosting.md#database-recovery), not another import of the original PostgreSQL snapshot.
