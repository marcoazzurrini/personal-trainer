# Schemas validate the coach API, and the description falls out of them

The API validated with hand-written helpers: `requireString`, `optionalNumber`,
`assertKnownFields` and a dozen more, called 204 times across 21 route files.
They worked, and their refusal messages are some of the most carefully written
prose in the repository — the client is a model, and a rejected call has to say
what a correct one looks like.

What they could not do is describe themselves. There was no way to see the API
whole: 75 handlers, no inventory, and the only account of the request and
response shapes was Markdown maintained by hand beside the code. So the routes
now validate with Zod schemas (`lib/schema.ts`), and `/openapi.json` is
generated from those same schemas and rendered by Scalar at `/reference`.

The prose survived intact, which was the condition for doing this at all. It
splits in two. The formulaic sentences — `"source" must be one of: label, crea,
usda, off, estimate.` — come from one global error map that reads the field name
off the issue path, so a new field is phrased correctly without anyone writing a
message for it. The sentences a machine cannot derive, like `request_id`'s
retry-safety paragraph and the ISO-offset rule, sit on the schemas themselves,
where Zod's documented precedence puts them above the map. Thirteen cases were
compared against the originals before any route moved; all thirteen were
byte-identical.

## What this bought beyond the document

Declaring responses turned out to be worth more than declaring requests. Three
bugs fell out of it that prose had been carrying alone.

`@hono/zod-validator` skips JSON validation entirely when `Content-Type` is not
`application/json`: the schema never ran, every field arrived `undefined`, and
Postgres turned it into `Internal error. See function logs.` That is the
silent-success failure `assertKnownFields` was written to prevent, arriving
through a guessed header instead of a guessed field name. `readJson` had
guaranteed both that a body is a JSON object and that it is read whatever the
header claims; both are restored in `index.ts`, the refusal below the token
middleware and the forgiveness in the serve wrapper beside the `/api/api`
collapsing.

`sumMacros` returns nullable macros and an `unaccounted` map naming what the
totals do not cover — a macro summed over rows that don't all carry it is a
floor, not a total. The first schema said every macro was a number and omitted
`unaccounted`. TypeScript refused it.

`?weeks` on the weekly nutrition read was never validated. `Number("lots")` is
`NaN`, `NaN` reached `generate_series`, and a typo was answered with an internal
error.

## Consequences

The OpenAPI document is a build artifact, never committed and never hand-edited.
Two tests keep it honest: every described GET must route, and no router that
promised to describe itself may register a plain `.get()`, which would serve
traffic while appearing nowhere.

`/openapi.json` and `/reference` are public — the third exemption after the
uptime probe and the Withings webhook, and the only one that buys convenience
rather than necessity. A browser cannot put a bearer token on a page load, so a
reference page behind the middleware is one nobody opens. What is published is
the shape of the surface: endpoint names, field names, which are required. No
data, no token, and no way in; every path it describes still answers 401 without
one. `auth_matrix_test.ts` proves that route by route, and now scans direct
registrations as well as mounts — it could not have caught this change before,
because both routes are `app.get()`/`app.doc()` rather than `app.route()`.

Imports are JSR throughout and `z` comes from `@hono/zod-openapi` rather than a
`zod` entry of its own. Mixing registries gives Deno two Zod identities and the
validator stops type-checking (honojs/hono#4775). Scalar is loaded from a CDN
script instead of its Hono middleware, whose npm peer chain fails to resolve on
this runtime (rhinobase/hono-openapi#188); the middleware only ever emitted that
page. Both were verified booting on the real edge runtime before any of this was
written.

`z.config` is process-global. One app, one configuration — but it is global, and
a second consumer of Zod in this function would inherit the error map.

`lib/validate.ts` still exists, smaller. Two things kept it alive. The log page
validates with it: that surface sits above the token middleware, it is the one
place a browser talks to, and describing its shapes in a document the browser
never reads buys nothing. And `requireNotFuture` compares a day against Rome's
today read from Postgres — not a fact about a field, so no schema can hold it.

The Markdown under `docs/` is unaffected and is not replaced. A schema can say
`source` is one of five strings. It cannot say that `estimate` is the honest
label for a number with no good source, or that a confident invention is the
single unforgivable failure of that endpoint family. That judgment is the actual
contract, and it still lives in prose.

Epilogue: `lib/validate.ts` is gone. Both reasons held, but neither needed a
file of its own — the log page's validators moved into `routes/logpage.ts`, the
future checks joined the calendar in `lib/dates.ts`, and every sentence moved
unchanged.
