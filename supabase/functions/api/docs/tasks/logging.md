# Logging

Recording facts the person reports in chat, which is the only way anything gets logged.
The session is planned in one conversation, the person trains away from it, and
afterwards they say what they did — that report is how actuals reach the record. Payload
shapes are in `reference/sessions` (sessions, sets, corrections) and `reference/tracking`
(user context, bodyweight).

## A workout that never got logged (retro session)

`POST /sessions` with a past `date`, a `rationale` saying it was retro-logged and why the
session happened, and `sets` carrying actuals.

**Never invent targets for a retro session.** A target means "what was asked before the
work"; a forgotten session had no ask. The API rejects a **new** set written with both
targets and actuals, and the rejection is protecting the distinction — a planned set
acquires its actuals later through `PATCH /sets/:id`, but a target authored after the
work would always match what was done, and you could no longer tell a session that went
to plan from one that didn't.

## What a set records

Each exercise declares what a set of it carries — weight and reps, reps alone, metres,
seconds, or metres and seconds together. The table is in `reference/sessions`. Send what
the exercise is measured in and the API accepts it; send anything else and it says so.
Times are seconds and distances are metres: a 28-minute run is `"duration_s": 1680`.

An unloaded set of a loaded exercise is `weight_kg: 0`, not an absent weight. Absent means
the set was not done, and the two must never collapse into each other.

Work with no plan behind it — a hike, a game of five-a-side — logs the same way and records
itself as off-plan, measured against no dose. Don't invent a plan for it.

## Effort is not optional

`effort` is required on every performed working set of a **`strength`-stimulus** exercise
that counted reps: `easy`, `hard`, or `failure`. A push-up needs one as much as a squat.

Warmups get `"kind": "warmup"` and no effort — and so does explosive and conditioning work.
A box jump is not taken to failure and a sprint's record is its time; `easy` on either would
not be a mild inaccuracy but a false reading, since `easy` is defined as "too light, a
programming error" and evaluation acts on it.

If the person didn't say, **ask — don't guess**. Effort is the primary input to every load
decision that follows; a guessed chip quietly corrupts the next month of programming, and
nothing downstream can tell it apart from a real one.

People report this more accurately when the question is concrete. "How many more could you
have done?" works better than "how hard was that?". Anchor the answers:

- **four or more left** → `easy`
- **one to three left** → `hard`
- **nothing left, or the last rep broke down** → `failure`

Estimates are sharpest near failure and vaguest far from it, so a report of `easy` is
worth trusting in direction even when the person can't say by how much.

## Corrections

"That was 8 reps, not 9" → `PATCH /sets/:id` with the corrected fields. Find the set id
through `GET /sessions/:id`. Targets can never be edited.

Extra sets performed but not logged → `POST /sessions/:id/sets` with actuals.

Session-level facts — notes, how it felt overall, completion → `PATCH /sessions/:id`.

## User context

Anything true about the person that should outlive this conversation: goals, injuries,
preferences, equipment, refusals, spacing needs, how they're eating. This arrives
constantly and in no fixed shape. When they say something with lasting relevance, write it
in the same conversation — the next conversation has no other way to learn it.

1. **First `GET /user-context`** and reuse an existing topic string. "lower back" and
   "lumbar" must not become two live topics saying different things.
2. `POST /user-context` with the topic and content. Rows are never edited: correcting a
   fact means writing a new row on the same topic, and the latest row per topic is the
   current truth.
3. Retiring a topic means writing a final row saying it no longer applies.

Worth catching in particular, because they change what the numbers mean: what hurts and
under what conditions, what equipment came or went, whether they're eating to grow or in a
deficit, and any exercise they've decided they won't do.

Do not write session summaries or plan reasoning here. Session reasoning lives in
`sessions.rationale`; plan reasoning lives in the mesocycle's intent and decisions. Keeping
them apart is what makes each one findable.

## Bodyweight

`POST /bodyweight` with the value and, for past measurements, the timestamp. Resending
the same measurement is safe; a different value for the same instant is rejected — ask
which is right rather than picking one.
