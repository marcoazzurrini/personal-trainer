# Personal trainer dashboard

A read-only React/TanStack Start web client. It shows measurements and the trend
returned by the existing API. It can be installed on an iPhone Home Screen and
requires an internet connection. The design and authentication boundaries are in
[ADR-0009](../docs/adr/0009-the-dashboard-is-a-web-client-and-web-sessions-can-only-read.md).
[ADR-0010](../docs/adr/0010-the-dashboard-is-installable-and-remains-online-only.md)
adds installation without offline storage.

## Install on iPhone

Open the hosted HTTPS dashboard in Safari. Open Share, select **Add to Home
Screen**, enable **Open as Web App** if shown, and tap **Add**. Launch the PT
icon and sign in if asked. The dashboard opens without the usual browser
controls. There is no App Store submission or native app build.

Installation does not provide offline access. No service worker, offline record
cache, or background sync is added. Private HTML and data responses remain
`private, no-store`.

The manifest is `public/manifest.webmanifest`. The original PT artwork is
`public/icons/pt.svg`, with letter outlines rather than a font dependency. The
192×192, 512×512, and 180×180 PNG exports are committed, so production builds
need no image generator. After changing the SVG, regenerate them with:

```sh
npm exec playwright install chromium
npm run icons
```

Before considering iPhone support verified, test installation on the hosted
HTTPS site, sign-in from the Home Screen app, closing and reopening the app,
refresh, and sign-out. Desktop browser tests verify the served metadata, icons,
and lack of persistent record storage, not iOS installation or the real WorkOS
flow.

## Local development

Use Node 24. From this directory:

```sh
npm ci
cp .env.example .env
npm run dev
```

Fill the server-only values in `.env`. Register
`http://localhost:3000/auth/callback` as a WorkOS redirect URI,
`http://localhost:3000/auth/sign-in` as the sign-in URL, and
`http://localhost:3000/` as the sign-out redirect. Use the same WorkOS user ID
for `ALLOWED_SUBJECT` on the web app and API.

Run the API separately using the root `deno.json` tasks. Its `.env.example`
names the three optional `WEB_AUTH_*` settings. The issuer must exactly match
the web-session access token's `iss`; do not copy the MCP issuer by assumption.
The client ID must match `WORKOS_CLIENT_ID` here. WorkOS publishes the web
application's signing keys at `https://api.workos.com/sso/jwks/<client_id>`. The
verifier requires `client_id` and `sid`, and refuses a token with `aud` or
`act`. Confirm that contract against the configured tenant without printing or
saving credentials. Leave web access disabled if it does not match.

A web session is allowed only `GET /api/bodyweight`. Existing connector sign-in
and minted coach tokens remain unchanged. Never paste a coach token into a
frontend environment variable to make the chart work.

## Checks

```sh
npm run build
npm run check
npm test
npm exec playwright install chromium
npm run test:browser
npm run test:container
```

The build generates the ignored route tree, so build before type-checking a
fresh checkout. Root `deno fmt` and `deno lint` cover the web source too.

Browser tests start the production build with an isolated local provider and API
stub. They use synthetic signing keys, encrypted sessions, and weight records,
not `.env`, a real WorkOS account, or the training database. They test anonymous
and wrong-account access, the compiled RPC surface, CSRF, SDK token refresh,
logout, a narrow viewport, and empty/error screens. Proxy tests also cover an
internal HTTP connection behind a public HTTPS address, forged host headers, and
CSRF checks without browser fetch-metadata headers. API authentication tests use
the root disposable-Postgres harness.

The container check requires Docker. It builds the production image with a
synthetic revision and runs it without a network, database, or real credentials.
It checks image contents, non-root execution, health metadata, anonymous
sign-in, configuration refusals, and shutdown. Its containers and image are
removed after the run.

## Production preparation

```sh
npm run build
npm start
```

The Nitro Node build is in `.output/`. Bind this process behind an HTTPS reverse
proxy as a separate application. Set the production callback, sign-in and
sign-out URLs in WorkOS and provide this application's environment variables at
runtime. The API and web application can use different origins: only Start's
server calls the API, so no browser CORS configuration is needed. Keep the
session cookie host-only and the callback HTTPS. Set an explicit cookie lifetime
rather than relying on the SDK's long default.

`WORKOS_REDIRECT_URI` also defines the dashboard's public origin. Before Start
handles a request, the server entry uses that configured origin while preserving
the request path, query, method, headers, and body. Redirects and CSRF checks
therefore use the public HTTPS address even when the proxy connects internally
over HTTP. Request host and forwarded headers cannot override it. Missing or
invalid configuration refuses requests; HTTP callbacks are allowed only on
localhost. No additional origin variable or proxy-trust setting is needed.

### Container and release

The Docker build context is `web/`. In Coolify, use a separate GitHub App
application with base directory `/web`, Dockerfile location `/Dockerfile`, and
container port `3000`. Disable automatic and preview deployments. Enable source
commit availability during the build and Dockerfile argument injection; leave
build secrets disabled. Supply all dashboard credentials at runtime only, never
as build arguments. Coolify currently mirrors environment variables into preview
entries, so keep those runtime-only too and leave preview deployments disabled.

The Dockerfile requires Coolify's full `SOURCE_COMMIT`, builds the standalone
Nitro output, and writes its revision into that output. The final image contains
no source tree or build dependencies and runs as an unprivileged user. Its
files, including the revision, are root-owned. A runtime environment variable
cannot replace the recorded revision. Native builds without that file report
`null`.

`GET /api/health` and `HEAD /api/health` are public, uncached process/build
checks. They do not read training records, create sessions, or contact WorkOS.
Invalid public-origin configuration or malformed revision metadata returns 503.
These checks do not establish that a real WorkOS login or API read works.

CI tests the production web image, validates both release configurations before
writing either commit pin, then deploys and verifies the API and dashboard in
one serialized release job. Both must report the exact tested revision.
Configure `COOLIFY_DASHBOARD_WEBHOOK` in GitHub secrets for the dashboard's
deployment URL; the existing `COOLIFY_WEBHOOK` still selects the API, and
`COOLIFY_TOKEN` is shared. A failed dashboard release does not roll back a
successful API release.

After DNS and hosting are configured, verify a real sign-in, authenticated chart
read, token refresh, and sign-out before treating hosted authentication as
complete. Locally signed-token tests do not prove the provider configuration.
See [the hosting record](../docs/hosting.md#dashboard-preparation) for the
prepared hosted settings and remaining verification.

The access token stays out of browser JavaScript. The SDK cookie contains an
encrypted session; logout clears it and redirects through WorkOS. JWT expiry
bounds access-token revocation, rather than a new server-side session store.
Private responses are not cached and no offline data is persisted.
