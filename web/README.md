# Personal trainer dashboard

A read-only React/TanStack Start web client hosted on Cloudflare Workers with
Workers Static Assets. It shows measurements and the trend returned by the API.
There is no database binding, direct database access, or browser API token.
WorkOS sessions remain encrypted HttpOnly cookies handled only on the server.
The dashboard does not gain the coach's write permissions.

The design and authentication boundaries are in
[ADR-0009](../docs/adr/0009-the-dashboard-is-a-web-client-and-web-sessions-can-only-read.md).
[ADR-0010](../docs/adr/0010-the-dashboard-is-installable-and-remains-online-only.md)
defines installation without offline storage. The Workers build replaces
ADR-0009's container deployment section, not its authentication policy.
Production now runs on Workers; see
[the cutover receipt](../docs/cloudflare-cutover.md) for data verification,
integration checks and retained recovery copies.

## Install on iPhone

Open the hosted HTTPS dashboard in Safari. Open Share, select **Add to Home
Screen**, enable **Open as Web App** if shown, and tap **Add**. Launch the PT
icon and sign in if asked. There is no App Store submission or native build.

Installation does not provide offline access. No service worker, offline record
cache, or background sync is added. Server responses, including authentication
redirects, failures and health metadata, use `Cache-Control: private, no-store`.
Only public static assets are eligible for static asset caching. There is no SPA
fallback or prerendered private HTML.

The manifest is `public/manifest.webmanifest`. The original artwork is
`public/icons/pt.svg`. The committed 192×192, 512×512, and 180×180 PNG exports
need no image generator during production builds. To regenerate them:

```sh
npm exec playwright install chromium
npm run icons
```

Desktop tests do not prove iOS installation or the real WorkOS flow. Verify
installation, sign-in, reopening, refresh and sign-out on a hosted iPhone before
claiming that those flows work in production.

## Local development

Use Node 24. From `web/`:

```sh
npm ci
cp .env.example .env
npm run dev
```

Fill the server-only values in `.env`. Register
`http://localhost:3000/auth/callback` as the WorkOS redirect URI,
`http://localhost:3000/auth/sign-in` as its sign-in URL, and
`http://localhost:3000/` as its sign-out redirect. Use the same WorkOS user ID
for `ALLOWED_SUBJECT` in the web application and API.

For the built application in the local Workers runtime:

```sh
npm run build
npm start
```

`npm start` explicitly loads `web/.env` and listens on port 3000. The generated
Wrangler configuration lives in `.output/server/`, so implicit Wrangler dotenv
lookup would look in the wrong directory. Do not copy credentials into build
output. `.dev.vars*` and `.wrangler/` are ignored locally; the documented setup
uses `.env` rather than a second secret file. Vite and Nitro dotenv loading are
disabled during builds. The development command explicitly loads `.env`.

Run the API separately using its root configuration. A web session may read only
`GET /api/bodyweight`. The API's `WEB_AUTH_*` settings must match this WorkOS
application. Confirm its exact issuer, application client ID and signing-key
URL, normally `https://api.workos.com/sso/jwks/<client_id>`. The verifier
requires `client_id` and `sid` and refuses `aud` and `act`. Do not assume the
connector issuer is correct or weaken validation to accept mismatched claims. Do
not put a coach token into the web application.

## Build and checks

```sh
npm run build
npm run check
npm test
npm run test:workers
npm exec playwright install chromium
npm run test:browser
```

Build first on a fresh checkout to generate the ignored route tree. For a
revision-aware release rehearsal, use a clean checkout and export
`BUILD_REVISION` to its full lowercase 40-character commit before **both**
building and running tests. Without an explicit value, a clean checkout
identifies its Git commit; a dirty checkout honestly reports `revision: null`.
An explicit value must match the exact clean checkout or the build refuses to
label the artifact. Revision metadata is compiled into server code, not read
from a filesystem or runtime variable. `GET /api/health` and `HEAD /api/health`
do not create a session, read records, or contact WorkOS. Invalid origin
configuration returns 503; other methods return 405.

`test:workers` checks the generated configuration, assets, secret exclusion,
Wrangler's deployment dry run, health, anonymous sign-in, private response
headers and missing/invalid configuration in workerd. Tests use temporary
configuration directories, an isolated HOME and synthetic runtime values; they
do not load local credential files or deploy anything. Container-specific
filesystem ownership, image layers and Docker shutdown checks no longer apply.

The existing browser suite runs the built Worker using Wrangler's local test
harness and a transparent HTTP listener. Unlike `wrangler dev`'s convenience
proxy, this listener does not rewrite HTTPS Location headers to local HTTP. It
preserves checks for forged hosts, public-origin redirects, CSRF, compiled RPC
helpers, anonymous/wrong-account access, SDK refresh, callback, sign-out, chart
states, small screens and installation assets. The provider and API are local
stubs with synthetic keys and records. No live authentication occurs.

Root formatting and lint tasks also cover the web source. API authentication and
persistence checks remain the API's responsibility.

## Deployment configuration

The pinned Nitro `3.0.260903-beta` supports the `cloudflare_module` preset and
generates `.output/server/wrangler.json`, its ES modules and `.output/public`.
The source configuration is `wrangler.jsonc`; do not edit generated files.
`nodejs_compat` with compatibility date `2026-09-15` supports the pinned WorkOS
SDK and its server-only `process.env` reads. No unrelated package is upgraded.
The `ASSETS` binding is generated by Nitro and is not a database binding.

Current guidance:

- [Nitro's Cloudflare preset](https://v3.nitro.build/deploy/providers/cloudflare).
- [Cloudflare's TanStack Start guide](https://developers.cloudflare.com/workers/framework-guides/web-apps/tanstack-start/),
  which also offers the official Vite plugin. This application retains its
  pinned Nitro integration rather than installing two deployment adapters.
- [Workers fetch](https://developers.cloudflare.com/workers/runtime-apis/fetch/).
  Workers does not implement `redirect: "error"`; the API read uses `manual` and
  refuses non-2xx responses, never forwarding credentials to a redirect.

Nitro warns that `assets` is overridden because it owns `directory` and
`binding`. In this pinned version it merges the remaining asset policy fields;
`test:workers` checks that the generated file retains them. API, authentication
and RPC paths always run the Worker before asset matching.

### Configuration types

All application environment values are server-only strings, not `VITE_*`
variables. `wrangler.jsonc` identifies the production Worker and its custom
domain. Do not substitute another resource when recovering or deploying.

- **Runtime secrets:** `WORKOS_API_KEY`, `WORKOS_COOKIE_PASSWORD`. Store them
  with Wrangler secrets, never in `vars`, build variables, Git or browser code.
  The cookie password must have at least 32 characters; generate a random value.
- **Runtime non-secret variables:** `WORKOS_CLIENT_ID`, `WORKOS_REDIRECT_URI`,
  `ALLOWED_SUBJECT`, `TRAINER_API_ORIGIN`, `WORKOS_COOKIE_MAX_AGE` (seconds as a
  string), and `WORKOS_COOKIE_SAMESITE` (`lax`). Only cookie policy defaults are
  committed as `vars`. The other production values are stored as Worker secrets
  alongside the credentials, so a normal deployment preserves them. Do not add
  duplicate `vars` with the same names.
- **Build metadata:** `BUILD_REVISION`, the tested full Git commit. It is not a
  runtime secret or Cloudflare binding.
- **Deployment credentials:** `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`
  belong to the deployment environment, not the Worker. Scope the token to the
  intended account and required Workers deployment permissions; domain setup may
  require separate zone permissions.
- **Platform binding:** Nitro supplies `ASSETS`. There are no D1, KV,
  Hyperdrive, database, queue or service bindings in this dashboard.

`WORKOS_REDIRECT_URI` defines the canonical public origin. Use HTTPS when
hosted. The server replaces the incoming origin before redirects and CSRF
checks; caller host/forwarded headers cannot override it. Keep the cookie
host-only: do not set `WORKOS_COOKIE_DOMAIN`. The API and dashboard may have
different origins because only the server calls the API; browser CORS is
unnecessary.

### Provisioning or replacing a hosted environment

Production setup and the coordinated traffic switch are complete. These steps
apply when provisioning a replacement; they are not instructions to overwrite
existing credentials or move the production domain again.

1. Select the Cloudflare account and Worker name. Add an actual custom-domain
   route to `wrangler.jsonc` using the `routes` array and `custom_domain: true`.
   Both `workers_dev` and preview URLs are disabled. Until a real domain is
   configured, deployment has no public application address.
2. Add the runtime non-secret variables above. The API origin must be the
   separately prepared HTTPS API Worker, without `/api`. Do not point it at a
   retired VPS. Rebuild after source configuration changes.
3. Provision the two secrets in the chosen Worker. From `web/`, after a build,
   use the following commands interactively. Do not put values in command-line
   arguments or source files:

   ```sh
   npx wrangler secret put WORKOS_API_KEY --config .output/server/wrangler.json
   npx wrangler secret put WORKOS_COOKIE_PASSWORD --config .output/server/wrangler.json
   ```

4. Register the selected HTTPS origin's `/auth/callback`, `/auth/sign-in`, and
   `/` sign-out redirect in WorkOS. Verify the API's independent web-session
   token contract and matching allowed subject.
5. In an approved release job, check out the tested commit, export
   `BUILD_REVISION` to that commit, run `npm ci`, build and all checks above,
   then run `npm run deploy`. `npm run deploy:check` is a dry run only. The
   deploy command intentionally uploads the already-tested generated output; it
   does not silently rebuild another revision.
6. Verify `/api/health` reports the exact tested commit, then explicitly verify
   real sign-in, authenticated API read, refresh, sign-out and iPhone behavior.
   A health response or local synthetic session does not prove hosted identity.

A Worker rollback does not restore API records or rotated secrets. Keep the
recovery copies described in the cutover receipt; the former VPS is shared with
unrelated applications and must not be deleted.

## Repository release integration

`.github/workflows/ci.yml` checks the API, D1 transfer and dashboard, then runs
one serialized Cloudflare release from the tested commit. It builds the
dashboard before changing production, migrates and verifies the API, deploys the
dashboard, and verifies its separate immutable health identity.
`api/tests/deploy_test.ts` protects this release contract. The retired container
commands, Coolify deployment hooks and obsolete repository secrets are removed.
See [the hosting runbook](../docs/hosting.md) for provisioning and recovery.
