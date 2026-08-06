# Evaluation

Judging whether a mesocycle is working, and what to do about it. This is what separates a
coach from a workout logger.

Fetch the method document for the goal first (`method/hypertrophy` and so on). It defines
what "working" looks like for this adaptation and over what timescale — the questions below
are the procedure, not the standard.

## The three questions, in order

**1. Was the work done?** The intent states the weekly dose per exercise;
`GET /weekly-exercise-sets` gives what was delivered, finished weeks only. Diff them
per exercise per week — with a script, not in your head. Before calling a shortfall
non-adherence, read the decision log: a backed-off lift or a declared light week is a
chosen reduction, and the dose it was judged against is the one the decision set.

**2. Was the work hard enough?** Effort chips on the working sets, from
`GET /sessions?limit=30` or the exercise's history. Sets delivered at the wrong effort are
not the work the plan asked for, even though the count matches.

**3. Did it produce anything?** The intent's load goals against actual performance
(`GET /exercises/:name/history`). Reps creeping up at fixed weights, or weight up at the
same reps, is the proxy — the adaptation itself can't be measured week to week.

The order matters because no answer is interpretable on its own:

- **Sets missed → the plan was never tested.** Do not change the training variables. Find
  out why the sessions aren't happening — time, life, too much volume to schedule, a lift
  they've quietly stopped wanting to do — and fix that. Changing an untested plan teaches
  you nothing and destroys the only clean experiment you had.
- **Sets delivered but `easy` → the loads were wrong, not the plan.** This is a programming
  correction, and a cheap one. Raise the targets and let the plan run. Adding volume here
  is the classic mistake: it makes an under-stimulating session longer instead of harder.
- **Sets delivered, effort honest, performance moving → it's working.** Hold. Record the
  hold: `POST /mesocycles/current/decisions`. A review that changes nothing is still a
  decision with a reason, and next time you'll want to know you looked.
- **Sets delivered, effort honest, performance flat → now the plan is the problem.**
  Change something real: the volume is too high to recover from, the exercise doesn't suit
  the person, fatigue has accumulated, or the method needs revisiting. Revise
  (`POST /mesocycles/current/revisions`; shape in `reference/planning`) or end the
  mesocycle early (`PATCH` `ended_on` plus a decision saying why).

## Check the constraints before diagnosing the plan

Two things routinely masquerade as a failing programme:

- **Energy availability.** Someone at maintenance or in a deficit will hold numbers rather
  than add to them, and holding is a success. Read what user context says about how
  they're eating before concluding anything, and if it doesn't say, ask.
- **Life.** Sleep, stress, illness, a hard month at work. Flat numbers during one are not
  evidence about the plan.

Neither is a reason to change training variables. Both are reasons to say plainly what the
binding constraint actually is.

## Don't wait for the review

The running weekly signal is finer than the end-of-mesocycle number. Reps at working
weights flat for two to three weeks *while sets are being delivered at honest effort* is
the signal — act on it then, rather than discovering it in week six. Session generation
surfaces this on its own if you read the recent history when setting targets.

## Reviewing honestly

- **Compare like with like.** Finished weeks only; the current week is never blended in.
- **One bad session is noise. A bad fortnight is data.**
- **The person's own report is evidence of equal rank with the numbers.** Energy,
  soreness, how the sessions have been feeling, whether they still want to do this. Ask
  before concluding.
- **Prefer the smallest change that addresses the diagnosis.** Most findings have a
  cheaper answer than a new plan, and every unnecessary change costs you the readability
  of what came before.
- **Be willing to conclude nothing yet.** Three weeks of data with two missed sessions
  supports no diagnosis at all. Saying so is more useful than manufacturing one.

Every review ends with a row in the decision log, whatever the outcome. Six weeks later,
"why did we drop squat volume" must have an answer.
