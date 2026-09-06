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
