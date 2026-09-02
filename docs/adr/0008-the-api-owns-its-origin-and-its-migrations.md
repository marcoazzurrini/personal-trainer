# The API owns its origin and its migrations, on a server we run

ADR-0001 framed the API as a Supabase edge function and everything else as a
client outside it. That framing is superseded: the API is a Deno process in a
container on a Hetzner VPS, deployed by Coolify from this repository, with
Postgres in a container beside it. The load-bearing half of ADR-0001 stands
unchanged: nothing reaches the database but the API.

## Why leave

Four things, none of them about the code. The local Supabase stack was ten
containers for one Postgres and one function, and the Mac paid for it in
memory. The free domain rewrote every `text/html` answer to `text/plain`, so
the reference page never rendered and no page of ours could. The repository
was shaped around the CLI's folder layout and its migration path. And every
further personal project would have met the same platform limits, while one
small server hosts all of them for a fixed few euros a month.

The code was never the obstacle. Sign-in is AuthKit with our own JWT check;
row level security was enabled on every table with no policies, and the API
connects as the owner, so it did nothing; no SDK, no platform extensions. The
whole coupling was one path prefix, one missing port, and a pooler-shaped
database option. The research that chose Coolify over Dokploy is in
`docs/research/coolify-vs-dokploy.md`.

## What changed

**The origin is ours.** The API answers at `https://trainer.marcoazzurrini.com`
and its paths start at `/api`, the prefix the router has always mounted on.
Nothing strips `/functions/v1` on the way in any more, so nothing puts it
back: the OpenAPI document's server is the origin itself, and the sign-in
discovery URLs, the token audience and the base URL the connector hands the
coach all come out as `https://trainer.marcoazzurrini.com/api/mcp`. Traefik
ends TLS in front and says so in `x-forwarded-proto`; `publicOrigin` already
read that header.

**Migrations are a script in the repository.** `db/migrate.ts` reads
`db/migrations`, runs each unapplied file in a transaction of its own and
records its version in `schema_migrations` in the same transaction, under an
advisory lock. The container runs it before it serves, so a migration that
fails is a deploy that never becomes healthy and the old container keeps
answering. `--baseline` records every file without running it; that is how a
database restored from the Supabase dump, which already holds the schema, is
told so once.

**Local development is one container.** `compose.yaml` holds
`postgres:17-alpine` and nothing else; the API runs natively under `deno task
dev` and the tests find it on port 8000. The memory problem was the stack, not
Docker.

**The host is a decision too.** One CX23 in Germany, Coolify with its
auto-update off, Postgres backed up nightly to local disk and to a Cloudflare
R2 bucket, the Hetzner firewall as the perimeter because Docker walks past
ufw. CI runs the suite against a Postgres service and, on a green main, asks
Coolify to deploy through a webhook; Coolify's own deploy-on-push stays off so
a red main never ships. `docs/agents/hosting.md` is the working description.

## Consequences

Ops is ours now: OS updates, Coolify updates read before applied, disk,
backups, and one box as one point of failure. In exchange the runtime is the
one we choose, a page is a page, secrets live in two places instead of three,
and the next project is a second application on the same server rather than
a second platform account. Supabase serves the frozen last deploy until the
cutover and is kept a week after it as the fallback, then deleted.
