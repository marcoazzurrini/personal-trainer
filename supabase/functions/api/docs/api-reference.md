# API reference

Facts about the API in one place: conventions, endpoints, payload shapes, field
values. The task documents hold the procedure and the judgment; this document holds
the mechanics they use. Fetch it whenever you are about to write, or when a read's
parameters or shape matter.

## Conventions

- Every creating POST takes a `request_id`: a fresh UUID per call. Retrying with the
  same id can never duplicate, so a retry is always safe. Reuse an id only to retry
  that same call.
- **Errors are prompts.** A rejected call returns plain English stating what was
  wrong. Read it and fix the call instead of retrying blindly.
- Exercises resolve by id, name, or alias, case-insensitively. If a name doesn't
  resolve, the error says what to do. Only add a genuinely new exercise — never a
  synonym of one that exists, which would split its history in two.
- `current` works anywhere a mesocycle id goes.
- Weeks run Monday–Sunday, Europe/Rome. Mesocycles start on a Monday and run whole
  weeks.
- Weekly reads return finished weeks only; the current week is never blended in.
  Don't work around this.

## Reads

| Endpoint | Returns |
| --- | --- |
| `GET /training-state` | The complete current picture: active mesocycle and intent, exercise list with priorities and notes, planned vs delivered sets this week, days since each exercise was trained, recent sessions with rationales, user context. The start of every training conversation. |
| `GET /mesocycles/:id` | The plan: exercises, weekly sets, load targets. |
| `GET /mesocycles/:id/decisions` | The decision log for that mesocycle. |
| `GET /weekly-volume` | Sets per muscle per week, summed through `exercise_muscles`. Direct working sets on `strength`-stimulus exercises only — power and conditioning work is invisible here. `?mesocycle=all` for the long view. |
| `GET /weekly-exercise-sets` | Delivered sets per exercise per week — the counterpart to the plan's `weekly_sets`. |
| `GET /exercises` | The catalogue: names, aliases, equipment, muscles with `counts` and `fatigue`. |
| `GET /exercises/:name/history` | That exercise's performed working sets over time (warmups excluded). |
| `GET /sessions?limit=N` | Recent sessions, newest first. |
| `GET /sessions/:id` | One session with its sets and their ids (needed for corrections). |
| `GET /user-context` | Current truth: the latest row per topic. `?history=true` for every row ever written. |
| `GET /blocks` | All blocks. |
| `GET /muscles` | The known muscle names. |
| `GET /bodyweight` | Bodyweight measurements. |
| `GET /docs-proposals` | Pending documentation proposals. |

## Writes

### Blocks and mesocycles

```json
POST /blocks
{ "name": "...", "goal": "...", "started_on": "YYYY-MM-DD", "ended_on": "<optional>" }
```

A mesocycle arrives complete in one call — a partial plan cannot exist:

```json
POST /mesocycles
{
  "request_id": "<fresh uuid>",
  "block_id": 1,
  "name": "Hypertrophy 1",
  "intent": "<the founding statement — see programming>",
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

Mid-mesocycle change is one all-or-nothing call, refused without its decision:

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
nothing: `POST /mesocycles/:id/decisions`.

### Sessions and sets

A set carries **targets or actuals, never both**. Targets mean "what was asked before
the work"; actuals mean what happened. Targets are frozen once created and can never
be edited.

Planned session (session generation):

```json
POST /sessions
{
  "request_id": "<fresh uuid>",
  "date": "2026-08-10",
  "rationale": "<why this session looks like this — see session-generation>",
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

Additions and corrections:

- Extra sets performed but not logged → `POST /sessions/:id/sets` with actuals.
- Correcting an actual → `PATCH /sets/:id` with the corrected fields (set ids via
  `GET /sessions/:id`).
- Session-level facts — notes, `overall_feel`, completion → `PATCH /sessions/:id`.

### User context and bodyweight

```json
POST /user-context
{ "topic": "...", "content": "..." }
```

Rows are never edited. Correcting a fact means a new row on the same topic; the
latest row per topic is the current truth. Retiring a topic means a final row saying
it no longer applies. Reuse existing topic strings — fetch `GET /user-context` first.

```json
POST /bodyweight
{ "value_kg": 82.5, "measured_at": "<iso timestamp, defaults to now>",
  "source": "<optional, defaults to \"manual\">" }
```

Resending the same measurement is safe; a different value for the same instant is
rejected — ask which is right rather than picking one.

### Exercises

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

### Documentation proposals

`POST /docs-proposals` — see `improving-docs` for the procedure and shape.

## Field values

- `effort` — `easy` | `hard` | `failure`. Required on every performed working set.
  Warmups carry `"kind": "warmup"` and no effort. Meanings and elicitation:
  `logging`; interpretation: the method document.
- `kind` — `warmup` | `working`. Defaults to `working`, so it is only ever written to
  mark a warmup.
- `role` (mesocycle exercise) — `main` | `accessory`.
- `priority` (mesocycle exercise) — integer ≥ 1, no upper bound; low numbers deserve
  the freshest slots in a session.
- `overall_feel` (session) — free text, not an enum. Write what the person said.
- `stimulus_type` (exercise) — `strength` | `power` | `conditioning`. Only `strength`
  exercises count in `GET /weekly-volume` — see the Reads table.
- `exercise_muscles.counts` — boolean; whether a set of this exercise counts toward
  that muscle's weekly volume. Classification rule above.
- `exercise_muscles.fatigue` — `none` | `some` | `lots`. Nothing computes with it
  today: it is stored, returned by `GET /exercises`, and feeds coaching judgment
  about systemic fatigue — nothing else.
