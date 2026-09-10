# Personal trainer

Marco's strength and nutrition coach, with a private dashboard onto the same
record. Only Marco and Claude work in this repository.

## The shape that holds

Four parts, with separate responsibilities (ADR-0007 and ADR-0009):

- **The skill is the coach.** `plugin/` holds the role, the method and every
  procedure as documents read from disk. They are the product, and a change to
  how the coach behaves is a change to a document.
- **The connector signs in and does nothing else.** One tool, one token. The API
  is never ported to MCP tools; the coach calls it with curl.
- **The API is the record.** It stores facts and computes arithmetic, and
  decides nothing about training or eating. Nothing reaches the database but the
  API.
- **The web app is a view.** It shows the record through the API, not through a
  second database path. Authentication does not grant it the coach's write
  access.

The API serves a model as well as the web app, so a refusal message is part of
the contract: it says what a correct call looks like. A quiet success is the one
unforgivable failure. Never invent data.

## Source of truth

The codebase. This file holds intent and process, never technical state: the
commands are in `deno.json` and `web/package.json`, the variables are in the
respective `.env.example` files, the API describes itself at `/openapi.json`,
and the folder names say what they hold. A sentence here that a file could
contradict is a bug in this file.

## Where the why lives

- `docs/adr/`: one file per decision, numbered, with an epilogue when it was
  overturned. Read the ones for the area you touch. When a change contradicts
  one, say so rather than overriding it quietly; a decision that changes the
  shape of the system gets a new ADR.
- `docs/hosting.md`: how the hosted API runs and is recovered, limited to what
  no config file states.
- GitHub issues on this repository, through `gh`, are the work tracker.

## How we work

- Small steps. Propose, wait for a go, then do it. Commit only when told.
- Boundaries are held by tests, not by folder names. A new rule comes with the
  test that fails when it is broken.
- A commit message is one sentence stating what is true after the change: "The
  last of Supabase leaves the repo".
- Explain in plain language with a concrete example before asking for a
  decision. Marco is learning Deno along the way; teach, do not assume.
