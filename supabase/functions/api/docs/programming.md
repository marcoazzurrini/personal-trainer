# Programming

Creating and changing the plan.

Two registers, kept apart on purpose: **what the API can express** — facts about the
schema, which any methodology fits — and **how to decide what goes in it**, which belongs
to the method document for this mesocycle's goal. Neither should be mistaken for the
other. A schema fact is not a coaching opinion, and a coaching opinion is not a
constraint.

## Before deciding anything

1. **`GET /training-state`.** The complete current picture: the active mesocycle and its
   intent, the exercise list, planned against delivered sets, staleness, recent sessions,
   user context. Do not plan from memory of past conversations.
2. **Fetch the method document for the goal** — `method/hypertrophy` for muscle size,
   and so on. It holds the dose, the effort target, the progression mechanism and the
   selection rules. Follow it over your own general knowledge; that is the entire point
   of it existing.
3. **Know the person.** How many sessions a week they can genuinely do, what equipment
   they have, what hurts, whether they are eating to grow. Most of this is in user
   context. If something load-bearing is missing, ask before planning — and write the
   answer down (`logging`).

Never plan around a constraint the user hasn't stated. Inventing one is how a plan ends up
fitting nobody.

## What the API can express

A **block** is the long horizon: `POST /blocks` `{ name, goal, started_on }`. Thin on
purpose — it groups mesocycles that share a goal.

A **mesocycle** holds a plan and arrives complete in one call. A partial plan cannot
exist:

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

- `started_on` must be a Monday. Mesocycles run whole weeks, Monday to Sunday,
  Europe/Rome.
- Only one mesocycle can be active. End the old one first (`PATCH /mesocycles/:id` with
  `ended_on`) or the create is rejected.
- `weekly_sets` carries the entire volume progression and takes any shape — flat, ramped,
  waved, or low numbers for a deload week. `sets: 0` keeps an exercise in the plan through
  a week it isn't trained. The schema has no opinion about which shape is right; the
  method document does.
- `load_target` is optional, one per exercise, at mesocycle level only — never per week.
  The baseline is where the person was at the start: write it once, because it cannot be
  reconstructed later.
- `sessions_per_week` is an input to session generation, not a weekly schedule. Nothing
  assigns exercises to days; that decision is made fresh each session.

## `intent` — the founding statement

The one field that carries reasoning. A fresh conversation with no memory of this one must
be able to reconstruct your thinking from it alone.

State four things: the goal, the method chosen and why it suits this person, how
progression is meant to run, and what would make you rethink the whole thing.

Never restate numbers that live in tables — weekly sets, load targets. They would drift
apart from the tables and you would have no way to know which is true.

## Building the plan

Work in this order. Each step constrains the next, and doing them out of order produces
plans that don't add up.

1. **Goal and length.** The goal picks the method document. Length is normally 4–6 weeks —
   long enough for a progression to show, short enough to correct cheaply.
2. **Exercises.** Apply the method document's selection rules. Set `priority` so session
   generation knows what deserves the freshest slots, and put the rep intention in
   `notes`.
3. **Weekly sets per exercise.** This is the volume decision, and the method document owns
   it. Then check your work from the muscle's side: `GET /weekly-volume` sums sets per
   muscle through `exercise_muscles`, and that total is the number the method document's
   dose guidance is about. Per-exercise sets are how you write a plan; per-muscle sets are
   how you judge it.
4. **Load targets on the main lifts.** Baseline plus a realistic gain for the length of
   the mesocycle. A target you'd hit on a bad day is noise; a target needing a miracle is
   fuel for grinding. Accessories rarely need one.
5. **Write the intent last**, once the plan exists and you know what you actually decided.

**Session frequency comes from what the person said they can do.** Never program more
sessions than that. And never treat a missed week as debt: missed work is not made up
later, the week simply comes up short, and the record says so.

## Changing a plan mid-mesocycle

One call, all-or-nothing, and refused without its decision. There is no way to change the
plan without saying why:

```json
POST /mesocycles/current/revisions
{
  "request_id": "<fresh uuid>",
  "decision": { "what_changed": "...", "why": "..." },
  "remove": ["back squat"],
  "add": [ { ...same shape as a creation entry... } ],
  "weekly_sets": [ { "exercise": "leg press", "week": 4, "sets": 12 } ],
  "load_targets": [ { "exercise": "leg press", "target_weight_kg": 180, "target_reps": 8 } ]
}
```

Plan tables hold only what is currently true. History lives in the decision log
(`GET /mesocycles/:id/decisions`), and a review that changes nothing is still recorded
(`POST /mesocycles/:id/decisions`). `current` works anywhere a mesocycle id goes.

**The bar for revising is high, and it is about evidence, not ideas.** Revise for pain,
for equipment that disappeared, for an exercise that keeps being skipped, or for a
diagnosis `evaluation` has actually reached. Do not revise because you thought of
something better — swapping an exercise mid-mesocycle discards its progression record, and
that record is most of what you have to reason with.

Wholesale change belongs between mesocycles. So does reclassifying `exercise_muscles`,
which silently rewrites every past volume number and should never happen mid-plan.

## Ending a mesocycle

End it on time, or early when `evaluation` says the plan is the problem and revision isn't
enough. Either way, `PATCH` the `ended_on` date and write a decision saying what happened
and what it taught you. Six weeks later, "why did we stop that one" must have an answer.
