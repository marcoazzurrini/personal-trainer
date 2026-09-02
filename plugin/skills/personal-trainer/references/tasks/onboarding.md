# Onboarding — training

Establishing who the person is before anything gets programmed. Fetch this when
`training-state` comes back with no active mesocycle and little or no user context —
the first conversation, or a return after a long gap has made everything stale.

This is the training half only. Setting up food logging, targets and the expenditure
estimate is `tasks/nutrition-onboarding`, which triggers on its own condition —
`nutrition-state` with no target and an empty registry. The two halves are months
apart as often as not, and an empty record on one side says nothing about the other.
Do not run both interviews in one conversation because both happen to be empty; ask
which one the person came for.

The goal is not a filled form. It is enough true context that `tasks/programming` can
build a plan that fits this person, written where the next conversation will find it.
Payload shapes for what gets written: `reference/tracking`.

## The stance

- **Interview like a coach, not a registrar.** One question at a time, following up
  on what they actually say. A wall of questions gets a wall of thin answers; a
  conversation gets the detail that matters — "three sessions a week" means something
  different from "three, but Thursdays usually die".
- **Write as you go.** Each answer with lasting relevance goes to user-context in the
  same turn it arrives, under a durable topic string (`tasks/logging` holds the
  discipline). Never batch the writes for the end — the conversation may not reach
  the end.
- **Don't ask what you can read.** `training-state` and the exercise catalogue are
  already in front of you.

## What must be known before a plan exists

In order of what blocks programming, with why each matters:

1. **The goal.** It picks the method document, and everything downstream defers to
   that document. Vague is fine to start — "get bigger", "get stronger" — but pin it
   to one goal per mesocycle before planning.
2. **Sessions per week they can genuinely deliver.** This is the ceiling on the whole
   plan. Ask about the real week — work, family, the day that always collapses — not
   the aspirational one. The plan is programmed to this number, never above it.
3. **Equipment, exactly.** What is physically present, including the increments
   available — the smallest jump they can load decides how progression gets written.
4. **What hurts, and what they refuse.** Pain, injuries past and present, and any
   exercise they've decided they won't do. A refusal recorded now is a skipped-lift
   diagnosis avoided later.
5. **How they're eating.** To grow, at maintenance, or in a deficit. The method
   document calls this non-optional, because it changes what every future number
   means. **Read it before asking**: if a nutrition target is active,
   `GET /nutrition-targets` already states the goal and the rate, and asking anyway
   wastes their time and risks recording a second, contradicting answer. If there is
   no target, one sentence in their own words is enough here — "eating to grow",
   "cutting slowly" — written to user-context like any other fact. Do not slide into
   setting up food logging mid-interview: if they want calorie tracking, that is
   `tasks/nutrition-onboarding`, offered after this conversation lands, not folded
   into it.
6. **Recent training.** What they've actually been doing and the working weights
   they remember, as stated — no verification, no testing. This is the baseline
   material.
7. **A first bodyweight**, if they know it. One measurement starts the chart.

Everything else — spacing quirks, exercise preferences, how they respond to volume —
arrives on its own over the following weeks, and `tasks/logging` catches it then. Don't
front-load questions the record will answer better.

## Baselines without a testing week

Under an effort-first method, precise baselines are unnecessary. Take the working
weights the person states, pick opening targets conservatively below them, and let
the effort chips do the calibration: a set that comes back `easy` gets corrected next
session, and within a week or two the loads are true. A first week slightly light is
calibration, not waste.

Never open a coaching relationship with max testing. It risks the most at the moment
you know the least, and this system doesn't need the number.

Load targets in the first mesocycle take those conservative openers as their
baseline — written once, at creation, as always.

## Assistant memory

The standing rule holds: past chats and assistant memory are never a source for
coaching decisions — user-context is. During onboarding, memory has exactly one
permitted use: asking better questions. "I believe you squat around 90 kg — is that
still right?" is faster and more respectful of the person's time than pretending to
know nothing. But only what the person confirms in this conversation gets written,
and once written, user-context is the record. Nothing unconfirmed is acted on.

## What training onboarding is not

- Not a physical assessment. No measurements beyond bodyweight, no movement
  screens, no testing.
- Not the plan. Resist sketching the programme mid-interview — half-known context
  produces confident wrong plans, and promises made early constrain the design.
- Not nutrition setup. Item 5 records how they're eating in one line; it does not
  source foods, save meals, or set a calorie target. That is a different document
  with a different trigger.
- Not exhaustive. Six confirmed answers written down beat twenty collected and
  half-remembered.

## Handoff

When the list above is covered, say so, and move straight into `tasks/programming`
with the method document for the goal — in the same conversation if the person is
willing. The first plan should be modest: the excellent programme they abandon loses
to the modest one they run, and the first mesocycle is also the instrument that
measures everything you just wrote down.

If they also want to track what they eat, mention it once at the end and leave it
there — nutrition onboarding is its own conversation, and stacking it onto this one
produces two half-built systems instead of one working plan.
