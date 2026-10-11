# Personal trainer

Marco's strength and nutrition coach, with a private dashboard onto the same record. Only Marco and Claude work in this repository.

## The shape that holds

Four parts, with separate responsibilities:

- **The skill is the coach.** `plugin/` holds the role, the method and every procedure as documents read from disk. They are the product, and a change to how the coach behaves is a change to a document.
- **The connector signs in and does nothing else.** One tool, one token. The API is never ported to MCP tools; the coach calls it with curl.
- **The API is the record.** It stores facts and computes arithmetic, and decides nothing about training or eating. Nothing reaches the database but the API.
- **The web app is a view.** It shows the record through the API, not through a second database path. Authentication does not grant it the coach's write access.

The API serves a model as well as the web app, so a refusal message is part of the contract: it says what a correct call looks like. A quiet success is the one unforgivable failure. Never invent data.

## Source of truth

The codebase. This file holds intent and process, never technical state: the commands are in the package manifests, the variables are in the respective `.env.example` files, the API describes itself at `/openapi.json`, and the folder names say what they hold. A sentence here that a file could contradict is a bug in this file.

## Where the why lives

- Beside the code. The reason for a rule is a short comment next to the test that enforces it, or next to the code it shapes. It says why, not what; the code already says what.
- In the commit message. A change that alters the shape above says so there and updates this file in the same commit.
- `RUNBOOK.md`: what running the trainer needs that no file in the repository states, such as the accounts, the backup agent and recovery.
- GitHub issues on this repository, through `gh`, are the work tracker. Retired documents, including the old decision records, stay in Git history.

## How we work

- Small steps. Propose, wait for a go, then do it. Commit only when told.
- Boundaries are held by tests and by the import rules in `.dependency-cruiser.cjs`, not by folder names. A new rule comes with the test or rule that fails when it is broken.
- A commit message is one sentence stating what is true after the change: "The last of Supabase leaves the repo".
- Explain in plain language with a concrete example before asking for a decision. Marco is learning the development tools along the way; teach, do not assume.
