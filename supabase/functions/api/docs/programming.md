# Programming

Creating and changing the plan. Two registers below, kept separate on purpose:
**what the API can express** (facts about the schema — any methodology fits) and
**current methodology** (this coach's decisions — revisable by editing this
document, never to be mistaken for how the API works).

## What the API can express

A **block** is the long horizon: `POST /blocks` `{ name, goal, started_on }`.
Thin on purpose.

A **mesocycle** is the unit that holds a plan. It arrives complete in one call —
a partial plan cannot exist:

```json
POST /mesocycles
{
  "request_id": "<fresh uuid>",
  "block_id": 1,
  "name": "Hypertrophy 1",
  "intent": "<the founding statement — see below>",
  "planned_weeks": 5,
  "sessions_per_week": 3,
  "started_on": "2026-08-10",
  "exercises": [
    {
      "exercise": "squat",
      "role": "main",
      "priority": 1,
      "notes": "per-exercise prose, e.g. rep intentions",
      "weekly_sets": [ { "week": 1, "sets": 10 }, { "week": 2, "sets": 12 } ],
      "load_target": {
        "target_weight_kg": 110, "target_reps": 5,
        "baseline_weight_kg": 100, "baseline_reps": 5, "by_week": 5
      }
    }
  ]
}
```

- `started_on` must be a Monday; mesocycles run whole weeks, Monday to Sunday,
  Europe/Rome.
- Only one mesocycle can be active. End the old one first
  (`PATCH /mesocycles/:id` with `ended_on`) or the create is rejected.
- `weekly_sets` rows carry the whole progression — any shape: ramp, flat, wave,
  a deload is just low numbers. `sets: 0` keeps an exercise in the plan through
  a rest week.
- `load_target` is optional, one per exercise, at mesocycle level only — never
  per week. The baseline is where the user was at the start; write it once, it
  can't be derived later.
- **`intent` is the founding statement.** A fresh conversation reconstructs your
  thinking from it alone. State: the goal, the methodology chosen and why, how
  progression is meant to run, and what would trigger a rethink. Never restate
  numbers that live in tables (weekly sets, targets) — they'd drift apart.

**Changing a plan mid-mesocycle** is one call, all-or-nothing, and refused
without its decision — there is no way to change the plan without saying why:

```json
POST /mesocycles/current/revisions
{
  "request_id": "<fresh uuid>",
  "decision": { "what_changed": "...", "why": "..." },
  "remove": ["back squat"],
  "add": [ { ...same shape as creation entries... } ],
  "weekly_sets": [ { "exercise": "leg press", "week": 4, "sets": 12 } ],
  "load_targets": [ { "exercise": "leg press", "target_weight_kg": 180, "target_reps": 8 } ]
}
```

Plan tables hold only what is currently true. History lives in the decision log
(`GET /mesocycles/:id/decisions`); a review that changes nothing is still
recorded (`POST /mesocycles/:id/decisions`). `current` works anywhere a
mesocycle id goes.

## Current methodology

These are decisions, not laws of the API. Change them by changing this document.

**Structure.** One goal per block, two or three mesocycles inside it. Mesocycles
run 4–6 weeks. A deload is its own short mesocycle (1 week, roughly half the
working sets, weights held) scheduled between hard mesocycles — not bolted onto
the end of one.

**Hypertrophy mesocycles run double progression.** Write the rep intention per
exercise in its `notes` (mains 5–8, accessories 8–12, isolation 10–15). Work at
a fixed weight, add reps week to week; when every working set reaches the top of
the range, add the smallest available jump (2.5 kg on upper-body lifts, 5 kg on
lower-body) and drop back to the bottom. State this in the intent so future
conversations apply it consistently.

**Strength mesocycles** state their loading scheme in the intent (e.g.
week-by-week percentages); the computed weights land in each session's targets
at generation time. Rep intentions in notes are typically fixed (e.g. "5s").

**Volume.** Start a muscle around 10 working sets a week — fewer is fine for
maintenance. Ramp by 1–2 sets per exercise per week toward roughly 16–18 for a
priority muscle. The standard volume model is contested: ramp gradually, watch
performance, and back off when it stalls — do not ride volume to a ceiling
because a chart said to. Sets per muscle is always a query
(`GET /weekly-volume`), never a stored number.

**Load targets.** Set one for each main lift: baseline plus a realistic jump for
the length of the mesocycle (roughly 2.5–5 kg or 1–2 reps for 4–6 weeks of
consistent training). A target you'd hit on a bad day is noise; a target needing
a miracle is grinding fuel. Accessories usually don't need one.

**Session frequency** comes from what the user says they can do. Never program
more sessions than they stated, and don't treat a missed week as debt — missed
work is never made up later; the week just comes up short and the record says
so.

**Revision discipline.** Revise for pain, equipment changes, or an exercise
repeatedly skipped — not for novelty. Swapping exercises mid-mesocycle resets
per-exercise progress readability, so the bar is high. Between mesocycles is the
time for wholesale changes (and for reclassifying `exercise_muscles`, never
mid-mesocycle).

**Effort signals steer weight choices.** Working sets coming back `easy` week
after week mean the weights are too light — say so and fix the next session's
targets. `failure` appearing often means the opposite. `hard` is where most
working sets belong.
