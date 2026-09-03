# Personal trainer

Marco's strength and nutrition coach: a Claude plugin that talks to a small API.
Only Marco and Claude work in this repository.

## The shape that holds

Three parts, and the split between them is the design (ADR-0007):

- **The skill is the coach.** `plugin/` holds the role, the method and every
  procedure as documents read from disk. They are the product, and a change to
  how the coach behaves is a change to a document.
- **The connector signs in and does nothing else.** One tool, one token. The API
  is never ported to MCP tools; the coach calls it with curl.
- **The API is the record.** It stores facts and computes arithmetic, and
  decides nothing about training or eating. Nothing reaches the database but the
  API.

The API's client is a model, so a refusal message is part of the contract: it
says what a correct call looks like. A quiet success is the one unforgivable
failure. Never invent data.

## Source of truth

The codebase. This file holds intent and process, never technical state: the
commands are the tasks in `deno.json`, the variables are in `.env.example`, the
API describes itself at `/openapi.json`, and the folder names say what they
hold. A sentence here that a file could contradict is a bug in this file.

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
