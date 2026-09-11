# The dashboard is a web client, and web sessions can only read

ADR-0007 made the skill the coach, the connector its sign-in, and the API the
record. A fourth part now joins them: a React dashboard built with TanStack
Start. The plugin still coaches and logs. This first web slice shows bodyweight
and its API-calculated trend; it does not replace the coach, restore the gym
logger retired in ADR-0004, or make training decisions. Nothing reaches the
training database but the API.

## One sign-in provider, two credential policies

The web application uses the existing WorkOS account through the official
AuthKit TanStack Start SDK. The SDK handles the authorization-code/PKCE flow,
an encrypted HttpOnly session cookie, and access-token refresh. There is no new
user table, password system, shared permanent API token, or web token-minting
endpoint. The cookie stays host-only, uses SameSite=Lax, and is Secure when the
configured callback uses HTTPS. Hosted callbacks must use HTTPS.

The configured callback also supplies the dashboard's public origin. The server
entry applies that origin before Start handles redirects and CSRF checks, rather
than trusting the internal connection or caller-supplied host and forwarded
headers. Paths, query strings, methods, headers, and bodies are preserved. This
keeps HTTPS navigation correct behind a TLS-terminating proxy without adding a
second origin setting or weakening CSRF protection. Invalid configuration fails
closed; localhost HTTP remains available for development.

The browser calls a Start server function. That function checks the allowed
WorkOS subject, refuses impersonation, and forwards the session access token
to one fixed API read. It returns validated chart data, never tokens or the
session object. The API independently checks the signed token and subject.
There is no general-purpose proxy and no direct browser request to the API.

The existing connector accepts a Connect token whose audience is its resource
URL. The API's existing coach token is a random, expiring credential stored as
a hash. A normal WorkOS web-session access token has a different contract:
application-specific signing keys, the exact configured issuer, `client_id`,
`sid`, expiry, and subject. The new verifier requires that contract and refuses
`aud` and impersonation (`act`). It must not be implemented by weakening the
connector's audience check. Actual tenant claims must match this contract
before hosted web access is enabled; a mismatch is a refused login, not a
reason to disable validation.

Web authentication is optional and separately configured on the API. A valid
web session authorizes only `GET /api/bodyweight`. Every other protected
operation, including other reads, is refused. New reads require an explicit
policy change and a test. Coach tokens keep their existing authority. Token
formats choose disjoint verification paths; a failed web token cannot fall
back to coach authentication.

## The boundaries are HTTP boundaries

A route redirect is navigation, not access control. Every direct invocation of
the dashboard function checks its session before fetching data. The API checks
all documented operations against the web credential in the auth tests.

The SDK compiles additional RPC helpers, including helpers that return access
tokens. Not importing a helper in the page does not remove its HTTP entry
point. Request middleware therefore exposes only the dashboard function's
compiler-generated URL. SDK helpers used internally by the sign-in route still
run on the server. Browser tests inspect the built RPC inventory and probe all
other helpers to prove they stay closed, even with a valid session.

Custom Start middleware replaces its default CSRF setup, so CSRF protection is
registered explicitly for RPC requests and POST routes. Private HTML and data
responses use `Cache-Control: private, no-store`. Sign-out is a POST and a full
document navigation, which clears the Router's in-memory record. A restored
back/forward document reloads before reusing its session. No service worker or
persistent browser data cache is installed.

The SDK's session cookie is encrypted and HttpOnly, not a new server-side
session database. Signed access tokens can remain valid until expiry after a
provider session is revoked; this is not immediate per-request revocation.
The API's existing JWT clock leeway also applies. Do not claim that clearing a
browser cookie revokes every copy of an access token.

## A deliberately small dashboard

The existing bodyweight endpoint supplies raw instants and the daily EMA.
The web application displays those facts without recalculating or smoothing
the trend. Explicit interpolated days are marked. Missing trend days are not
joined. Dates use Europe/Rome, and recorded dates stay visible when the data is
old. An empty history and an API failure have different screens.

TanStack Charts is an Alpha dependency and is pinned exactly. Start's loader
owns the first read and manual refresh. TanStack Query, TanStack DB, offline
storage, mutation queues, and installability wait for a use case that needs
them. This is a responsive web application, not yet a PWA.

The web app has its own Node build in `web/`; the API remains Deno. Both live in
this repository and are checked in CI. The first web slice left API deployment
unchanged and required separate hosting configuration and smoke verification.

## Deployment follow-through

The dashboard now has a separate Docker image and Coolify application. CI keeps
one serialized release job, validates both target configurations, and deploys the
same tested source revision to the API and dashboard. Each application must pass
its own revision-aware health check. An API deployment is not rolled back when a
later dashboard deployment fails.

The web health endpoint reads only the image's build-revision file. The import
boundary grants `node:fs` only to that server module, not to the rest of the web
source. It does not open a database path or expose training records. Container
checks use synthetic credentials and no runtime network. Health proves that the
process serves the built revision, not that WorkOS or a real authenticated read
has been verified. The tenant-claim check above still gates hosted API access.

**Epilogue.** [ADR-0010](0010-the-dashboard-is-installable-and-remains-online-only.md)
adds Home Screen installation for the iPhone. It supersedes the installability
deferral above. The dashboard remains online-only, read-only, and free of
service workers or persistent browser record caches.
