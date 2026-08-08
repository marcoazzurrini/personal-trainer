# Sessions and sets — API reference

Payload shapes and schema rules for sessions and their sets. The procedure lives in
`tasks/session-generation` (writing today's session) and `tasks/logging` (recording
what already happened).

A set carries **targets or actuals, never both**. Targets mean "what was asked before
the work"; actuals mean what happened. Targets are frozen once created and can never
be edited.

## Reads

| Endpoint | Returns |
| --- | --- |
| `GET /sessions?limit=N` | Recent sessions, newest first. `?mesocycle=<id>` filters. |
| `GET /sessions/:id` | One session with its sets and their ids (needed for corrections). |

## Creating a session

Planned session (session generation):

```json
POST /sessions
{
  "request_id": "<fresh uuid>",
  "date": "2026-08-10",
  "rationale": "<why this session looks like this — see tasks/session-generation>",
  "sets": [
    { "exercise": "squat", "kind": "warmup", "target_weight_kg": 60, "target_reps": 5 },
    { "exercise": "squat", "target_weight_kg": 102.5, "target_reps": 6 }
  ]
}
```

The response carries `public_id`; the log page for the person is
`<API base URL>/s/<public_id>`.

Retro-logged session (a workout that already happened): same endpoint, past `date`,
sets carry actuals — `weight_kg`, `reps`, `effort` — and no targets.

## Additions and corrections

- Extra sets performed but not logged → `POST /sessions/:id/sets` with actuals and a
  `request_id`. This one appends at the next free position, so it has no natural key to
  collide on — without the id a retried call is a second set.
- Correcting an actual → `PATCH /sets/:id` with the corrected fields (set ids via
  `GET /sessions/:id`).
- Session-level facts — notes, `overall_feel`, completion → `PATCH /sessions/:id`.

## Field values

- `effort` — `easy` | `hard` | `failure`. Required on every performed working set.
  Warmups carry `"kind": "warmup"` and no effort. Meanings and elicitation:
  `tasks/logging`; interpretation: the method document.
- `kind` — `warmup` | `working`. Defaults to `working`, so it is only ever written to
  mark a warmup.
- `overall_feel` (session) — free text, not an enum. Write what the person said.
