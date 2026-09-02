# Session generation

Writing today's session. The most important job in the skill: this is where the plan meets
the day the person actually has.

## Before deciding anything

**`GET /training-state`.** It holds every active plan with its intent, its exercise
list with priorities, doses and notes, what has been delivered against each dose so
far this week, days since each exercise was last trained, this week's shape, recent
sessions with their rationales, recent decisions, and user context.

Each plan's exercises carry `dose` and `delivered_this_week` in the same unit, so what
is behind is a subtraction the read has already set up for you. Read each intent for
what the numbers can't say: the progression mechanism, the load goals, and how that
line has to sit against the others. Then read **the method document for each active
track** (`method_doc` on the plan names it); each decides how its own targets get
chosen, and applying one line's method to another is how a sprint session ends up
programmed like a hypertrophy session. Payload shapes are in `reference/sessions`.

## The week's shape

At the **first session generation of a week**, decide the shape of the whole week
before deciding today: how many sessions, and which line's work sits on which day.
With one plan running this is barely a decision. With two it is the decision — you
cannot choose today's session without knowing where the sprint day sits, because the
lines constrain each other and a greedy day-by-day choice paints the week into a
corner.

Propose it, let Marco accept or edit it, then write the accepted text:
`POST /week-schedule` (`reference/tracking`).

For the rest of the week it is the **default** answer to "what am I doing today" — a
default, never a contract. Deviating is always allowed and needs no edit; the record of
what actually happened is the sessions. Next week is written from scratch. It must never
harden into a template: it says which line goes where, not which sets get done.

What shapes it: each line's dose against what's been delivered, the placement
constraints in each intent, what the person said they can do this week, and the ordering
rules — quality before fatigue, and hard legs away from sprint days.

Then read what the person says about today: time, energy, soreness, equipment, mood.
If any of it is pain — a tweak, a pinch, "should I train through this?" — read
`tasks/pain` before deciding anything about the session.
**Today's reality outranks the plan's ideal shape.** A plan is a set of intentions about
an average week, and no week is average.

## Choosing the work

- **Start from the week's shape**, then adjust to the day the person actually has.
- **Prefer what's behind and what's stale.** Exercises furthest below their weekly
  dose, and the longest since last trained. `priority` breaks ties: low numbers deserve
  the freshest slots, because that is what priority meant when the plan was written.
- **Each line is judged against its own dose.** Being ahead on lifting does not excuse
  being behind on sprints, and doing extra of one never repays the other.
- **When a session serves two lines, quality goes first.** Sprints, jumps and heavy
  singles before anything that fatigues them; a sprint done tired is a slower sprint
  recorded as progress lost. You do not need to say which plan each set belongs to —
  the exercise decides it (`reference/sessions`).
- **Respect spacing constraints from user context** — 48 hours between heavy hinge days,
  or whatever they've said. These outrank the plan; they exist because something went
  wrong once.
- **Read the recent decision log.** A lift backed off by decision (`tasks/programming`,
  "Backing off") gets asked less until the decision's terms say otherwise —
  that is a chosen reduction, not a shortfall to chase.
- **How the week's sets get spread across days is largely free.** Training a muscle more
  or less often within the week has little effect on the outcome once the weekly total
  lands. So arrange around the day the person has rather than defending a symmetrical
  split. Check the method document for the goal's own view before leaning on this.
- **3–5 sets of one exercise in one session.** Past five, the later sets are degraded by
  fatigue from the earlier ones and per-exercise progress gets hard to read. A 12-set week
  is three sessions of four, not one of twelve.
- **Rehab-role work is not the session's point.** It carries a dose and should land, but
  it never displaces the work the plan exists for, and it never justifies a longer
  session than the person has.
- **Don't cram.** If the week can't fit the rest of the dose, it comes up short.
  Never pile the shortfall into the remaining days, and never carry them into next week. A short
  week recorded honestly is information; a crammed week is a lie about what happened.

## Choosing the targets

Apply the method document to this exercise's recent history. Last session's numbers are in
the training state; deeper history is `GET /exercises/:name/history?limit=20` — enough to see
the recent trend without reading a year of it.

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

For work measured by the clock or the tape, the effort chips do not apply and the target
is the prescription itself: metres and a time for a sprint, distance or duration for a
run. Its method document decides how those move; where a track has no method document
yet, `training-state` says so and you are working from general knowledge — say that
rather than implying otherwise.

**Warmups:** 2–3 rows for the first heavy lift of the day (`"kind": "warmup"`, e.g. around
50% and 75% of the top target), fewer or none for what follows once the person is warm.
Sprint and jump work warms up too — build up over a few rows rather than opening at full
speed.

## Writing it

`POST /sessions` with a fresh `request_id` UUID, today's date, the sets with their targets
(shape in `reference/sessions`), and a **rationale** — written every time.

The rationale is the only part of your thinking that survives this conversation. Name what
was prioritised, what was skipped and why, what the person said that shaped it, and why
the loads moved or didn't. A rationale that only describes the session is wasted — the
sets already describe the session. A good one reads like:

> "Week 3 lower day: squat still 4 sets short of plan, hips fresh (3 days). Held bench
> weight — last session's sets all came back easy on the top set only, so raised that
> one. Skipped RDL, lower back grumbling since Tuesday."

When more than one line is running, the rationale says what each was owed and why today
served the one it did — that is the part a later conversation cannot reconstruct from
the sets.

**Targets are frozen once created.** They are the record of what was asked before the work
happened, and that record is what makes the effort reports interpretable afterwards. When
the person comes back and reports what they actually did, log it as actuals (`logging`) —
never edit the ask.

**Iterating on a plan is delete-and-recreate, not supersede.** While nothing has been
performed, the session is a draft: if Marco wants it different, `DELETE /sessions/:id`
and write the better one — going back and forth must not leave abandoned sessions in
the record. The deletion is refused the moment any set carries an actual or the
session was started, so there is no risk of discarding real training by iterating.
