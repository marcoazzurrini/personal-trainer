## Agent skills

### Issue tracker

Issues live as GitHub issues on `marcoazzurrini/personal-trainer`, managed with
the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles, each label string equal to its name. See
`docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` and `docs/adr/` at the repo root. See
`docs/agents/domain.md`.

### Hosting and local dev

The API runs on a Hetzner VPS under Coolify; locally it is one Postgres
container and `deno task dev`. See `docs/agents/hosting.md` and ADR-0008.
