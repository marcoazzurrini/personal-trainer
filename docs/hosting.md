# Hosting

Where the API runs, how it gets there, and how to recover it. The decision is
ADR-0008. What the repository already states is left out: the commands are in
`deno.json`, the local stack in `compose.yaml`, the variables in
`.env.example`, the pipeline in `.github/workflows/ci.yml`.

## Two things the config files do not say

`deno task test` owns a fresh, labelled Postgres container with tmpfs storage,
random database/password and loopback-only publication. Before migrations it
reads the cluster system identifier through that container, then verifies the
network connection against it and the database name. The test-only API checks
its actual SQL singleton and exposes a read-only identity probe; helpers verify
both identities before their import-time token mint or any API write. Direct
DB suites verify the same receipt before setup. Missing receipts and conflicting
URL overrides fail closed; localhost alone is not proof (see the tunnel below).
The harness does not read `.env` or forward provider credentials, and restricts
child network access to loopback. It removes only its own container/state in a
`finally` block. A killed harness may require `docker rm -fv <printed-container-id>`;
never remove a development container to repair a test run.

Use `deno task test tests/nutrition_test.ts` (substitute an existing test file) for
a focused disposable run. Do not run destructive suites against `deno task dev`.
The generated receipt is temporary, not a supported manually configured test
environment. Production migrations still use the operator-facing migration task;
that task is not test setup.

DB-free checks need no Docker or receipt, for example:

```sh
deno test --allow-read --allow-env tests/rules_purity_test.ts tests/training_props_test.ts
deno test --allow-net=127.0.0.1,0.0.0.0 --allow-env --allow-read --filter '/withings tokens|withings reads|withings measurement|withings scaling/' tests/withings_test.ts
deno test --allow-net=127.0.0.1,0.0.0.0 --allow-env --allow-read --filter '/issue body|github client/' tests/issues_test.ts
```

Mixed suites import the destructive helper only inside their live tests, so a
name filter on these stub checks no longer mints a token during module loading.

The container runs `deno task migrate` before it serves, so a migration that
fails is a deploy that never becomes healthy and the old container keeps
answering. For the minute both run, write migrations the old container can
live with.

## Stopping and deployment overlap

SIGTERM reaches the API through the image's real `deno task start` entrypoint.
The API stops accepting requests and scheduling catch-up, drains both, then
closes Postgres. An unfinished drain exits nonzero at the bound in
`api/index.ts`; an interrupted operation may already have durable side effects.
Keep the host/container stop grace at Docker's default or longer, never below
that application deadline. Verify any Coolify stop-timeout override before
release; the local container test does not establish the deployed setting.

`deno task test:shutdown` builds the production image and exercises it against
the same identity-verified disposable cluster, using a private test network
and synthetic credentials only. Controlled SQL locks prove completed work
survives termination, new HTTP work stops, stuck work cannot wait forever,
termination during migration never starts HTTP, and startup errors omit
credentials. It removes only its own containers, network and image. CI runs it;
a successful image build alone is no longer the container check.

## Hosted

- **Server**: one Hetzner CX23 in Germany, Ubuntu 24.04, Coolify installed
  from its script, auto-update off. Dashboard at
  `https://coolify.marcoazzurrini.com`.
- **Firewall**: the Hetzner Cloud Firewall, inbound 22, 80, 443 only. Docker
  bypasses ufw, so that firewall is the real one. Postgres is never published
  on a host port.
- **Database**: a Coolify PostgreSQL resource, image `postgres:17-alpine`,
  reached by the API over Coolify's internal network as `postgres-<uuid>`.
  Shared by future projects, one database each.
- **Application**: built from this repository's `Dockerfile` by Coolify's
  GitHub App, port 8000, domain `https://trainer.marcoazzurrini.com`, health
  path `/api/health`. Traefik ends TLS and sets `x-forwarded-proto`.
- **Deploy**: CI posts to Coolify's deploy webhook on a green main. Coolify's
  own deploy-on-push is off, so a red main never ships. The webhook URL and
  token are the GitHub secrets `COOLIFY_WEBHOOK` and `COOLIFY_TOKEN`.
- **Sign-in**: AuthKit only issues tokens for resource addresses it knows.
  WorkOS dashboard > Connect > Configuration > MCP resource indicators must
  list `https://trainer.marcoazzurrini.com/api/mcp`, or every connector
  sign-in fails with `invalid_target`. Add the new address there before the
  origin ever changes again.
- **Secrets**: the application's environment variables in Coolify, marked as
  secrets: `API_TOKEN`, `API_TOKEN_PREVIOUS`, `DATABASE_URL`, `AUTH_ISSUER`,
  `ALLOWED_SUBJECT`, `WITHINGS_CLIENT_ID`, `WITHINGS_CLIENT_SECRET`,
  `GITHUB_TOKEN`, `GITHUB_REPO`. `PORT` is 8000. `PUBLIC_ORIGIN` stays unset
  unless the proxy's headers ever stop being enough.
- **Backups**: Coolify's scheduled `pg_dump` of the database, nightly, kept
  seven days locally and thirty on the Cloudflare R2 bucket
  `personal-trainer-backups`. Coolify's own database goes to the same bucket.
  Off the server, in the password manager: the Coolify `APP_KEY` from
  `/data/coolify/source/.env` and the keys under `/data/coolify/ssh/keys`.

## Restore drill

Do this once after the first backup and whenever the restore path changes.

```sh
deno task db
docker exec -i personal-trainer-postgres-1 psql -U postgres -c 'create database drill'
docker exec -i personal-trainer-postgres-1 pg_restore -U postgres -d drill \
  --no-owner --no-privileges < the-downloaded.dump
docker exec -i personal-trainer-postgres-1 psql -U postgres -d drill \
  -c 'select count(*) from sets'
```

The count should match production's. Drop `drill` after.

## Reaching the hosted database

It is not on the internet. Open an SSH tunnel to the server and forward the
container's port, then use `postgresql://…@127.0.0.1:<local port>/trainer` as
`DATABASE_URL` for the one command, for instance
`deno task migrate -- --status` or `scripts/seed_withings.ts`.
