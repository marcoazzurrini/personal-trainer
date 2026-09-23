# Hosting and recovery

The application runs on Cloudflare under ADR-0015. The API Worker owns the D1
record. The dashboard Worker has no database binding and reads through the API.
Worker names, bindings, routes and schedules belong in the Wrangler files;
commands belong in the package manifests. Configuration examples document
variables, not real credentials.

The September 2026 production transfer is recorded in
[the cutover receipt](cloudflare-cutover.md). A successful local test, build or
upload alone does not establish that production has switched; the receipt
identifies the final hosted comparison and independently restored backup.

## Local development and tests

Wrangler supplies local Workers and D1. Normal application development no longer
requires a PostgreSQL service, Docker Compose or a Coolify installation.

Destructive tests must own an isolated, in-memory D1 binding. They must not read
local secret files, use remote bindings or inherit provider credentials. A URL
on localhost is not proof of isolation: a tunnel can reach production there.
The test harness establishes its own database identity before setup or writes
and denies unconfigured outbound requests. SQL failure injection belongs only
in that test harness, never in the deployed Worker.

The historical PostgreSQL migrations and their disposable comparison suite
remain only to verify the one-time transfer. PostgreSQL is not an application
runtime dependency. Import snapshots and generated SQL contain private records
and credentials; keep them in ignored, owner-only storage and never upload them
as CI artifacts.

## Authentication and secrets

Keep the public API and dashboard hostnames stable during the hosting change.
The connector's resource indicator, WorkOS callback URLs, dashboard API URL and
Withings notification subscription must continue to agree with those addresses.
Register a different address with its provider before changing the application
origin; redirects do not repair an OAuth audience mismatch.

The connector and dashboard still use distinct credential policies. A dashboard
session may read the explicitly allowed API endpoint, not write the record.
Copy the actual hosted account configuration, not placeholders from a local
example file. Missing or inconsistent authentication settings must fail closed.

Store runtime credentials as Worker secrets. Do not put values in Wrangler
configuration, build arguments, source files, logs or CI output. Use a narrowly
scoped Cloudflare deployment token in GitHub secrets; interactive Wrangler OAuth
is for the operator's session, not a credential to copy into CI. The dashboard's
cookie-encryption secret must survive a hosting change if existing sessions are
to remain readable.

## Release ownership and evidence

CI serializes the complete release: apply compatible database migrations,
upload the tested API artifact, verify its public readiness, then release and
verify the dashboard. Pull requests do not deploy. Do not run an overlapping
manual deployment or edit bindings while a release is in progress.

Readiness must identify the artifact that was built, not an expected revision
supplied in a runtime environment variable. Clean CI builds name their checked
out commit. An uncommitted operator build must not pretend to be that commit;
its content digest identifies the built artifact instead. Verify the expected
identity using uncached HTTPS requests after upload. An old, healthy Worker
cannot satisfy a check for a different build.

A failed verification can mean the new Worker or a schema change is already
live. Inspect deployment history, public health and database state before
retrying. Do not interpret a red job as proof that nothing changed.

Database migrations are an explicit release step, never request startup work.
They must remain compatible with the previous Worker while deployments overlap.
Worker rollback replaces code and configuration; it does not undo D1 migrations,
record writes, token revocations or provider-side changes.

## Background work

A Cron Trigger owns periodic Withings catch-up. Public health checks must not
refresh credentials or become an undocumented scheduler. Webhook and scheduled
work use the invocation's lifetime mechanism; a detached promise is not a
reliable background job.

Only one environment may actively synchronize the real Withings account.
The old API must stop before the final export and must remain stopped after the
new scheduler is enabled. Copying an old database back can restore an already
rotated refresh token; provider credentials need separate reconciliation.

## Database recovery

D1 Time Travel is the short-term recovery mechanism. Check the account's actual
retention window; Free and Paid plans differ. Restoring overwrites current data
and cancels in-flight queries. Pause writers and background synchronization,
record the current restore position, and identify exactly which later writes
would be lost before restoring.

Keep a private portable export before major schema changes and the original
PostgreSQL snapshot from the hosting transfer. Test an export by importing it
into a different, explicitly identified database. A successful download or SQL
parse is not a restore drill. Verify foreign keys, record counts, identity
allocation, representative API reads and the derived views before trusting the
recovery path.

A portable export contains sensitive records and provider credentials. Keep
backup storage private, use an explicit retention policy and confirm that
operators can recover it without the machine that originally created it.
Time Travel and same-account storage do not protect against every account-loss
scenario.

## Initial traffic switch

1. Verify the new Workers, secrets, schema and data-transfer rehearsal without
   sending production traffic to the new API or enabling its scheduler.
2. Pause the old API and its background work. Leave the source database and
   backups intact. A final consistent read-only export must happen after this
   write pause, not before it.
3. Import into an empty destination and verify the complete transfer. If an
   import fails midway, discard that unused destination rather than guessing
   which chunks committed or merging into an existing record.
4. Attach the existing public hostnames to the verified Workers. Confirm TLS,
   artifact identity, sign-in refusals, authenticated reads and dashboard access.
5. Enable the new scheduler only after the new API owns production traffic.
   Verify the actual Withings subscription and credentials without running two
   competing refreshers.
6. Keep the previous database and backups available for recovery. Once the new
   API accepts writes, returning to PostgreSQL requires accounting for those
   writes and provider-side changes; DNS reversal alone is not a safe rollback.

Stopping these applications is not permission to delete a shared VPS or its
backups. Inventory other consumers first. Remove obsolete CI credentials and
retire the old infrastructure only after the retained recovery path and the
scope of deletion are explicit.
