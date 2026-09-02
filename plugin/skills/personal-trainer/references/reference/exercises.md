# Exercises — API reference

The exercise catalogue: creating exercises and muscles, reading history, and the
muscle classification that every volume number depends on.

## Reads

| Endpoint | Returns |
| --- | --- |
| `GET /exercises` | The catalogue: names, aliases, equipment, `measure`, `systemic_fatigue`, muscles with `volume_factor`. |
| `GET /exercises/:name/history?limit=` | That exercise's performed working sets over time (warmups excluded), newest sets kept when limited, each with its `effort` and its `notes`, plus the exercise's `measure` so the columns can be read. A sprint's history is metres and seconds; reading it for a rising weight would find nothing and conclude wrongly that nothing is happening. **`limit` is required**: a whole number for the most recent sets, or `all` for the whole series. The reply carries `total_sets`, so a partial read knows what it did not ask for. |
| `GET /muscles` | The known muscle names. |

## Creating an exercise

```json
POST /exercises
{
  "name": "hack squat",
  "equipment": "<optional>",
  "pattern": "<optional, e.g. squat, hinge, press>",
  "stimulus_type": "<optional: strength | power | conditioning, defaults to strength>",
  "measure": "<optional: load_reps | reps | distance | duration | distance_duration, defaults to load_reps>",
  "systemic_fatigue": "<optional: normal | high, defaults to normal>",
  "notes": "<optional>",
  "aliases": ["optional", "alternative names"],
  "muscles": [
    { "muscle": "quads", "volume_factor": 1.0 },
    { "muscle": "adductors", "volume_factor": 1.0 },
    { "muscle": "glutes", "volume_factor": 0.5 }
  ]
}
```

Muscles are referenced by name and must already exist — an unknown name is rejected
and the error lists the known ones (`POST /muscles` with `{ "name": "..." }` adds one).

## Correcting an exercise

The surface is tiered by how much history a change rewrites:

- **Freely** — `PATCH /exercises/:ref` with any of `name`, `equipment`, `pattern`,
  `notes`, `systemic_fatigue`. Labels and prose; nothing computes with them, and
  history is keyed by id, so a rename fixes a typo without touching the record.
- **Aliases** — `POST /exercises/:ref/aliases` (`{"alias": "..."}` or
  `{"aliases": [...]}`) adds; `DELETE /exercises/:ref/aliases/:alias` removes. An
  alias is a pointer, not a fact: moving one to the exercise that should own it is
  how a duplicate is retired without splitting history.
- **Only while nothing is logged** — `measure` and `stimulus_type` are PATCHable
  until the exercise's first set, then frozen: every logged set was validated and
  counted under them. After that, the fix is a new exercise with the right value,
  taking over the old one's aliases.
- **Only between plans** — `PUT /exercises/:ref/muscles` replaces the whole
  classification (every row, not just the ones changing; a partial list is ambiguous
  about the rows it omits). Refused with a 409 while any active plan holds the
  exercise, because a reclassification rewrites every past volume number — which is
  the point, like a food PATCH: a wrong classification was wrong when written. The
  response says how many finished weeks it rewrote.
- `DELETE /exercises/:ref` — only an exercise nothing references: no sets, no plan
  entries, no dose history. Past that, deleting would orphan the record; correct the
  fixable fields or move the aliases instead.

Getting `volume_factor` wrong here silently corrupts every future volume number, so
the classification rule matters. Each set of the exercise adds `volume_factor` sets
to that muscle's weekly volume:

- **1.0 — direct.** The muscle is a primary force generator, loaded dynamically
  through meaningful range. Two muscles can both be 1.0 on the same exercise
  (a row is genuinely primary for both lats and upper back).
- **0.5 — indirect.** Meaningfully trained — dynamic, loaded contribution — but not
  primary and typically not the limiter.
- **0 — considered and excluded.** Isometric/stabilizing involvement with no expected
  growth stimulus. Write the row anyway: an explicit 0 records a deliberate exclusion,
  so a later reclassification can't mistake it for an oversight. Absent row = never
  assessed.

The canonical example — back squat: quads 1.0, adductors 1.0, glutes 0.5,
hamstrings 0 (deliberate exclusion), lower back 0 (deliberate exclusion).

**Tiebreaker: longitudinal hypertrophy evidence beats mechanical intuition and beats
EMG.** Squats grow glutes even though the quads fail first; squats do not grow
hamstrings despite the hamstrings' "involvement". When mechanics and measured growth
disagree, classify by measured growth. When unsure, ask rather than guess.

## Field values

- `measure` (exercise) — what a set of it records: `load_reps` (weight and reps,
  the barbell default), `reps` (push-ups, jump contacts), `distance` (broad jump),
  `duration` (plank, a run logged by time), `distance_duration` (a sprint, an
  interval, a tempo run — either or both). A property of the exercise, never a
  per-set choice: a back squat is never measured in metres. It decides which
  fields a set may carry (`reference/sessions`) and which units its weekly dose may
  be stated in (`reference/planning`). Getting it wrong makes the exercise
  unloggable, which is at least loud — and recoverable exactly until the first set
  is logged (`PATCH /exercises/:ref`); after that, a new exercise takes over the old
  one's aliases.
- `stimulus_type` (exercise) — `strength` | `power` | `conditioning`. Only `strength`
  exercises count in `GET /weekly-volume` — see `reference/tracking`. It is
  independent of `measure`: a sled push is measured in metres and is still a
  strength stimulus, and both facts matter separately.
- `systemic_fatigue` (exercise) — `normal` | `high`, defaults to `normal`. `high`
  flags exercises whose whole-body cost is disproportionate to their set count:
  heavy axial loading plus large total mass moved (hinges, barbell squats, heavy
  barbell rows). Local brutality (split squats, lunges) stays `normal`. Nothing
  computes with it: it feeds session-generation judgment — space `high` exercises
  out, don't stack several in one session.
- `exercise_muscles.volume_factor` — `0` | `0.5` | `1.0`; how much each set of this
  exercise adds to that muscle's weekly volume. Classification rule above. No other
  values: 0.5 is the one empirically validated intermediate, and a free-form fraction
  would invite false precision.
