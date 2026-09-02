# Programming

Creating and changing the plan.

Two registers, kept apart on purpose: **what the API can express** — facts about the
schema, which any methodology fits — and **how to decide what goes in it**, which belongs
to the method document for this mesocycle's goal. Neither should be mistaken for the
other. A schema fact is not a coaching opinion, and a coaching opinion is not a
constraint. The schema facts and payload shapes live in `reference/planning`; fetch it
before writing (and `reference/exercises` if a new lift must enter the catalogue).

## Before deciding anything

1. **`GET /training-state`.** The complete current picture: every active plan with its
   intent, exercise list, doses and delivery, staleness, this week's shape, recent
   sessions, user context. Do not plan from memory of past conversations.
2. **Fetch the method document for the track** — `method/hypertrophy` for muscle size,
   and so on. It holds the dose, the effort target, the progression mechanism and the
   selection rules. Follow it over your own general knowledge; that is the entire point
   of it existing. **If another plan is already running, fetch its method document too**:
   a new line of training has to be planned around the one that exists, not beside it in
   ignorance.
3. **Know the person.** How many sessions a week they can genuinely do, what equipment
   they have, what hurts, whether they are eating to grow. Most of this is in user
   context. If something load-bearing is missing, ask before planning — and write the
   answer down (`logging`).

Never plan around a constraint the user hasn't stated. Inventing one is how a plan ends up
fitting nobody.

## What the API can express

The shapes are in `reference/planning`; what matters for planning:

- A **block** groups mesocycles that share a goal. Thin on purpose, and it carries no
  track of its own.
- A **mesocycle** belongs to a **track** — `hypertrophy`, `strength`, `speed`,
  `endurance` — and is an exercise list plus an intent. The list is the plan's nouns:
  each exercise with its `role`, `priority`, `weekly_dose` and `notes`.
- **One mesocycle can be active per track**, so lines of training run side by side. Each
  starts on its own Monday and runs whole weeks, so each has its own week number.
- **Rehab is a role, not a track.** Shoulder rehab is rehab-role exercises inside the
  plan that is already running; two rehab problems are two rehab-role exercises.
- The **weekly dose is a column**, not prose. The intent holds everything the server
  cannot compute with: load goals, the progression mechanism, why this method fits, the
  falsification line.
- `sessions_per_week` is an input to session generation, not a weekly schedule, and it
  is per plan — one session can serve two, so the numbers across plans do not add up.
  Nothing assigns exercises to days; that decision is made fresh each week and each
  session.

## `intent` — the plan's judgment

The weekly dose is a column now, and it is the only number that left the prose. The
intent holds everything else, and it is still the plan in every sense that matters:
every conversation that generates a session, checks adherence, or reviews the
mesocycle reads it and acts on it. Write it with the care that deserves.

**The acceptance test:** a fresh conversation with no memory of this one, holding only
the intent, the exercise list with its doses, and the training history, must be able to
(a) generate tomorrow's session, and (b) answer "is the work getting done?". If either
would require guessing, the intent is not finished.

It must state, concretely:

1. **The goal**, in one line. The track names the method document everything defers to.
2. **The method and why it fits this person** — schedule, equipment, history, food.
3. **Load goals on the main lifts**, where the method uses them: where the person
   starts and a realistic end-state for the mesocycle's length. A goal you'd hit on a
   bad day is noise; one needing a miracle is fuel for grinding. Accessories rarely
   need one.
4. **The progression mechanism**, named and parameterised — e.g. "double progression,
   8–12; smallest jumps 2.5 kg upper / 5 kg lower" — so any conversation applies it
   identically.
5. **How this line has to sit against the others**, when more than one is running:
   "sprints Tuesday and Friday, never the day after heavy legs". These constraints are
   read every time a session is built, and nothing else records them.
6. **What would make you rethink the whole thing** — the falsification line.

**Do not restate the doses here.** They are in `weekly_dose`, they are what delivery is
compared against, and a second copy in prose is a number that can go stale silently.

What does not belong: restated history (it lives in sessions), the person's biography
(user context), day-by-day schedules (session generation's job), hedged prose that
states no number. Write it so it stands the test of time: the next twenty
conversations act on these words without you there to clarify them.

A worked example of the shape:

> Goal: hypertrophy, upper-body emphasis. Method: hypertrophy doc as written — Marco
> trains at home, 3 sessions/week genuinely deliverable, eating at maintenance so
> holding strength while adding reps is the win condition. Progression: double
> progression — bench and OHP 5–10, pull-up 5–8, squat and RDL 6–10, isolation 10–15;
> smallest jumps 2.5 kg upper, 5 kg lower, +2.5 kg on pull-up belt. Load goals: bench
> 70×5 → 72.5×7; pull-up +10×5 → +12.5×6. Alongside the speed block: legs stay off the
> day before a sprint day, and never the day after. Rethink if: two consecutive weeks
> under 70% of dose delivered, or honest-effort reps flat for three weeks on two or
> more main lifts.

## Building the plan

Work in this order. Each step constrains the next, and doing them out of order produces
plans that don't add up.

1. **Goal, track and length.** The goal picks the track, and the track picks the method
   document. Length is normally 4–6 weeks — long enough for a progression to show, short
   enough to correct cheaply. Lines on different tracks need not share a length, and
   usually shouldn't: a speed block is often shorter than the lifting block it runs
   inside.
2. **Exercises.** Apply the method document's selection rules. Set `priority` so session
   generation knows what deserves the freshest slots, and put the rep intention in
   `notes`. Rehab work is `role: "rehab"` in whichever plan is running.
3. **Weekly dose per exercise, with its unit.** This is the volume decision, and the
   method document owns it. Sets for lifting; `km` or `minutes` where the exercise is
   measured that way and the distance or the time is the real dose. Then check your work
   from the muscle's side: sum your draft doses into per-muscle weekly sets through the
   catalogue's `volume_factor`s (`GET /exercises`). **Do this arithmetic with a small
   script, never in your head** — a silent miscount here misprices the whole plan.
   Per-exercise doses are how you write a plan; per-muscle sets are how you judge it
   against the method's guidance.
4. **Check the whole week, not just this plan.** With another line already running, add
   up what the person is actually being asked to do across both, and place this line's
   hard days where they don't collide with the other's. If the total is more than they
   said they can deliver, this plan is too big — cut it now, not in week three.
5. **Load goals on the main lifts**, from recent history and a realistic gain for the
   mesocycle's length.
6. **Write the intent**, containing all of the above, and create the mesocycle.

**Session frequency comes from what the person said they can do**, counted across every
line at once. Never program more sessions than that. And never treat a missed week as
debt: missed work is not made up later, the week simply comes up short, and the record
says so. A shortfall on one line is never repaid by the other — they are different
adaptations and the substitution buys nothing.

**What belongs in a plan at all:** work with a weekly dose to check against. Progressing
or flat both count — maintenance cardio is a legitimate plan with a flat dose. What does
not belong is incidental activity: a hike, a game of five-a-side. Log it and it records
itself as off-plan, measured against nothing, which is the honest place for it.

## Changing a plan mid-mesocycle

One call, all-or-nothing, and refused without `what_changed` and `why` — there is no way
to change the plan without saying why (`POST /mesocycles/current/decisions`; shape in
`reference/planning`). It can change the exercise list, change a dose (`redose`), replace
the intent, end the plan, or any combination; the decision log keeps the history, and a
review that changes nothing is the same call with no change fields. A dose is a plan
number like any other: there is no way to move it without saying why.

**The bar for changing a plan is high, and it is about evidence, not ideas.** Change it for pain,
for equipment that disappeared, for an exercise that keeps being skipped, or for a
diagnosis `evaluation` has actually reached. Do not revise because you thought of
something better — swapping an exercise mid-mesocycle discards its progression record, and
that record is most of what you have to reason with.

Wholesale change belongs between mesocycles. So does reclassifying an exercise's
muscles — `PUT /exercises/:ref/muscles`, the complete replacement list — which rewrites
every past volume number by design and is therefore **refused while any active plan
holds the exercise**. The rule is enforced, not just stated: mid-plan it 409s, at the
review it goes through and the response says how many finished weeks it rewrote.

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

End it on time, or early when `evaluation` says the plan is the problem and changing it
isn't enough. Either way it is one call — `POST /mesocycles/:id/decisions` with `ended_on`,
`what_changed` and `why` — because the ending and the reason for it are the same fact.
Six weeks later, "why did we stop that one" must have an answer.
