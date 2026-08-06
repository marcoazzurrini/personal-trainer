# Exercises — API reference

The exercise catalogue: creating exercises and muscles, reading history, and the
muscle classification that every volume number depends on.

## Reads

| Endpoint | Returns |
| --- | --- |
| `GET /exercises` | The catalogue: names, aliases, equipment, muscles with `counts` and `fatigue`. |
| `GET /exercises/:name/history` | That exercise's performed working sets over time (warmups excluded). |
| `GET /muscles` | The known muscle names. |

## Creating an exercise

```json
POST /exercises
{
  "name": "hack squat",
  "equipment": "<optional>",
  "pattern": "<optional, e.g. squat, hinge, press>",
  "stimulus_type": "<optional: strength | power | conditioning, defaults to strength>",
  "notes": "<optional>",
  "aliases": ["optional", "alternative names"],
  "muscles": [
    { "muscle": "quads", "counts": true, "fatigue": "lots" }
  ]
}
```

Muscles are referenced by name and must already exist — an unknown name is rejected
and the error lists the known ones (`POST /muscles` with `{ "name": "..." }` adds one).

Getting `counts` wrong here silently corrupts every future volume number, so the
classification rule matters: a muscle **counts** for an exercise only when it is
trained directly — when that muscle is what can approach failure in the lift. Squat
counts for quads, not for glutes; a deficit split squat can count for both. Assisting
without limiting is `counts: false`. When unsure, ask rather than guess.

## Field values

- `stimulus_type` (exercise) — `strength` | `power` | `conditioning`. Only `strength`
  exercises count in `GET /weekly-volume` — see `reference/tracking`.
- `exercise_muscles.counts` — boolean; whether a set of this exercise counts toward
  that muscle's weekly volume. Classification rule above.
- `exercise_muscles.fatigue` — `none` | `some` | `lots`. Nothing computes with it
  today: it is stored, returned by `GET /exercises`, and feeds coaching judgment
  about systemic fatigue — nothing else.
