# The coach is a plugin, the documents ship with it, and the API is the record

ADR-0001 put the coach outside Supabase and made the coach API its only data
path. It described that coach as a web app whose agent loop we host ourselves.
That half is superseded: the coach is a Claude plugin, installed from this
repository — a skill, the coaching documents beside it, and a connector that
signs Marco in. The load-bearing half of ADR-0001 stands: nothing reaches the
database but the API.

## Three parts

**The skill is the coach.** `SKILL.md` carries the role, the conventions every
call obeys, and the map of the documents; the documents — one per task, one per
endpoint family, one per training goal — are files beside it, read from disk.
They used to be bundled into the function and served at `GET /docs/…`, because
the alternative was uploading them to Claude by hand. A plugin removes that
reason: a push updates the installed copy, so the documents live with the thing
that reads them and the API never sees them. The document name is what the API
still quotes — `tasks/onboarding` in a cold-start note, `method/hypertrophy` on
a plan — and that name plus `.md` is the file's path from the skill's folder.
There is no `references/` layer between the two, because a name that is also a
path needs no sentence explaining the mapping.

**The connector signs in and does nothing else.** The plugin's MCP server has
one tool, which mints a day-long API token after a sign-in with the hosted
authorization server. It does not expose the API as tools: a tool schema per
endpoint would spend tens of thousands of tokens of context before a word of
coaching, and the documents already say how to call each endpoint with curl.
The API stays HTTP.

**The API is the record.** It stores facts and computes arithmetic — state,
totals, trends, the expenditure estimate, the clipped target — and decides
nothing about training or eating. It serves no documents. What it says about
them is a name: which document a state read wants opened next, and which
document a bug report may cite.

## Consequences

- `SKILL.md` is one file. The former index is folded in, because a document
  read unconditionally at the start of every conversation belongs in the file
  that is already loaded, not behind a pointer that costs a read and can be
  skipped.
- The verbs carry the split. A document is *read*; the API is *called*.
  `tests/docs_test.ts` holds the folder to its map: every name `SKILL.md`
  writes is a file on disk and links to it, every file on disk is named, no
  document says "fetch", and no document quotes a route.
- The coach can now see the documents, and the skill pre-approves Write and
  Edit for the turn that fires it. Nothing stops an edit to the installed copy
  except the reporting document, which says the copy is installed, the edit is
  lost at the next update, and the repository is where a document changes.
  That sentence is the guard, and `POST /issues` is the door it points at.
- The tests that read the plugin's files share one statement of its layout,
  `tests/skill.ts`, so a folder that moves changes one file.
- What the connector tells a client about itself names the documents only to
  say where they are not. A coach that once read them through the API would
  otherwise go looking for the route that served them.
