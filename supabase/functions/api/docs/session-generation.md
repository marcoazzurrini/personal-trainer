# Session generation

Writing today's session. The most important job: the plan meets today's reality
here.

## Before deciding anything

`GET /training-state`. It contains the mesocycle's intent (the methodology lives
there), the exercise list with priorities and notes, this week's planned sets
against what's been delivered, days since each exercise was trained, the recent
sessions with their rationales, and the current user context. Read the intent
first — it tells you how this mesocycle is meant to progress. Then read what the
user says about today: time, energy, soreness, equipment. Today's reality wins
over the plan's ideal shape.

## Choosing the work

- **What's behind and what's stale.** Prefer exercises with planned sets still
  undelivered this week and the most days since last trained. `priority` orders
  exercises within the week: lower numbers deserve the freshest slots.
- **Respect spacing constraints** from user context (e.g. 48 h between heavy
  hinge days). They outrank the plan.
- **Sets per exercise per session: 3–5.** Past five sets of one lift in one
  session, quality drops faster than volume accumulates. Hitting a 12-set week
  means three sessions of 4, not one of 12.
- **Keep each exercise's weekly rhythm stable.** Progress is read per exercise;
  scattering a lift randomly across the week makes its progression unreadable.
- **Don't cram.** If the week can't fit what remains, it comes up short — never
  pile undelivered sets into the remaining days, and never carry them into next
  week.

## Choosing the targets

Apply the mesocycle's methodology (from the intent and the exercise's notes) to
the exercise's recent history — last session's numbers are in the training
state; deeper history is `GET /exercises/:name/history`. Under double
progression: reps moved up last time and the range top isn't reached → same
weight, ask for one more rep. Top of range reached on all sets → add the jump,
drop to the bottom of the range. In doubt, repeat last time's numbers rather
than guess upward.

Warmups: 2–3 rows for the first heavy lift of the day (`"kind": "warmup"`, e.g.
~50% and ~75% of the top target), fewer or none for what follows.

## Writing it

`POST /sessions` with a fresh `request_id` UUID, today's date, the sets with
targets, and a **rationale** — why the session looks like this, written every
time. The rationale is what future conversations recover your thinking from:
name what was prioritized, what was skipped and why, anything the user said that
shaped it.

```json
{
  "request_id": "<fresh uuid>",
  "date": "2026-08-10",
  "rationale": "Week 3 lower day: squat still 4 sets short of plan, hips fresh (3 days). Bench held back — shoulder was cranky Tuesday.",
  "sets": [
    {
      "exercise": "squat",
      "kind": "warmup",
      "target_weight_kg": 60,
      "target_reps": 5
    },
    { "exercise": "squat", "target_weight_kg": 102.5, "target_reps": 6 },
    { "exercise": "squat", "target_weight_kg": 102.5, "target_reps": 6 }
  ]
}
```

The response carries `public_id`. Hand the user the log page link:
`<API base URL>/s/<public_id>`. Targets are frozen once created — they are the
record of what was asked today. If the user reports mid-workout changes in chat
instead of the page, log them (see `logging`).
