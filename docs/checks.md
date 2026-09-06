# Checks

## Dependency review (#68)

Reviewed on 6 September 2026, against base `424ae3a`, on Deno 2.9.6:

- Hono 4.13.0 → [4.13.7](https://github.com/honojs/hono/releases/tag/v4.13.7).
  Includes routing/request fixes and the 4.13.5
  [query-fragment fix](https://github.com/honojs/hono/security/advisories/GHSA-crvj-82cr-hjcx).
  That advisory requires literal fragments to reach the app; hosted exposure
  was not tested. JSX/SSG/cache/dot-form features named by other advisories are
  not used here; no claim of a demonstrated production exploit.
- zod-openapi 1.6.1 → [1.6.3](https://github.com/honojs/middleware/releases/tag/%40hono%2Fzod-openapi%401.6.3).
  Includes type-checking improvements and a new Content-Type gate returning 415.
  The API's existing normalization/object checks preserve its supported JSON
  forgiveness and actionable 422s without a production-code change.
- Required transitive zod-validator 0.9.0 →
  [0.9.1](https://github.com/honojs/middleware/releases/tag/%40hono%2Fzod-validator%400.9.1)
  caches case-insensitive header schema metadata. JSR imports, one Hono/Zod
  identity, and all unrelated locked versions remain unchanged.

Generated OpenAPI compared equal before/after. `tests/auth_test.ts` adds a
media-type matrix covering successful writes/replays, missing/wrong headers,
strict field/object refusals, doubled prefixes and body-less sync routing.
Local validation: **162 tests / 518 steps**, production image build and
**4 shutdown scenarios**, format, lint, type checks and frozen dependency
installation passed. Test databases were identity-verified and disposable.
These are local results, not GitHub CI, deployment or installed-plugin proof.

## Test groups and coverage

- `deno task test:pure`: selected arithmetic, property and document checks; no
  network permission, no Docker, no destructive setup.
- `deno task test:stubs`: loopback-only protocol/request checks. Mixed Withings
  and GitHub files use explicit test-name filters; their destructive helpers
  are imported only inside database tests. No disposable receipt is needed.
- `deno task test [files...]`: the full suite (including database and mixed
  modules), or named files, through the disposable identity gate. Other mixed
  files such as dates, migrations and MCP belong here unless their imports and
  selected cases have been checked explicitly. Never use a name filter as a
  substitute for the database gate.
- `deno task test:shutdown` and `deno task test:secrets`: separate Docker/tool
  checks described below and in `hosting.md`.

`deno task coverage [files...]` uses the same disposable harness and collects
raw profiles from both the HTTP API and the test process. The API must exit
cleanly before reporting; a profile must show its HTTP handler actually ran.
Each invocation gets its own ignored `coverage/<run>/` directory, with separate
`api/` and `tests/` profiles and labeled `api.txt`, `tests.txt`, `combined.txt`
reports filtered to API source (not dependencies, test helpers or generated
artifacts). CI retains that directory as an artifact. Empty test-process API
coverage is reported honestly, not treated as missing server coverage.

For a small proof, run `deno task coverage tests/coverage_http_test.ts`: it
imports no handler and exercises the doubled-prefix branch over HTTP. For
uncovered source lines use `deno coverage --detailed --include='.*/api/.*'
coverage/<run>/api coverage/<run>/tests`. Profile offsets belong to that source
revision; rerun after source edits rather than merging unrelated runs.

Initial #69 local full run: **161 tests / 510 steps passed**. API-source line
coverage was **88.3% in the HTTP process**, **68.8% in the test process**, and
**96.8% combined** (combined branch coverage 93.8%). These are measured scopes,
not a target percentage or proof of behavior. Standalone container lifecycle
and scanner tests are separate; their process coverage is not included.
A controlled failing test also preserved its failure, flushed both profiles,
stopped the API and removed the owned database.

Meaningful gaps inspected in those profiles:

- Database readiness timeout/cancellation and interrupted inbound body reads
  still need dedicated fault-injection cases.
- Withings catch-up suppression while pending/stopping and missing-provider
  configuration deserve direct assertions.
- The forced shutdown branch is tested by the container suite but absent from
  these native-process profiles; do not mistake that scope gap for no test.
- Smaller refusal gaps include excessive report document names and empty
  actual-set patches. Add cases for their contracts, not to chase a percentage.

## Secrets

`deno task secrets` scans the complete Git index, both in the commit hook and
CI. It does not scan untracked files, working-tree-only edits, or past commits.
A credential committed and subsequently removed needs separate history review
and rotation; this check cannot prove the repository has never held secrets.

The scanner is Gitleaks 8.30.1, pinned by its published container digest in
`scripts/secrets.ts` ([release](https://github.com/gitleaks/gitleaks/releases/tag/v8.30.1)).
Docker is required locally. The container receives only a temporary copy of the
index, read-only, with networking disabled. Protected environment filenames are
refused before copying. Scanner errors fail closed; output exposes rule/location,
not source lines or matched credentials. No current fixtures need allowances.

If a new synthetic fixture genuinely needs an exception, use an exact value AND
exact path in a reviewed `.gitleaks.toml` allowance extending the default rules.
Never exempt all tests, disable default rules, or use inline bypass comments.
`deno task test:secrets` checks refusal, index-versus-working-file behavior,
protected filenames, redaction and narrowly scoped fixture allowances in a
temporary repository. CI runs that check too; bypassing local hooks does not
bypass the CI scan. Neither check uploads findings.

## Request diagnostics

Each HTTP attempt receives a generated `X-Request-ID`; internal-error sentences
carry the same diagnostic ID. Server records contain that ID, method, registered
route template, status, elapsed handler time and an unexpected-error marker.
Headers, bodies, query values, raw paths and exception text/stacks are omitted,
not passed through a best-effort secret regex. Provider logs retain counts and
fixed failure categories, not account/measurement values. This trades detailed
exception dumps for privacy: reproduce unexpected errors on disposable state
when the route/status record alone does not explain them.

A diagnostic ID is not the stable write `request_id`. Failed responses do not
prove rollback, especially across GitHub delivery and the local ledger.

## Hosting wording inventory (#67)

Reviewed active `api/`, `plugin/`, `scripts/` and `docs/hosting.md` references to
edge runtimes, isolates, Deno Deploy, free-project pausing and function logs.
The obsolete health rationale in `api/index.ts` changed with #55. This sweep
updates the Withings catch-up/notification explanations, import-free client/JWT
comments, and the API mount-prefix explanation. `withings_client.ts` also no
longer names the retired `outside/` directory.

Historical ADRs and applied migrations retain their original context. Ordinary
programming uses of “function” stay. The caller-facing “function logs” error is
tracked separately in #59, not changed as a comment cleanup. No runtime behavior
changes under #67; `tests/hosting_wording_test.ts` checks the active explanations.
