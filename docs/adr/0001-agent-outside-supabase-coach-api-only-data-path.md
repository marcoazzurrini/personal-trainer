# The agent runs outside Supabase, and the coach API is its only data path

> The Supabase half is superseded by ADR-0008: the API now runs on a server
> we operate. The data-path half stands.

The coach has always been an LLM client driving the API from outside — first
Claude Desktop, now a web app whose agent loop we host ourselves. That loop
cannot live in the Supabase edge function: the agent framework we want targets
Node and Cloudflare rather than Deno, and an installable PWA needs a static
host the edge function does not provide. So the agent is a third tier, on
Cloudflare, calling the coach API over HTTP with the same bearer token every
other client uses.

The alternative was giving the agent its own Postgres connection and skipping
the API. We rejected it, and that rejection is the load-bearing half of this
decision. The API is not a thin data layer: its errors are written to be read
by a model, its `request_id` contract makes every write retry-safe, foods and
exercises resolve by alias, and `POST /foods` refuses macros that fail an
energy check. That is the coaching judgment, expressed as a contract. An agent
holding a database handle would have to re-learn all of it, and would be free
to get it wrong quietly.

## Consequences

Two hops to the database instead of one, which we accept — latency is not a
constraint for this product. Two deploy targets and two secret stores. In
exchange, the coach API stays the single enforcement point, and any client can
be swapped without touching it: Claude Desktop still works today, and the web
app is an addition rather than a migration.
