# Logging

Recording facts from conversation. The log page is the primary way to log a live
workout; chat logging exists for everything the page doesn't cover.

## A workout the user forgot to log (retro session)

`POST /sessions` with a past `date`, a `rationale` (say it was retro-logged and
why the session happened), and `sets` carrying actuals:

```json
{
  "request_id": "<fresh uuid>",
  "date": "2026-08-04",
  "rationale": "Retro-logged: trained Tuesday, forgot to log.",
  "sets": [
    { "exercise": "squat", "weight_kg": 100, "reps": 6, "effort": "hard" },
    { "exercise": "squat", "kind": "warmup", "weight_kg": 60, "reps": 5 }
  ]
}
```

- Never invent targets for a retro session. A target means "what was asked
  before the work"; a forgotten session had no ask. The API rejects a set
  carrying both targets and actuals.
- `effort` is required on every performed working set: `easy`, `hard`, or
  `failure`. If the user didn't say, ask — don't guess.
- Warmups get `"kind": "warmup"` and no effort.

## Corrections

"That was 8 reps, not 9" → `PATCH /sets/:id` with the corrected fields. Find the
set id through `GET /sessions/:id`. Targets can never be edited — they are the
record of what was asked.

Extra sets done but not logged → `POST /sessions/:id/sets` with actuals.

Session-level facts (notes, how it felt, completion) → `PATCH /sessions/:id`.

## User context

Anything true about the person that the database should remember: goals,
injuries, preferences, equipment, refusals, spacing needs. This arrives
constantly and in no fixed shape — when the user says something with lasting
relevance, write it.

1. First `GET /user-context` and reuse the existing topic string. "lower back"
   and "lumbar" must not become two live topics.
2. `POST /user-context` with `{ "topic": "...", "content": "..." }`. Rows are
   never edited: correcting a fact means writing a new row on the same topic.
   The latest row per topic is the current truth.
3. Retiring a topic means writing a final row saying it no longer applies.

Do not write session summaries or plan reasoning here. Session reasoning lives
in `sessions.rationale`; plan reasoning lives in the mesocycle's intent and
decisions.

## Bodyweight

`POST /bodyweight` with `{ "value_kg": 82.5, "measured_at": "<iso timestamp>" }`
(`measured_at` defaults to now). Resending the same measurement is safe; a
different value for the same instant is rejected — ask the user which is right.

## API conventions that apply here

- Every creating POST takes a `request_id`: generate a fresh UUID per call.
  Retrying with the same id can never duplicate.
- Exercises resolve by id, name, or alias, case-insensitively. If a name doesn't
  resolve, the error lists what to do; only add a genuinely new exercise
  (`POST /exercises`), never a synonym of an existing one.
