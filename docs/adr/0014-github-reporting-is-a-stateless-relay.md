# GitHub reporting is a stateless relay

ADR-0007 makes the skill the coach and the API the record. Its reporting channel
remains: the coach sends sanitized evidence to the API, which files a GitHub
issue with the server's GitHub credential. ADR-0009's credential policies remain
unchanged. This decision does not grant web sessions write access or remove the
database used by request authentication.

## GitHub is the only record of reports

The `coach_issues` table stored enough of a GitHub result to replay a successful
creation. Issue creation also held a PostgreSQL advisory lock across the GitHub
call. That bookkeeping did not close the gap between GitHub accepting a write
and the local transaction committing. It made reporting depend on the training
record without guaranteeing exactly-once delivery.

The API now relays issue listing, creation and comments without issue-specific
database queries, transactions, locks or receipts. The migration
`20260908150000_github_issues_leave_the_record.sql` drops `coach_issues`. Existing
GitHub issues are untouched. This supersedes the replay contract described by
`20260825120000_coach_issues.sql`; historical migrations remain unchanged.

Validation, public-evidence privacy checks, server-side GitHub configuration,
outbound deadlines and HTTP error translation stay in place. Only a validated
GitHub creation response produces a success with an issue number and URL.

## Correlation is not deduplication

Creation still requires `request_id`, a UUID included in the GitHub issue body.
It identifies the intended report for reconciliation, not a stored receipt or
an idempotency key. Every successful creation returns 201. Repeating the same
request, sequentially or concurrently, may create another issue. There is no
200 replay response and no replay guarantee. Comments have no deduplication.

A timeout, lost response, malformed success or server error after a write does
not prove that GitHub rejected it. The relay never retries a write automatically.
The coach must stop reporting for that incident, say delivery is unknown when
appropriate, and never blindly retry. A later explicit reconciliation inspects
GitHub issue bodies for the correlation marker, including closed issues, and
checks comments on the destination issue. An incomplete open-issue list cannot
prove non-delivery. If the outcome remains uncertain, leave it unresolved rather
than submitting another write.

## Tests hold the boundary

Issue-route tests run against a local GitHub stub without access to
`DATABASE_URL`, with resource and operation sanitizers enabled. They cover
successful relay, repeated correlation IDs, privacy refusals, configuration
failures and uncertain writes without automatic retry. Document tests require
the correlation-only contract and GitHub reconciliation instructions. The old
database uniqueness and cross-process advisory-lock tests are removed because
they asserted the bookkeeping this decision removes.
