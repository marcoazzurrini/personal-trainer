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

Use `deno task test api/tests/nutrition_test.ts` (substitute an existing test file) for
a focused disposable run. Do not run destructive suites against `deno task dev`.
The generated receipt is temporary, not a supported manually configured test
environment. Production migrations still use the operator-facing migration task;
that task is not test setup.

DB-free checks need no Docker or receipt, for example:

```sh
deno test --allow-read --allow-env api/tests/rules_purity_test.ts api/tests/training_props_test.ts
deno test --allow-net=127.0.0.1,0.0.0.0 --allow-env --allow-read --filter '/withings tokens|withings reads|withings measurement|withings scaling/' api/tests/withings_test.ts
deno test --allow-net=127.0.0.1,0.0.0.0 --allow-env --allow-read --filter '/issue body|github client/' api/tests/issues_test.ts
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
Keep the host/container stop grace longer than that application deadline.
Coolify supplies its own timeout when stopping an application; an unset Docker
container `StopTimeout` is not proof of the timeout used during deployment.

Verified read-only on 6 September 2026: the installed Coolify 4.3.14 runs in
production mode without Swarm. This application's `stop_grace_period` is null
in Coolify's settings, so `ApplicationSetting::stopGracePeriodSeconds()` and
`deploymentStopGracePeriodSeconds()` resolve to its 30-second default. Both
`StopApplication` and `ApplicationDeploymentJob::graceful_shutdown_container()`
pass that value to `dockerStopCommand`, which emits `docker stop --timeout=30`
for the installed Docker 29.7.2. The running container has no stop-signal or
timeout override. Thirty seconds accommodates the new API's eight-second drain
bound; no host setting change is needed. Recheck after changing Coolify or its
application settings.

Evidence came from SSH container inspection, installed Coolify source, and a
read-only query of Coolify's own application settings—not the training database.
No live stop or deployment was performed during that inspection. The running
image then named `04d6662`. A later read-only inspection on 9 September 2026 found
image tag `b0d4562739c0a04028e9a68c19b4d721005ae24e` running and Docker-healthy;
Coolify records that deployment as finished. This is observed state, not proof
that the new revision-verifying release path has run.

`deno task test:shutdown` builds the production image and exercises it against
the same identity-verified disposable cluster, using a private test network
and synthetic credentials only. Controlled SQL locks prove completed work
survives termination, new HTTP work stops, stuck work cannot wait forever,
termination during migration never starts HTTP, and startup errors omit
credentials. It removes only its own containers, network and image. CI runs it;
a successful image build alone is no longer the container check. The same path
also starts the image against a second, initially empty database on that verified
cluster. It checks the applied migration versions, public routing, authentication
refusals, and the embedded revision. The existing drain case exercises an
authenticated write. Synthetic build metadata belongs only to this disposable
test; it is not a claim about a dirty local checkout.

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
- **Deploy**: the release job pins the tested commit, requests deployment, and
  waits for that deployment and the public API's revision-aware readiness check.
  Coolify's own deploy-on-push stays off. A failed release verification can mean
  the new container is already running; a red job does not prove that nothing
  shipped. The prerequisites and verification limits are below.
- **Sign-in**: AuthKit only issues tokens for resource addresses it knows.
  WorkOS dashboard > Connect > Configuration > MCP resource indicators must
  list `https://trainer.marcoazzurrini.com/api/mcp`, or every connector
  sign-in fails with `invalid_target`. Add the new address there before the
  origin ever changes again.
- **Secrets**: the application's environment variables in Coolify, marked as
  secrets: `DATABASE_URL`, `AUTH_ISSUER`,
  `ALLOWED_SUBJECT`, `WITHINGS_CLIENT_ID`, `WITHINGS_CLIENT_SECRET`,
  `GITHUB_TOKEN`, `GITHUB_REPO`. `PORT` is 8000. `PUBLIC_ORIGIN` stays unset
  unless the proxy's headers ever stop being enough.
- **Backups**: Coolify's scheduled `pg_dump` of the database, nightly, kept
  seven days locally and thirty on the Cloudflare R2 bucket
  `personal-trainer-backups`. Coolify's own database goes to the same bucket.
  Off the server, in the password manager: the Coolify `APP_KEY` from
  `/data/coolify/source/.env` and the keys under `/data/coolify/ssh/keys`.

## Exact-revision deployment (#63)

The installed Coolify contract was inspected read-only on 9 September 2026,
through SSH, selected columns in Coolify's own database, and installed source.
The training database was not inspected. No deployment, application update, or
secret change was performed.

Coolify 4.3.14's `DeployController::deploy_resource()` does not pass a commit
from the deploy request. `queue_application_deployment()` instead copies the
application's `git_commit_sha` into the queue row. `ApplicationDeploymentJob`
uses that queued value; branch-head resolution applies only to `HEAD` or an empty
value. `Application::setGitImportSettings()` fetches/checks out the explicit
commit and fails if checkout fails. This is why appending an expected SHA to the
old webhook would not fix the race.

At inspection this application used `main` and `git_commit_sha=HEAD`, Dockerfile
builds, automatic and preview deployment disabled, build secrets disabled,
Dockerfile build-argument injection enabled, and source-commit injection disabled.
Coolify's separate health-check switch was off: it detected and used the
Dockerfile's `/api/health` check instead. The panel's unused health path was `/`,
not the effective check.

Release prerequisites and operator checks:

1. **Include Source Commit in Build** is now enabled (setup record below). Keep
   Dockerfile argument injection enabled and build secrets disabled. Do not add
   a custom `SOURCE_COMMIT` environment variable or build override: Coolify must
   supply the commit it actually checks out.
2. The CI token now has `read`, `write`, and `deploy` abilities (verification
   below). Recheck access after changing the token or application ownership.
   Sensitive-value read access is not needed. Keep the token in GitHub secrets;
   never paste its value into logs, issues, or this document.
3. Keep CI as the only deployment/configuration writer during a release. Do not
   change source/build settings manually while a release job is running. The
   existing deployment concurrency group now covers pinning through verification.
4. After an approved release, confirm its main CI run completes successfully.
   Hosted prerequisites are prepared and the first live release is verified
   below. Repository tests and operator setup alone do not establish a release.

Setup record, 9 September 2026: after Marco approved preparing Coolify, the
application-settings model was used through the administrative console to enable
`include_source_commit_in_build`, and a fresh read confirmed the value. No custom
`SOURCE_COMMIT` environment entry exists. The deployment count did not change;
no deployment was requested. Other application settings were not changed.

The token in the ignored local hosting file was matched by its hash to Coolify's
`github-ci deploy, no expiry` token. It initially had only `deploy`, and an actual
application read returned HTTP 403. After Marco explicitly approved the expanded
configuration access, its abilities were changed to exactly `read`, `write`, and
`deploy`; sensitive-value read access was not added. Its value and expiry were
not changed.

Actual API calls with that token then successfully read the application, wrote
`include_source_commit_in_build=true` again without changing its value, and read
an existing deployment. The same verified token was uploaded to GitHub's
`COOLIFY_TOKEN` secret through standard input; GitHub reported the secret updated
at `2026-09-09T16:44:32Z`. No credential value was displayed or recorded here.
The webhook secret was not changed. A final inspection confirmed the deployment
count remained 13, the commit pin remained `HEAD`, and Coolify still reported the
application running and healthy. No deployment was requested during setup. The
shared SSH connection was closed before the release.

First live verification, 9 September 2026: commit
`3698b2310d1dbf77bd665b40f724731a04cb8813` passed all three jobs in
[CI run 34378987395](https://github.com/marcoazzurrini/personal-trainer/actions/runs/34378987395).
The release job verified Coolify deployment `rdgxblrat2ug8mgoczkgu0j6` and reported
that exact tested revision live and healthy at `2026-09-09T16:51:09Z`. A separate
uncached public `/api/health` read returned HTTP 200, `status: "ok"`, the same full
revision, and `Cache-Control: no-store`. This establishes the first end-to-end
release through CI, including the actual GitHub secrets and inspected Coolify
contract. It is a dated observation, not a claim of continuous availability.

The release script updates the application's commit pin before requesting a
forced build, verifies the pin, then checks the returned deployment ID and queued
commit. A later branch push cannot change that queued commit. Another queued or
manual build cannot satisfy this job merely by becoming healthy. The application
pin intentionally remains at the tested commit after success or failure; the next
release updates it. A manual deploy therefore reuses that pin, not moving `main`.

Coolify supplies `SOURCE_COMMIT` from the same commit it checks out. The Dockerfile
requires a full SHA and writes it into the image. The API reads that file, not a
runtime variable, so an expected value in CI or an environment override cannot
relabel a running image. Native local runs report no release revision. This proves
source revision under the inspected build contract, not a byte-identical image
between CI and Coolify. Reinspect after a Coolify upgrade or source/build changes.

Success requires both a finished deployment record for the tested commit and a
successful, uncached public health response naming that commit. Missing secrets,
unknown outcomes, invalid responses, failed/cancelled deployments, wrong revisions,
and timeouts cannot produce a successful release job. An old healthy container
can keep serving while the new one fails; health without revision is insufficient.
The check establishes readiness at verification time, not ongoing availability or
complete production behavior. PR checks never deploy. Failed verification does
not cancel or roll back a deployment, and does not undo migrations; inspect the
host before deciding how to recover.

For repeated read-only SSH inspection, use a session-only `ControlMaster` with a
socket in a private directory, no agent forwarding, and a short `ControlPersist`
idle timeout. Close it explicitly when finished. Secretive then approves one
connection instead of every command. Processes under the same local account can
reuse that connection while it remains open; do not leave it open unattended.

## Dashboard preparation

Setup record, 11 September 2026: a second application, `personal-trainer-web`
(`e01dr4pgprfgfs4d7gdbwosv`), was created in Trainer / production through the existing
GitHub App. Its Dockerfile build uses `/web` as the base directory. Automatic and
preview deployments are disabled; source-commit build arguments and Dockerfile
argument injection are enabled, and build secrets remain disabled. These settings
were verified through Coolify's API, not inferred from the unsaved-changes banner
(the banner remained visible after a successful save).

The application routes `https://app.trainer.marcoazzurrini.com` to container port
3000 and forces HTTPS. At preparation the hostname did not resolve. Marco added
its A record before release: direct queries to `dns1.p06.nsone.net`,
`dns2.p06.nsone.net`, Cloudflare's resolver, and Google's resolver all returned
`91.99.234.12` with a 300-second TTL on 11 September 2026. The local resolver still
cached the earlier negative answer at that check. No nameservers or existing
records were changed during this setup.

The existing Staging AuthKit application now registers the dashboard's callback,
sign-in, and sign-out addresses. Its Connect configuration was not changed. The
web application's eight server variables are configured in Coolify and verified
as runtime-only. Coolify automatically created corresponding preview entries;
those are also runtime-only, and preview deployments remain disabled. The existing
application API key was reused, and a fresh cookie-encryption secret was generated.
Neither value was written to the repository or displayed in the conversation.
The new GitHub secret `COOLIFY_DASHBOARD_WEBHOOK` was configured and its presence
verified; the existing API webhook and CI token were not changed.

### Verified release and authentication

Release record, 11 September 2026: both applications serve revision
`3f6059d55cffd47abf8f3a60ce47e59372379928`. The fourth attempt of
[CI run 34546359154](https://github.com/marcoazzurrini/personal-trainer/actions/runs/34546359154)
completed successfully after the hosted configuration was corrected. These fixes
changed server settings, not the application code or training records.

The first certificate requests failed during Let's Encrypt's secondary DNS
validation. Traefik continued serving its default certificate, and dashboard
release verification exhausted its 15-minute deadline. DNS checks later passed
against all four Netlify nameservers, but no further issuance attempts appeared
in the proxy logs. After Marco approved restarting the shared `coolify-proxy`,
Traefik obtained a valid Let's Encrypt certificate for the dashboard. HTTPS checks
then passed for the dashboard, API, and Coolify; the browser's certificate was
also verified. The original DNS-network failure was not conclusively explained.
A proxy restart briefly affects all applications behind it; waiting or rebuilding
the dashboard alone is not a reliable remedy for this fallback state. See
[Traefik's documented fallback](https://doc.traefik.io/traefik/v3.6/reference/install-configuration/tls/certificate-resolvers/acme/#fallback).

The dashboard initially rejected Marco because its `ALLOWED_SUBJECT` had been
copied from the local `.env` placeholder, `user_test`. It now matches the existing
hosted API owner. The API's allowed account and Connect settings were left
unchanged. This account mismatch was independent of the certificate failure.

Marco completed a real email-code login. The WorkOS SDK authenticated that
session, and the API's unchanged JWT verifier separately accepted its signature,
issuer, application, session, expiry, and owner claims. The token had neither an
`aud` claim nor impersonation. Only after that verification were the API's three
`WEB_AUTH_*` settings configured and deployed, using the observed issuer and
application-specific signing keys. Those settings and their disabled-preview
copies were verified as runtime-only. The existing policy still permits web
sessions only to read `GET /api/bodyweight`; no authorization checks were relaxed.

End-to-end verification loaded 38 measurements and 32 trend points through the
API and displayed the chart. Manual refresh succeeded, an expired access token
was automatically renewed, and the renewed session authenticated successfully.
An anonymous bodyweight request returned 401. Sign-out returned to the sign-in
page, removed the session cookie, and removed the private chart. The cookie was
verified as Secure and HttpOnly. The dashboard was left signed out after testing;
temporary credential copies used for verification were cleared.

## Static-token retirement (#61)

Marco confirmed no remaining consumers of static authentication. Coach access
accepts only minted, unexpired tokens; old server environment values grant no
access. The separately configured web-session policy is described in ADR-0009
and does not restore a static-token shortcut. Tests and container checks use disposable token rows, never a configured
bearer shortcut.

At release, remove `API_TOKEN` and `API_TOKEN_PREVIOUS` from Coolify's application
environment (including preview entries if present) and local server `.env` files.
Then obtain a fresh token through the installed connector and confirm an
authenticated read works. Repository edits do not remove hosted secrets or prove
that live sign-in check; record those separately when performed.

`scripts/load_catalogue.ts` still takes `API_TOKEN` as **client input**, together
with `API_URL`: use the connector's returned `token` and `base_url` for that
invocation, not a permanent credential in server configuration.

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
