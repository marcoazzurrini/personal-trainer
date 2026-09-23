# D1 migration

The API now uses Workers and D1 throughout, including the HTTP contract tests.
This directory owns the D1 schema, runtime persistence tests and one-time
PostgreSQL transfer tooling. PostgreSQL remains only as the transfer source and
an isolated comparison fixture, not as an application runtime dependency.

**Local verification does not mean live traffic has switched.** The initial
traffic switch and recovery requirements are in `docs/hosting.md`.

## What is implemented

- A D1 baseline of the final PostgreSQL record: 27 application tables, seven
  views, original relationships, measured-value bounds and relevant constraints.
- Explicit storage metadata and decimal, timestamp, date, UUID, boolean and JSON
  conversion. Decimal ties use PostgreSQL rounding, not binary-float guesses.
- A read-only, repeatable-read PostgreSQL export and an offline import
  converter.
- Tests on Wrangler's local D1 and a fresh, owned PostgreSQL container. Tests
  compare all exported rows and all seven views over synthetic historical data.
- D1 persistence for session creation, detail, listing, append, session/set
  correction and discard in `api/training/sessions.ts`.
- D1 bodyweight and body-fat persistence, including precision, natural-key
  conflicts, request replay, Rome dates, history, trends and deletion.
- D1 plans and decisions: atomic membership/dose/intent changes, scoped request
  replay, future dose previews, ending/reopening, and decision history.
- D1 blocks, append-only context and weekly schedules, including Rome/DST
  defaults and the existing weekend warning.
- Persistence tests that execute the application code inside workerd against
  local D1, including concurrent writes and failures after partial execution.
- CI gates that require runtime, HTTP, transfer, dashboard and build checks
  before deploying the API and dashboard Workers.

Nothing here deploys a Worker, creates a hosted database, switches traffic,
reads `.env`, or accesses an existing PostgreSQL database during tests. The test
schema/import binding has a sentinel ID, disables remote bindings, and does not
persist state. Worker persistence tests use separate nonpersistent Miniflare D1
bindings and block external requests. Miniflare and esbuild are pinned to the
same versions already supplied by Wrangler; no additional production service is
introduced.

## Run the tests

Use the Node version declared in `package.json`. The PostgreSQL comparison also
requires Docker with a local Unix-socket context; remote contexts are refused.

Install the root API dependencies too: persistence tests bundle its routes. Run
these commands from the repository root.

```sh
npm ci
npm ci --ignore-scripts --prefix db/d1
npm test --prefix db/d1
npm --prefix db/d1 run test:postgres
```

The PostgreSQL test creates its own container with a loopback-only port, random
credentials, a run-specific label and a temporary filesystem. It applies the
checked-in PostgreSQL migrations and inserts synthetic fixtures, then removes
the container. It never uses `DATABASE_URL`, Compose, a previously running
database or production credentials. An interrupted process can leave its owned
container; its `personal-trainer-d1-test` label identifies it. Do not remove
unrelated containers.

SQLite inside Node is used only to validate generated imports and let SQLite's
parser identify complete schema statements, including trigger bodies. The schema
and generated imports are also executed against Wrangler's actual local D1
binding. Passing only the Node SQLite validation is not sufficient.

## Storage contract

`storage.json` is the conversion contract for PostgreSQL columns. The target
schema keeps original column names but stores measured decimals as scaled
integers. For example, `bodyweight.value_kg = 8235` means `82.35 kg`. D1 API
readers must decode these values; the seven views already expose public units.

Some representation differences require an explicit writer responsibility:

- `name_key` and `alias_key` hold Unicode lowercase keys, also on rename. Export
  refuses stored values whose PostgreSQL lowercase differs from JavaScript's
  result. It does not erase accents or merge normalization variants.
- `bodyweight.measured_date` holds the Europe/Rome date derived from the
  instant, including DST. It must change when the instant changes.
- Both weekly views include unfinished and future weeks. Their D1 API readers
  must apply the completed-week cutoff using the Rome calendar. Other views keep
  their prior read semantics, including full-history goal switches and null
  totals on flagged days with no entries.
- Timestamp defaults have statement-time millisecond precision padded to six
  digits. Writers needing one timestamp across a batch must pass it explicitly.
  Imported instants preserve all original microseconds.
- PostgreSQL row locks and interactive transaction callbacks are not emulated.
  Session coordination is implemented as described below. Other topics use
  atomic batches with SQL preconditions and affected-row assertions.
- Public timestamp strings retain the PostgreSQL driver's millisecond JSON
  format. Validation snapshots and stored values retain all six fractional
  digits; an unrelated correction does not round-trip an omitted timestamp.

## Session write coordination

`0002_session_writes.sql` adds an internal session version and an assertion
table. The version is bookkeeping, not a training fact or an API field. SQLite
triggers advance it whenever a set is inserted, changed or removed, or session
facts change. This keeps a future writer from accidentally bypassing the
protocol.

A correction or discard reads one consistent snapshot, validates with the
existing TypeScript rules, and submits one atomic D1 batch. That batch checks
the version, makes the changes, checks affected-row counts, reads the response,
and clears its assertion row. A failed check or response query rolls back the
batch. The assertion table stays empty between successful batches; it is not a
lock held while JavaScript runs.

Only a failed version assertion is retried, at most three attempts. Each attempt
reads and validates again. Uncertain failures are not retried. Exhausted
contention returns 409 and asks the caller to read the record. No provider calls
or other nontransactional side effects belong inside this retry boundary.

Creation and correction send set arrays as bounded JSON parameters rather than
one query or a growing list of bindings per set. Normalized sets can exceed D1's
2 MB value limit even when the original HTTP body fits its 1 MiB limit, so JSON
is split by UTF-8 byte size, with every chunk in the same atomic batch. Tests
exercise 8,000-set creation, 1,500-set reports, SQL readback failures, a
partially applied update, competing writes, discard eligibility, and request
replay. These are persistence tests, not the complete HTTP, authentication, or
hosted-limit verification.

## Plan writes and bounded reference lookups

Plan changes do not need a second version counter. Their membership
preconditions fit in SQL inside the batch. `0003_plan_writes.sql` adds a named
assertion for removal/redose row counts. A lost precondition rolls back the
entire decision, including earlier additions and dose rows. The operation then
re-reads membership and validates again, at most three attempts. Other failed
writes are not retried; reading a completed request by its scoped UUID can
recover its confirmed result.

The displaced intent is captured in the decision's INSERT, inside the same
transaction, rather than from an earlier application read. This keeps concurrent
intent replacements from losing their history. Removal still deletes only
membership. Additions and redoses append history, with the future-plan cutoff
and ID tie-break from ADR-0013. Plan week arithmetic retains the PostgreSQL
integer-division behavior; this port does not change that calculation.

Session creation and plan writes batch distinct exercise and plan references
through bounded JSON parameters. They preserve canonical-name/alias/numeric-ID
precedence and active-plan ambiguity refusals. Caches belong to one attempt.
Tests cover 1,200 distinct exercises, 1,200 explicit past-plan references, and a
1,200-exercise creation/redose under fixed per-call query budgets. These local
checks do not replace hosted CPU, latency, response-size or limit verification.

## Transfer tools: not a live runbook yet

`export.mjs` requires an explicit `D1_SOURCE_DATABASE_URL`, `--writes-frozen`,
and an output path when run as a command. It never falls back to `DATABASE_URL`
or loads `.env`. Use a credential with SELECT access to the required public
tables and sequences. It must be able to read the complete record despite RLS;
export turns `row_security` off so filtering fails instead of silently omitting
records. The transaction itself is read-only. Reads are schema-qualified.

The write-freeze acknowledgment is not a locking mechanism. Stop every writer
before a final export, including scheduled/background Withings operations and
credential rotation. PostgreSQL sequence state is not transactional. A
repeatable-read transaction alone cannot make a live export suitable for
cutover.

The snapshot includes a checksum, source migration history, column types, text
values and sequence state. Decimal values never pass through JSON floating-point
numbers. Instants are range-checked before formatting so BC dates cannot
silently become AD dates. Unsupported array dimensions/bounds, case-policy
differences, unexpected tables and unreadable columns or sequences fail the
export. Inventory uses PostgreSQL catalogs, not privilege-filtered views that
could silently hide added facts.

`convert.mjs` takes a snapshot path and a new output path. It checks the
checksum, source/target columns, conversion types, decimal definitions,
constraints and foreign keys in a fresh local database before writing SQL.
Conversion types are checked even for empty tables and null values; changing a
measured decimal to a float cannot silently change its stored precision. It
preserves both called and uncalled sequence states, including identities
consumed by deleted rows. It rejects IDs outside JavaScript's exact integer
range, nonpositive identities, nonstandard sequence allocation and rows
exceeding the bounded import statement size. It never contacts a destination.

Both files are created exclusively with owner-only permissions. Existing files
are never overwritten. **Snapshots and import SQL contain health records and
provider credentials in plaintext. Keep them private; the checksum is neither
encryption nor a signature.** Their filename patterns are ignored by Git.

Generated SQL assumes `0001_record.sql` has already been applied to a **new,
empty destination**. The same import is also tested with every checked-in
coordination migration already applied; coordination metadata is initialized by
D1 rather than copied from PostgreSQL. Parent tables are loaded first. A guard
rejects nonempty application tables or any previous import, and a receipt
records the source checksum and row counts. It never deletes records, replaces
rows or merges conflicts. A receipt is not independent proof of every imported
value; verify readback before any traffic switch.

Wrangler/hosted D1 can commit an import in chunks. If any chunk fails, discard
that destination and diagnose the failure. Do not rerun into partially imported
state, do not make it live, and do not assume a Worker rollback restores records
or provider credentials. Database creation, hosted import, validation and
recovery commands will be added with the hosted rehearsal, not guessed here.

## Hosted activation remaining

The registry, training state/volume, nutrition, authentication and Withings
ports are implemented. The complete HTTP contract suite runs on the Worker entry
point with isolated D1 bindings. The dashboard also targets Workers and has no
database binding.

1. Verify hosted limits, the complete data transfer and recovery on disposable
   resources. Local results do not establish the hosted operating limits.
2. Configure production secrets and follow the write freeze, final export,
   import verification and traffic-switch procedure in `docs/hosting.md`.
3. Verify both public Workers and Withings synchronization before retiring the
   old applications. Preserve the source database and recovery material; do not
   delete unrelated VPS consumers.
