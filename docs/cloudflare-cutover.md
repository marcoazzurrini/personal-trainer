# Cloudflare production transfer

The existing API and dashboard hostnames now belong to their Cloudflare Workers.
D1 is the authoritative record. The transfer did not enable a paid Workers plan.
The arbitrary paid-plan CPU override was removed; a representative hosted
workload was exercised on Free before switching production.

## Final data, not the rehearsal snapshot

The old API and dashboard were stopped and their automatic deployments and
container restarts disabled before the final PostgreSQL export on 22 September
2026. The source database was fenced read-only. This was a new export, not the
16 September rehearsal snapshot.

The hosted destination matched all 1,751 source rows across 27 tables, including
the workouts logged since the rehearsal. Verification compared complete rows,
all seven derived views, identity allocation, coordination versions, migrations,
foreign keys, integrity and the complete destination schema. Expected counts in
an import receipt were not treated as proof of a correct transfer.

A portable export from that destination was then restored into a separate hosted
D1 database and passed the same verification. These comparisons happened before
production traffic was attached. Production can now accept new records; do not
re-import the original snapshot or expect subsequent live hashes to stay equal.

## Production checks and cleanup

Both production health checks matched their uploaded artifacts. Authentication
boundaries, the dashboard sign-in redirect, connector discovery, and an
authenticated API read were checked. A real Withings notification fetched the
provider's measurements successfully, preserved the migrated account and its
existing webhook subscription, and advanced its synchronization checkpoint.
The six-hour scheduled catch-up is enabled in production and in the deployment
configuration.

The previous API, dashboard and PostgreSQL containers are stopped with automatic
restart disabled. Their retained volumes are recovery material, not a second
live record. The disposable rehearsal databases and CPU-probe Worker were
removed. Other applications on the shared VPS and Cloudflare account were not
changed.

## Private evidence and recovery

The owner-only, ignored `.cache/cloudflare-transfer/` directory contains:

- `final-20260922.snapshot.json`: the frozen, consistent source snapshot.
- `final-verification.json`: the complete hosted comparison.
- `final-d1-portable.sql`: the independently restored portable export.
- `final-recovery-verification.json`: verification of the separate restoration.
- `final-recovery-manifest.json`: hashes, database identities and retention policy.
- `production-readiness.json`: public and authenticated API checks.
- `production-withings-ready.json`: provider synchronization and subscription checks.
- `temporary-resources-retired.json`: scoped cleanup and retained recovery copies.

The original PostgreSQL dump and matching portable D1 backup also exist on the
previous host in `/root/trainer-migration-20260922/`. Backup checksums were
compared across machines. Access is through the existing operator SSH identity;
credentials and record contents are not documented here or committed to Git.

Keep the original PostgreSQL volume, its dump, the portable export and the
verified recovery copy until **at least 22 October 2026**. Deletion additionally
requires explicit approval; the date is not an automatic deletion instruction.
The VPS is shared with other applications and must not be deleted as migration
cleanup.

Once D1 has accepted writes or Withings has rotated credentials, restarting the
old API is not rollback. Recovery must reconcile those later facts and provider
credentials. Follow [the recovery runbook](hosting.md#database-recovery).

## Release identity

The initial cutover used tested operator-built artifacts. The then-uncommitted
working tree was identified by content digests, not falsely labelled as its
previous Git commit. Health checks for both public hosts identified those actual
artifacts.

Subsequent releases use `.github/workflows/ci.yml`: test the committed revision,
apply pending D1 migrations, deploy and verify the API, then deploy and verify
the dashboard. Routine deployment never re-imports the transfer snapshot.
Legacy Coolify and Supabase repository secrets have been removed; only the
Cloudflare deployment credentials remain.
