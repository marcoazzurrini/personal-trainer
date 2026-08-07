# Programming

Creating and changing the plan.

Two registers, kept apart on purpose: **what the API can express** — facts about the
schema, which any methodology fits — and **how to decide what goes in it**, which belongs
to the method document for this mesocycle's goal. Neither should be mistaken for the
other. A schema fact is not a coaching opinion, and a coaching opinion is not a
constraint. The schema facts and payload shapes live in `reference/planning`; fetch it
before writing (and `reference/exercises` if a new lift must enter the catalogue).

## Before deciding anything

1. **`GET /training-state`.** The complete current picture: the active mesocycle and its
   intent, the exercise list, delivered sets this week, staleness, recent sessions,
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

The shapes are in `reference/planning`; what matters for planning:

- A **block** groups mesocycles that share a goal. Thin on purpose.
- A **mesocycle** is an exercise list plus an intent. The list — each exercise with its
  `role`, `priority`, and `notes` — is the plan's nouns: what is trained this mesocycle.
  The intent is everything else: doses, load goals, progression, reasoning. The database
  deliberately stores no weekly numbers; the intent is the single source of the plan.
- Only one mesocycle can be active; it starts on a Monday and runs whole weeks.
- `sessions_per_week` is an input to session generation, not a weekly schedule.
  Nothing assigns exercises to days; that decision is made fresh each session.

## `intent` — the plan itself

The intent is not a summary of the plan. It **is** the plan. Every conversation that
generates a session, checks adherence, or reviews the mesocycle reads it and acts on
it. Write it with the care that deserves.

**The acceptance test:** a fresh conversation with no memory of this one, holding only
the intent, the exercise list, and the training history, must be able to (a) generate
tomorrow's session, and (b) answer "is the work getting done?". If either would
require guessing, the intent is not finished.

It must state, concretely:

1. **The goal**, in one line. It names the method document everything defers to.
2. **The method and why it fits this person** — schedule, equipment, history, food.
3. **The weekly dose, per exercise, as numbers.** "Squat 10, RDL 8, leg press 8" —
   never "good leg volume". These are the numbers adherence is judged against.
4. **Load goals on the main lifts**, where the method uses them: where the person
   starts and a realistic end-state for the mesocycle's length. A goal you'd hit on a
   bad day is noise; one needing a miracle is fuel for grinding. Accessories rarely
   need one.
5. **The progression mechanism**, named and parameterised — e.g. "double progression,
   8–12; smallest jumps 2.5 kg upper / 5 kg lower" — so any conversation applies it
   identically.
6. **What would make you rethink the whole thing** — the falsification line.

What does not belong: restated history (it lives in sessions), the person's biography
(user context), day-by-day schedules (session generation's job), hedged prose that
states no number. Write it so it stands the test of time: the next twenty
conversations act on these words without you there to clarify them.

A worked example of the shape:

> Goal: hypertrophy, upper-body emphasis. Method: hypertrophy doc as written — Marco
> trains at home, 3 sessions/week genuinely deliverable, eating at maintenance so
> holding strength while adding reps is the win condition. Weekly dose: bench 8,
> weighted pull-up 8, OHP 6, squat 6, RDL 6, lateral raise 6, curl 4. Progression:
> double progression — bench and OHP 5–10, pull-up 5–8, squat and RDL 6–10, isolation
> 10–15; smallest jumps 2.5 kg upper, 5 kg lower, +2.5 kg on pull-up belt. Load goals:
> bench 70×5 → 72.5×7; pull-up +10×5 → +12.5×6. Rethink if: two consecutive weeks
> under 70% of dose delivered, or honest-effort reps flat for three weeks on two or
> more main lifts.

## Building the plan

Work in this order. Each step constrains the next, and doing them out of order produces
plans that don't add up.

1. **Goal and length.** The goal picks the method document. Length is normally 4–6 weeks —
   long enough for a progression to show, short enough to correct cheaply.
2. **Exercises.** Apply the method document's selection rules. Set `priority` so session
   generation knows what deserves the freshest slots, and put the rep intention in
   `notes`.
3. **Weekly dose per exercise.** This is the volume decision, and the method document
   owns it. Then check your work from the muscle's side: sum your draft doses into
   per-muscle weekly sets through the catalogue's `volume_factor`s (`GET /exercises`).
   **Do this arithmetic with a small script, never in your head** — a silent
   miscount here misprices the whole plan. Per-exercise doses are how you write a
   plan; per-muscle sets are how you judge it against the method's guidance.
4. **Load goals on the main lifts**, from recent history and a realistic gain for the
   mesocycle's length.
5. **Write the intent**, containing all of the above, and create the mesocycle.

**Session frequency comes from what the person said they can do.** Never program more
sessions than that. And never treat a missed week as debt: missed work is not made up
later, the week simply comes up short, and the record says so.

## Changing a plan mid-mesocycle

One call, all-or-nothing, and refused without its decision — there is no way to change
the plan without saying why (`POST /mesocycles/current/revisions`; shape in
`reference/planning`). A revision can change the exercise list, replace the intent, or
both; the decision log keeps the history, and a review that changes nothing is still
recorded (`POST /mesocycles/:id/decisions`).

**The bar for revising is high, and it is about evidence, not ideas.** Revise for pain,
for equipment that disappeared, for an exercise that keeps being skipped, or for a
diagnosis `evaluation` has actually reached. Do not revise because you thought of
something better — swapping an exercise mid-mesocycle discards its progression record, and
that record is most of what you have to reason with.

Wholesale change belongs between mesocycles. So does reclassifying `exercise_muscles`,
which silently rewrites every past volume number and should never happen mid-plan.

## Backing off: local and systemic

Two different situations get called "deload"; record them differently.

- **Local** — one lift stalling or one joint complaining while the rest progresses.
  This is not a plan change: write a decision row saying which exercise is backed off,
  why, and for roughly how long ("bench backed off ~2 weeks — reps flat since week 3,
  elbow grumbling"). Session generation reads recent decisions and asks less of that
  lift; everything else continues. When it resolves, the return needs no ceremony —
  the decision said the terms.
- **Systemic** — sleep, stress, or accumulated fatigue dragging everything at once,
  per the method document's triggers. Two honest shapes: a decision row declaring a
  light week ("halve all doses this week, hold loads and effort"), or — when the
  mesocycle's premise itself is spent — end it and open a deload mesocycle in the same
  block with its own one-week intent. Prefer the decision row for a bump in the road;
  prefer the phase change when the review says the plan is done.

Either way the record must distinguish a chosen reduction from a week that simply fell
apart. The decision row is that distinction: a light week without one reads as
non-adherence forever.

## Ending a mesocycle

End it on time, or early when `evaluation` says the plan is the problem and revision isn't
enough. Either way, `PATCH` the `ended_on` date and write a decision saying what happened
and what it taught you. Six weeks later, "why did we stop that one" must have an answer.
