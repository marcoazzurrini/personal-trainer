# Workers and D1 replace the managed VPS for the record

Status: accepted and in production. This replaces ADR-0008's runtime and
database hosting and ADR-0009's dashboard container deployment. The final data
comparison, recovery rehearsal and hosted switch are recorded separately in
[the cutover receipt](../cloudflare-cutover.md).

## Why change

The goal is less total maintenance, not fewer application lines. Maintaining the
operating system, Coolify, containers, PostgreSQL, networking and recovery on a
VPS is a larger responsibility than this personal application needs. Additional
well-contained, tested application code can be a worthwhile exchange for
removing that work. Deployment, secrets, monitoring and recovery still remain on
a managed platform; they are not free of responsibility.

The approved destination is a Cloudflare Worker for the API and D1 for the
record. A local D1 session experiment demonstrated atomic correction and discard
using optimistic concurrency: a version check inside the write batch, with
bounded retries after re-reading and revalidating. That experiment establishes a
viable mechanism, not the correctness of a complete migration or hosted release.

## What does not change

The skill remains the coach. The connector signs in and returns one token. The
API owns the record and arithmetic, and the dashboard reads through the API.
Moving hosting does not give the dashboard coach write privileges. The public
origin, `/api` paths, sign-in audience and refusal contracts should remain
stable.

ADRs 0011–0013 still define which facts are authoritative. The migration must
not bring back intake snapshots, stored automatic goal-switch rows, or
current-dose copies. IDs, nulls, decimal rounding, timestamp precision,
historical winners and retry behavior are part of the record, not expendable
implementation details.

## The database boundary

D1's SQLite schema is a new baseline of the final PostgreSQL schema. Historical
PostgreSQL files remain as provenance and as the reference for migration tests;
their old backfills and deletions are not replayed over exported current
records.

Measured decimals use bounded scaled integers. JSON and arrays use validated
text; booleans use zero and one. Instants preserve six UTC fractional digits.
Unicode case keys and the Rome day for bodyweight are supplied by the API and
importer, because SQLite does not reproduce PostgreSQL's Unicode case behavior
or named-timezone conversion. Tests must hold those writer responsibilities. The
two weekly views include all weeks; their D1 API readers apply the
completed-week cutoff using the Rome calendar. The other view contracts remain
unchanged.

D1 batches are atomic, but do not hold a transaction open while TypeScript reads
and validates. Writers requiring that coordination must use explicit
preconditions inside the same batch as their writes. A mismatch must raise a SQL
error before commit, not be noticed after a successful batch. A reusable
implementation and its concurrency tests belong to the API port, not the
migration import scripts. No Durable Object, queue or distributed lock is
introduced without a demonstrated need that justifies its continuing
maintenance.

Session writes use an internal version advanced by SQLite triggers on relevant
session and set changes. Database-owned bookkeeping is preferable to requiring
every present and future writer to remember a separate version increment. The
version is not a coaching decision or a public record field. A short-lived
assertion row turns stale versions and incomplete row counts into SQL errors
inside the write batch; the row is removed in that same batch. It is never a
lock held across JavaScript execution.

Plan decisions use conditional SQL and affected-row assertions in one batch,
not another version counter. Removal and redose require current membership at
write time; a failed precondition rolls back every sibling change and causes
revalidation. The displaced intent is read inside the decision's INSERT so two
concurrent replacements cannot both record a stale prior intent. Dose history
and current membership remain independent under ADR-0013.

The persistence modules accept the D1 binding explicitly. They reuse the
existing validation and arithmetic rules, not a PostgreSQL-compatible query
layer. The complete HTTP and authentication suites run against the actual
Worker entrypoint and isolated D1 bindings. Temporary PostgreSQL runtime modules
have been removed; only historical SQL migrations and the isolated transfer
comparison retain PostgreSQL.

## Delivery and recovery

The database schema, offline transfer tools, API port and full contract tests
were implemented before changing the running PostgreSQL application. Hosted
rehearsal and the traffic switch remain distinct operations. Database migrations
are an explicit release step, not work performed by a Worker request.

A final transfer requires a reviewed write freeze, including Withings background
work and token rotation. A read-only consistent export preserves every source
table and identity state. Import is into a new destination, never a merge into
live records. Validation and a receipt do not make a chunked import atomic: a
failed destination is discarded, not resumed or made live.

Switching live traffic is a separate operation after data verification and a
recovery rehearsal. Rolling back Worker code does not roll back database writes
or provider-side credential rotation. No production access, deployment, database
creation or traffic switch is implied by running the local migration tests.

The dashboard also targets Workers, without a D1 binding. Its server, browser
and workerd tests protect authentication and the existing API boundary. CI
serializes both deployments and verifies their immutable build identities.
Moving these applications still does not authorize deletion of other VPS
consumers or retained backups; remaining operational work must be counted
honestly.
