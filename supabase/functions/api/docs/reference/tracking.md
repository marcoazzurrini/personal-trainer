# Tracking and progress — API reference

The current-state and progress reads, plus the two append-only records: user context
and bodyweight.

## Reads

| Endpoint | Returns |
| --- | --- |
| `GET /training-state` | The complete current picture: active mesocycle and intent, exercise list with priorities and notes, sets delivered so far this week, days since each exercise was trained, recent sessions with rationales, recent decisions, user context. The start of every training conversation. |
| `GET /weekly-volume` | Sets per muscle per week: each working set adds its `volume_factor` (1.0 direct, 0.5 indirect) to every muscle it trains, so values are fractional sums and may be non-integers (glutes 13.5). `strength`-stimulus exercises only — power and conditioning work is invisible here. `?mesocycle=all` for the long view. |
| `GET /weekly-exercise-sets` | Delivered sets per exercise per week — the number the intent's weekly dose is judged against. Weeks are numbered from the mesocycle's start, so `?mesocycle=all` is refused here even though `/weekly-volume` accepts it: weeks from different plans share no axis. |
| `GET /user-context` | Current truth: the latest row per topic. `?history=true` for every row ever written. |
| `GET /bodyweight` | Bodyweight measurements. |

## User context

```json
POST /user-context
{ "topic": "...", "content": "...", "request_id": "<uuid>" }
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
rejected — ask which is right rather than picking one. A mistyped weigh-in is removed
with `DELETE /bodyweight/:id` and re-entered. That matters more than it used to: the
trend built from these feeds the expenditure estimate, which sets the calorie target,
so an 8 kg typo reads as a fortnight of catastrophic loss.

Two guards catch the typo at the write instead of after it:

- **Outside 25–300 kg is rejected.** The band is far wider than any real bodyweight
  because it is not judging plausibility — it is catching a lost decimal point, which
  is the error that actually happens (8.2 for 82.4). Send the number as it reads on
  the scale, in kilograms.
- **A future `measured_at` is rejected.** The trend's head is "the most recent row",
  so a slipped year becomes the current weight for every target computed afterwards
  and no amount of correct data outranks it. Check the year before the day.

The same future-date rule applies to `POST /bodyfat`, `POST /intake` and
`POST /days/:day/flags`. Sessions are exempt — a planned session is legitimately
dated ahead.
