# Checks

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
