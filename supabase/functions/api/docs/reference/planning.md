# Planning — API reference

Blocks, mesocycles, revisions, decisions: payload shapes and schema rules. The
procedure and the judgment live in `tasks/programming`.

The plan's numbers — weekly doses, load goals, progression parameters — are not
stored in tables. They live in the mesocycle's `intent`, which is the single source
of the plan. The database stores the plan's nouns (the exercise list) and everything
that has happened.

## Reads

| Endpoint | Returns |
| --- | --- |
| `GET /blocks` | All blocks. |
| `GET /mesocycles/:id` | The plan: intent, exercise list with roles, priorities and notes. |
| `GET /mesocycles/:id/decisions` | The decision log for that mesocycle. |

## Blocks

```json
POST /blocks
{ "name": "...", "goal": "...", "started_on": "YYYY-MM-DD", "ended_on": "<optional>" }
```

## Creating a mesocycle

```json
POST /mesocycles
{
  "request_id": "<fresh uuid>",
  "block_id": 1,
  "name": "Hypertrophy 1",
  "intent": "<the plan itself — contents specified in tasks/programming>",
  "planned_weeks": 5,
  "sessions_per_week": 3,
  "started_on": "2026-08-10",
  "exercises": [
    {
      "exercise": "squat",
      "role": "main",
      "priority": 1,
      "notes": "per-exercise prose — rep intention, cues, constraints"
    }
  ]
}
```

- Only one mesocycle can be active. End the old one first or the create is rejected.
- `started_on` must be a Monday; mesocycles run whole weeks, Monday–Sunday.
- `sessions_per_week` is an input to session generation, not a weekly schedule.

## Revising mid-mesocycle

One all-or-nothing call, refused without its decision. It can change the exercise
list, replace the intent, or both:

```json
POST /mesocycles/current/revisions
{
  "request_id": "<fresh uuid>",
  "decision": { "what_changed": "...", "why": "..." },
  "remove": ["back squat"],
  "add": [ { "...": "same shape as a creation entry" } ],
  "intent": "<optional: the full replacement intent>"
}
```

`intent`, when present, replaces the whole text — never a fragment. The revision
records the prior intent in the decision log, so history is never lost.

Ending: `PATCH /mesocycles/:id` with `ended_on`. Recording a review that changes
nothing: `POST /mesocycles/:id/decisions` with `what_changed` and `why`.

## Field values

- `role` (mesocycle exercise) — `main` | `accessory`.
- `priority` (mesocycle exercise) — integer ≥ 1, no upper bound; low numbers deserve
  the freshest slots in a session.
