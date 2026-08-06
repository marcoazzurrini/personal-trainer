# Tracking and progress — API reference

The current-state and progress reads, plus the two append-only records: user context
and bodyweight.

## Reads

| Endpoint | Returns |
| --- | --- |
| `GET /training-state` | The complete current picture: active mesocycle and intent, exercise list with priorities and notes, sets delivered so far this week, days since each exercise was trained, recent sessions with rationales, recent decisions, user context. The start of every training conversation. |
| `GET /weekly-volume` | Sets per muscle per week, summed through `exercise_muscles`. Direct working sets on `strength`-stimulus exercises only — power and conditioning work is invisible here. `?mesocycle=all` for the long view. |
| `GET /weekly-exercise-sets` | Delivered sets per exercise per week — the number the intent's weekly dose is judged against. |
| `GET /user-context` | Current truth: the latest row per topic. `?history=true` for every row ever written. |
| `GET /bodyweight` | Bodyweight measurements. |

## User context

```json
POST /user-context
{ "topic": "...", "content": "..." }
```

Rows are never edited. Correcting a fact means a new row on the same topic; the
latest row per topic is the current truth. Retiring a topic means a final row saying
it no longer applies. Reuse existing topic strings — fetch `GET /user-context` first.

## Bodyweight

```json
POST /bodyweight
{ "value_kg": 82.5, "measured_at": "<iso timestamp, defaults to now>",
  "source": "<optional, defaults to \"manual\">" }
```

Resending the same measurement is safe; a different value for the same instant is
rejected — ask which is right rather than picking one.
