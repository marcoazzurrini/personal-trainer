# Sessions and sets — API reference

Payload shapes and schema rules for sessions and their sets. The procedure lives
in `tasks/session-generation` (writing today's session) and `tasks/logging`
(recording what already happened).

A set is **written with targets or actuals, never both** in one write. Targets
mean "what was asked before the work"; actuals mean what happened. Targets are
frozen once created and can never be edited; actuals attach later — through
`PATCH /sets/:id` or the log page — so a mature planned set carries both, the
frozen ask beside what actually happened. The rule guards the write, not the
row: a target authored after the work would always match what was done.

A session is a training bout on a date, and nothing more. It is not owned by a
plan: **each set says which plan it serves**, so one afternoon of sprints and then
squats serves two. That link is worked out server-side and almost never needs
sending — see "Which plan a set serves" below.

## What a set records depends on its exercise

Every exercise declares a `measure` (`reference/exercises`), and a set of it
carries those fields and no others:

| `measure` | A set records | Example |
| --- | --- | --- |
| `load_reps` | `weight_kg` **and** `reps` | back squat |
| `reps` | `reps` | push-up, box jump |
| `distance` | `distance_m` | broad jump |
| `duration` | `duration_s` | plank |
| `distance_duration` | `distance_m` and/or `duration_s` | sprint, run, interval |

Each has a `target_` twin (`target_weight_kg`, `target_distance_m`, …) and the
same rule applies to both sides. `weight_kg` may ride along with any measure — a
weighted vest, a loaded sled — but never stands alone: a load is a modifier on a
measurement, not a measurement.

An unloaded set of a loaded exercise is `0`, not absent. Absent means the set was
not done, and the two must never collapse into each other.

## Reads

| Endpoint | Returns |
| --- | --- |
| `GET /sessions?limit=N` | Recent sessions, newest first. `?mesocycle=<id>` filters to sessions containing work for that plan. |
| `GET /sessions/:id` | One session with its sets, their measures, their plan links, and their ids (needed for corrections). |

## Creating a session

Planned session (session generation):

```json
POST /sessions
{
  "request_id": "<fresh uuid>",
  "date": "2026-08-10",
  "rationale": "<why this session looks like this — see tasks/session-generation>",
  "sets": [
    { "exercise": "sprint", "kind": "warmup", "target_distance_m": 40, "target_duration_s": 6.5 },
    { "exercise": "sprint", "target_distance_m": 40, "target_duration_s": 5.25 },
    { "exercise": "squat", "kind": "warmup", "target_weight_kg": 60, "target_reps": 5 },
    { "exercise": "squat", "target_weight_kg": 102.5, "target_reps": 6 }
  ]
}
```

The response carries `public_id`; the log page for the person is
`<API base URL>/s/<public_id>`.

Retro-logged session (a workout that already happened): same endpoint, past
`date`, sets carrying actuals — and no targets.

## Which plan a set serves

Resolved from the exercise, so the payload usually says nothing about it:

- in exactly one active plan's exercise list → attributed to that plan;
- in none → **off-plan**, recorded as fact and measured against no dose. This is
  for incidental activity — a hike, a game of five-a-side — not for work the
  person is progressing;
- in more than one → refused, naming the candidate tracks. Add
  `"mesocycle": "current:<track>"` to that set to say which.

## Additions and corrections

- Extra sets performed but not logged → `POST /sessions/:id/sets` with actuals and
  a `request_id`. This one appends at the next free position, so it has no natural
  key to collide on — without the id a retried call is a second set.
- Correcting an actual → `PATCH /sets/:id` with the corrected fields (set ids via
  `GET /sessions/:id`). The measure rule is checked against what the row *becomes*,
  so clearing one half of a pair is refused.
- Session-level facts — notes, `overall_feel`, completion → `PATCH /sessions/:id`.
- A mis-planned session nothing has touched → `DELETE /sessions/:id`, then write it
  again. A planned session with no actuals is a proposal, not history — iterating on
  a plan means discarding the draft, never superseding it into dead rows. Refused
  with a 409 the moment any set carries an actual or the session was started or
  finished: from then on it happened, and what happened is corrected, not deleted.

## Field values

- `effort` — `easy` | `hard` | `failure`. It reports how close a set came to
  failure, so it is required exactly where proximity to failure is what drives the
  adaptation: **a rep-counted working set of a `strength`-stimulus exercise**. That
  covers a barbell squat and an unloaded push-up alike. `power` and `conditioning`
  work is scored by output instead — a sprint by the clock, a jump by how far it
  went — and carries no chip, because explosive work is neither taken to failure
  nor judged by how near it came. Warmups carry `"kind": "warmup"` and no effort.
  Meanings and elicitation: `tasks/logging`; interpretation: the track's method
  document.
- `kind` — `warmup` | `working`. Defaults to `working`, so it is only ever written
  to mark a warmup.
- `overall_feel` (session) — free text, not an enum. Write what the person said.
- Durations are seconds and distances are metres, always. A 28:30 run is
  `"duration_s": 1710`; the log page does that conversion for the person, the API
  does not.
