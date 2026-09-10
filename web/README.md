# Personal trainer dashboard

A read-only React/TanStack Start web client. It shows measurements and the trend
returned by the existing API. It is not yet an installable or offline PWA. The
design and authentication boundaries are in
[ADR-0009](../docs/adr/0009-the-dashboard-is-a-web-client-and-web-sessions-can-only-read.md).

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

This change does not configure Coolify, add a web domain, change provider
settings, or deploy the web app. The existing CI deployment still deploys only
the API. After hosting is configured, verify a real sign-in, authenticated chart
read, token refresh, and sign-out before treating hosted authentication as
complete. Locally signed-token tests do not prove the provider configuration.

The access token stays out of browser JavaScript. The SDK cookie contains an
encrypted session; logout clears it and redirects through WorkOS. JWT expiry
bounds access-token revocation, rather than a new server-side session store.
Private responses are not cached and no offline data is persisted.
