# Planning — API reference

Blocks, mesocycles, revisions, decisions: payload shapes and schema rules. The
procedure and the judgment live in `tasks/programming`.

## Reads

| Endpoint | Returns |
| --- | --- |
| `GET /blocks` | All blocks. |
| `GET /mesocycles/:id` | The plan: exercises, weekly sets, load targets. |
| `GET /mesocycles/:id/decisions` | The decision log for that mesocycle. |

## Blocks

```json
POST /blocks
{ "name": "...", "goal": "...", "started_on": "YYYY-MM-DD", "ended_on": "<optional>" }
```

## Creating a mesocycle

A mesocycle arrives complete in one call — a partial plan cannot exist:

```json
POST /mesocycles
{
  "request_id": "<fresh uuid>",
  "block_id": 1,
  "name": "Hypertrophy 1",
  "intent": "<the founding statement — see tasks/programming>",
  "planned_weeks": 5,
  "sessions_per_week": 3,
  "started_on": "2026-08-10",
  "exercises": [
    {
      "exercise": "squat",
      "role": "main",
      "priority": 1,
      "notes": "per-exercise prose — rep intention, cues, constraints",
      "weekly_sets": [ { "week": 1, "sets": 10 }, { "week": 2, "sets": 10 } ],
      "load_target": {
        "target_weight_kg": 110, "target_reps": 5,
        "baseline_weight_kg": 100, "baseline_reps": 5, "by_week": 5
      }
    }
  ]
}
```

- Only one mesocycle can be active. End the old one first or the create is rejected.
- `weekly_sets` takes any shape — flat, ramped, waved, deload-low. `sets: 0` keeps an
  exercise in the plan through a week it isn't trained.
- `load_target` is optional, one per exercise, mesocycle level only — never per week.
  The baseline cannot be reconstructed later: write it once, at creation.
- `sessions_per_week` is an input to session generation, not a weekly schedule.

## Revising mid-mesocycle

One all-or-nothing call, refused without its decision:

```json
POST /mesocycles/current/revisions
{
  "request_id": "<fresh uuid>",
  "decision": { "what_changed": "...", "why": "..." },
  "remove": ["back squat"],
  "add": [ { "...": "same shape as a creation entry" } ],
  "weekly_sets": [ { "exercise": "leg press", "week": 4, "sets": 12 } ],
  "load_targets": [ { "exercise": "leg press", "target_weight_kg": 180, "target_reps": 8 } ]
}
```

Ending: `PATCH /mesocycles/:id` with `ended_on`. Recording a review that changes
nothing: `POST /mesocycles/:id/decisions` with `what_changed` and `why`.

## Field values

- `role` (mesocycle exercise) — `main` | `accessory`.
- `priority` (mesocycle exercise) — integer ≥ 1, no upper bound; low numbers deserve
  the freshest slots in a session.
