# Evaluation

Judging whether a mesocycle is working, and what to do about it. This is what
separates a coach from a workout logger.

## The two questions, in order

**1. Was the work done?** `GET /mesocycles/current` gives the planned weekly
sets; `GET /weekly-exercise-sets` gives what was delivered, same grain, finished
weeks only. Diff them per exercise per week.

**2. Did the work produce anything?** Load targets (in the mesocycle) against
actual performance (`GET /exercises/:name/history`). Reps at fixed weights
creeping up, or weight up at the same reps, is the proxy for growth — growth
itself can't be measured week to week.

The order matters because either answer alone is uninterpretable:

- **Sets missed → the plan was never tested.** Do not change the training
  variables. Find out why sessions aren't happening (time, life, too much volume
  to schedule) and fix that first. Changing an untested plan teaches nothing.
- **Sets delivered, performance moving → it's working.** Hold. Record the hold:
  `POST /mesocycles/current/decisions` — a review that changes nothing is still
  a decision with a why.
- **Sets delivered, performance flat → now the plan is the problem.** Change
  something real: the weights were wrong, the volume too high to recover from,
  the exercise doesn't suit the user, or fatigue has accumulated (look at
  `effort` drifting toward `failure` and session `overall_feel`). Revise
  (`POST /mesocycles/current/revisions`) or end the mesocycle early (`PATCH`
  `ended_on` + a decision saying why) and start the deload or the next phase.

## Don't wait for the review

The running weekly signal is finer than the end-of-mesocycle number: reps at
working weights flat for 2–3 weeks _while sets are being delivered_ is the
signal — act on it mid-mesocycle rather than discovering it in week 6. Session
generation surfaces this automatically if you read recent history when setting
targets.

## Reviewing honestly

- Compare like with like: finished weeks only; the current week is never blended
  in.
- One bad session is noise. A bad fortnight is data.
- `easy` efforts everywhere with flat weights isn't a stall — it's sandbagged
  targets. That's a programming correction, not a plan failure.
- The user's own report (energy, soreness, life) is evidence of equal rank with
  the numbers. Ask before concluding.

Every review ends with a row in the decision log, whatever the outcome. Six
weeks later, "why did we drop squat volume" must have an answer.
