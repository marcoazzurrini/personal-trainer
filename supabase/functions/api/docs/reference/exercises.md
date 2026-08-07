# Exercises — API reference

The exercise catalogue: creating exercises and muscles, reading history, and the
muscle classification that every volume number depends on.

## Reads

| Endpoint | Returns |
| --- | --- |
| `GET /exercises` | The catalogue: names, aliases, equipment, `systemic_fatigue`, muscles with `volume_factor`. |
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

- `stimulus_type` (exercise) — `strength` | `power` | `conditioning`. Only `strength`
  exercises count in `GET /weekly-volume` — see `reference/tracking`.
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
