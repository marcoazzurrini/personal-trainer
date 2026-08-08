# Tracking and progress — API reference

The current-state and progress reads, the week's schedule, plus the two
append-only records: user context and bodyweight.

## Reads

| Endpoint | Returns |
| --- | --- |
| `GET /training-state` | The complete current picture: **every active plan**, each with its track, its own week number, intent, exercise list with roles and doses, delivered so far this week, and days since each exercise was trained — plus this week's schedule, recent sessions with rationales, and user context. The start of every training conversation. |
| `GET /weekly-volume` | Sets per muscle per week: each working set adds its `volume_factor` (1.0 direct, 0.5 indirect) to every muscle it trains, so values are fractional sums and may be non-integers (glutes 13.5). `strength`-stimulus exercises only, so sprint and endurance work is invisible here by design. `?mesocycle=all` for the long view. |
| `GET /weekly-exercise-sets` | Delivered work per exercise per week beside the dose it is judged against, both in the dose's own unit — plus the raw sets, metres and seconds. Every stimulus counts here, unlike `/weekly-volume`. Weeks are numbered from the mesocycle's start, so `?mesocycle=all` is refused: weeks from different plans share no axis. |
| `GET /user-context` | Current truth: the latest row per topic. `?history=true` for every row ever written. |
| `GET /bodyweight` | Bodyweight measurements. |

## Reading `training-state` with more than one plan

`mesocycles` is an array. Each entry stands alone:

- `track` names the line of training and the method document.
- `method_doc` is the document to fetch, or `null` when the track has none yet —
  in which case `method_note` says so, and you are coaching that plan from general
  knowledge. Say that plainly rather than implying an authority you don't have.
- `week` counts from **that plan's** Monday. Two plans that started on different
  Mondays are in different weeks on the same day, so always say which plan a week
  number belongs to.
- `exercises[].dose` / `dose_unit` is what the plan asks for weekly;
  `delivered_this_week` is what has landed against it, in the same unit. The
  subtraction is the adherence picture and needs no conversion.
- `days_since_trained` is a fact about the lift, not the plan: it counts from the
  last time the exercise was performed at all.
- `this_week.sessions_per_week` is per plan. **These do not add up across plans** —
  one session can serve two, so a day of sprints and squats counts for both.

`week_schedule` is shared, because the week is shared, and so is
`recent_sessions`: a mixed session appears once, with the work it held.

## The week's shape

```json
POST /week-schedule
{ "schedule": "Mon lift, Tue sprint, Thu lift, Sat sprint + easy run",
  "week_start": "<optional, defaults to this Monday>" }
```

One row per week, prose, replaced by writing again. No `request_id`: it upserts
on the week, so a retry cannot duplicate — and a second call with different text
is not a duplicate, it is the week being edited, which is what this is for.

It is a **default, not a contract**. What it is for, and when to propose one, is
in `tasks/session-generation`.

## User context

```json
POST /user-context
{ "topic": "...", "content": "...", "request_id": "<uuid>" }
```

Rows are never edited. Correcting a fact means a new row on the same topic; the
latest row per topic is the current truth. Retiring a topic means a final row
saying it no longer applies. Reuse existing topic strings — fetch
`GET /user-context` first.

## Bodyweight

```json
POST /bodyweight
{ "value_kg": 82.5, "measured_at": "<iso timestamp, defaults to now>",
  "source": "<optional, defaults to \"manual\">" }
```

Resending the same measurement is safe; a different value for the same instant is
rejected — ask which is right rather than picking one. A mistyped weigh-in is
removed with `DELETE /bodyweight/:id` and re-entered. That matters more than it
used to: the trend built from these feeds the expenditure estimate, which sets the
calorie target, so an 8 kg typo reads as a fortnight of catastrophic loss.

Two guards catch the typo at the write instead of after it:

- **Outside 25–300 kg is rejected.** The band is far wider than any real bodyweight
  because it is not judging plausibility — it is catching a lost decimal point,
  which is the error that actually happens (8.2 for 82.4). Send the number as it
  reads on the scale, in kilograms.
- **A future `measured_at` is rejected.** The trend's head is "the most recent row",
  so a slipped year becomes the current weight for every target computed afterwards
  and no amount of correct data outranks it. Check the year before the day.

The same future-date rule applies to `POST /bodyfat`, `POST /intake` and
`POST /days/:day/flags`. Sessions are exempt — a planned session is legitimately
dated ahead.
