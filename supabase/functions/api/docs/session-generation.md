# Session generation

Writing today's session. The most important job in the skill: this is where the plan meets
the day the person actually has.

## Before deciding anything

**`GET /training-state`.** It holds the mesocycle's intent, the exercise list with
priorities and notes, this week's planned sets against what's been delivered, days since
each exercise was last trained, recent sessions with their rationales, and user context.

Read the intent first — it says how this mesocycle is meant to progress. Then fetch the
method document for the goal (`method/hypertrophy` and so on); it decides how targets get
chosen. Payload shapes are in `api-reference`.

Then read what the person says about today: time, energy, soreness, equipment, mood.
**Today's reality outranks the plan's ideal shape.** A plan is a set of intentions about
an average week, and no week is average.

## Choosing the work

- **Prefer what's behind and what's stale.** Exercises with planned sets still undelivered
  this week, and the longest since last trained. `priority` breaks ties: low numbers
  deserve the freshest slots, because that is what priority meant when the plan was
  written.
- **Respect spacing constraints from user context** — 48 hours between heavy hinge days,
  or whatever they've said. These outrank the plan; they exist because something went
  wrong once.
- **How the week's sets get spread across days is largely free.** Training a muscle more
  or less often within the week has little effect on the outcome once the weekly total
  lands. So arrange around the day the person has rather than defending a symmetrical
  split. Check the method document for the goal's own view before leaning on this.
- **3–5 sets of one exercise in one session.** Past five, the later sets are degraded by
  fatigue from the earlier ones and per-exercise progress gets hard to read. A 12-set week
  is three sessions of four, not one of twelve.
- **Don't cram.** If the week can't fit what remains, it comes up short. Never pile
  undelivered sets into the remaining days, and never carry them into next week. A short
  week recorded honestly is information; a crammed week is a lie about what happened.

## Choosing the targets

Apply the method document to this exercise's recent history. Last session's numbers are in
the training state; deeper history is `GET /exercises/:name/history`.

**Target the effort, then find the weight.** For a goal where effort is the primary
variable — hypertrophy, most obviously — what you are prescribing is a hard set of N reps,
and the weight is whatever makes N reps hard *today*. Read the effort chips from the last
session before anything else:

- Working sets came back `easy` → the weight was too light. Raise it, regardless of what
  the progression scheme would have said.
- Working sets came back `hard` → the scheme is on track. Apply it: under double
  progression, one more rep at the same weight, or the smallest jump and back to the
  bottom of the range if the top was reached on every set.
- Working sets came back `failure` repeatedly → back off. Either the weight is too heavy
  or fatigue has accumulated; both are answered by asking for less today, not more.

In doubt, repeat last session's numbers rather than guessing upward. A repeated session is
a small loss; a session that cannot be completed as asked corrupts both the effort record
and the progression record.

**Warmups:** 2–3 rows for the first heavy lift of the day (`"kind": "warmup"`, e.g. around
50% and 75% of the top target), fewer or none for what follows once the person is warm.

## Writing it

`POST /sessions` with a fresh `request_id` UUID, today's date, the sets with their targets
(shape in `api-reference`), and a **rationale** — written every time.

The rationale is the only part of your thinking that survives this conversation. Name what
was prioritised, what was skipped and why, what the person said that shaped it, and why
the loads moved or didn't. A rationale that only describes the session is wasted — the
sets already describe the session. A good one reads like:

> "Week 3 lower day: squat still 4 sets short of plan, hips fresh (3 days). Held bench
> weight — last session's sets all came back easy on the top set only, so raised that
> one. Skipped RDL, lower back grumbling since Tuesday."

The response carries `public_id`. Hand the person the log page link:
`<API base URL>/s/<public_id>`.

**Targets are frozen once created.** They are the record of what was asked before the work
happened, and that record is what makes the effort reports interpretable afterwards. If
the person reports mid-workout changes in chat rather than on the page, log them as
actuals (`logging`) — never edit the ask.
