# Onboarding — nutrition

Setting the nutrition system up before anything is logged. Fetch this when
`nutrition-state` comes back with no active target and an empty registry — no
saved foods, no logged days — or when a long gap has left the record cold.

This is the nutrition half only. Training setup is `tasks/onboarding` and
triggers on its own condition; the two can be months apart and neither implies
the other. Do not run both interviews in one conversation because both happen
to be empty — ask which one he came for.

Reference for payload shapes: `reference/nutrition`. Method: `method/nutrition`,
whose behavioural doctrine is binding here more than anywhere else — this whole
document is the doctrine applied to day zero.

## The stance

- **This is a setup, not an interview.** Training onboarding collects context so
  a plan can be written. Nutrition onboarding builds a machine that has to still
  be running in eight weeks. The deliverable is not a filled record — it is that
  tomorrow morning's log costs seconds. Every question earns its place by
  removing friction later, or it doesn't get asked.
- **Friction is the enemy, starting now.** The failure mode of nutrition
  tracking is not inaccuracy, it is abandonment. A rough setup used daily beats
  a meticulous one abandoned in week three, and the setup conversation is where
  that gets decided.
- **Write as you go.** Each food, alias and estimate goes to the API in the turn
  it arrives. Never batch for the end — the conversation may not reach the end.
- **Don't ask what you can read.** `nutrition-state`, `GET /bodyweight`,
  `GET /foods`, `GET /meals` are already in front of you.
- **Finish with something logged.** If the conversation is going well, get one
  meal saved and one real entry written before it ends. A system that has never
  been used once is not set up.

## What must exist, in order of what blocks what

### 1. Weighing, and the cue that makes it happen

Trend weight is the backbone of everything downstream: it is an EMA over the
earliest weigh-in of each Rome day, and the expenditure back-solve needs at
least three weigh-ins a week to carry a slope worth solving.

Establish where the scale is and what the weigh-in is anchored to — the doctrine
is a fixed cue, and the reliable one is waking, bathroom, scale, before eating
or drinking. If weigh-ins arrive automatically from a connected scale, confirm
they are actually landing in `GET /bodyweight` rather than assuming it, and say
plainly that automatic weight is the one behaviour he never has to maintain.

Set the expectation now, before the first spike: raw scale weight is water,
glycogen and gut content. He will see 1.5 kg of movement that means nothing.
Trend weight is the only weight, and saying this on day zero is worth more than
saying it after he reacts to a number.

### 2. A body-fat estimate — the one that gets forgotten

**Nothing computes an expenditure without this**, and it is the requirement
most likely to be skipped because nothing in daily use asks for it. The energy
density of a weight change is composition-weighted rather than a flat
7,700 kcal/kg, so the back-solve needs fat mass to convert a trend into
calories. Without a row in `POST /bodyfat`, `nutrition-state` returns
`insufficient_data` forever, no matter how perfectly he logs.

Take whatever is actually available, in this order:

- a DXA result if he has ever had one (`method: dxa`);
- calipers, if he owns them and someone can take them (`method: caliper`);
- a **visual estimate against reference photographs** (`method: visual`) — this
  is the normal answer and it is good enough;
- BIA (`method: bia`) only if a scale he already uses reports it. Do not tell
  him to buy hardware for this number.

Say the quiet part out loud so he doesn't stall on precision: the result is only
modestly sensitive to error here, ±3 percentage points barely moves the
estimate, and presence beats accuracy. Re-anchor it every couple of months, not
every week — it is a series, deduped on `(day, method)`.

If he genuinely will not give a number, say explicitly what he is giving up:
no expenditure estimate, therefore no server-computed target, therefore targets
set from judgment alone. That is a legitimate choice, but it is his to make
knowingly.

### 3. The goal, and why the first target usually waits

Translate the goal into a **rate**, per the method doc: cut −0.5%/week default
and never past −0.7%/week or a 500 kcal/day deficit; gain +0.25–0.5%/week;
recomp at or just under maintenance, with the warning that the scale will barely
move and this is the slowest road for someone already trained.

Then the part that matters at onboarding: `POST /nutrition-targets` computes
calories **from the current expenditure estimate**, and on day zero there is no
estimate. The window needs 14 usable days out of 21 and the body-fat row from
step 2. The call is rejected rather than answered with a guess, and the error
names every blocker at once. So there are two honest paths, and you pick one
with him rather than silently:

- **Baseline first (default).** Log habitual intake for 10–14 days with no
  target at all, then set the first target from measured expenditure. This costs
  nothing: those two weeks are exactly the habit-building window the doctrine
  cares about, the logging practice is the real work, and the resulting target
  is built on his data instead of a formula. Tell him the number is coming and
  when.
- **Provisional target now.** If he wants a number to eat to immediately, set
  one with an explicit `kcal_target`, and say in the `decision` field that it is
  provisional and will be superseded once the estimate exists. Targets are
  append-only, so superseding is the normal mechanism, not a repair.

Either way, set protein from the start — it is the one macro with a hard target
and it does not need an expenditure estimate: `protein_g_per_kg_ffm` 2.3–3.1 in
a deficit (needs the body-fat row), `protein_g_per_kg_bw` 1.6–2.2 at maintenance
or in surplus. Send the multiplier, never a finished gram figure.

### 4. Three to five saved staples — the highest-leverage step here

This is where the system is won or lost. A day logged from saved meals costs
seconds; a day rebuilt from scratch costs minutes and stops happening around
week three.

Ask what he actually eats repeatedly — the breakfast, the standard lunch, the
protein he cooks most weeks, the evening snack — and build those out:

- source each food properly through the lookup ladder in
  `tasks/nutrition-logging` (his own label first, then CREA, USDA, Open Food
  Facts) and save it with an honest `source`; never invent numbers to move the
  conversation along;
- assemble the repeated combinations into meals with `POST /meals`;
- give every food and meal **the aliases he actually says out loud** — "il
  solito yogurt", "colazione", "il frullato" — not the canonical names. Voice
  input resolves against these, so aliases in his own words are the entire point.

Three staples he eats every week beat twenty saved and forgotten. Stop when the
common days are covered and let the rest arrive through normal logging.

### 5. How he will log, in his own words

Confirm the channel and the register: most messages will arrive as voice-to-text,
casual, in Italian, with no numbers. Say plainly that this is expected and
supported — "il solito più un caffè" is a complete log — and that vague days
("pizza fuori, saranno state 1200") are first-class entries, not failures.

Say once, now, the three things that keep him from quitting later:
one missed day is statistically nothing and will never be mentioned; a day he
truly didn't track gets flagged `incomplete` rather than counted as zero; and
consistency of logging matters more than accuracy of logging, because a stable
bias cancels out of the estimate and a changing habit does not.

### 6. Constraints that shape the record

Allergies and restrictions, foods he refuses, alcohol patterns, and the meals he
does not control — eating out, family meals, work lunches. These go to
user-context, not into the food registry. They matter because the two lapse
patterns worth watching are eating at unplanned times and drinking, and both are
handled by planning around them in advance rather than reacting after.

## Coordination with training

If a mesocycle is already running, read `training-state` before setting a rate.
Do not open an aggressive cut against an intensification block — flag the
conflict and let him choose. If a new programme or creatine start is landing in
the same period, register it with `POST /nutrition-events` so the expenditure
back-solve damps through it instead of reading water as metabolism.

## Assistant memory

The standing rule holds: past chats and assistant memory are never a source.
During onboarding, memory has exactly one permitted use — asking a better
question. "I think you usually have Greek yogurt in the morning, still right?"
is faster and more respectful than pretending to know nothing. Only what he
confirms in this conversation gets written, and once written, the API is the
record.

## What nutrition onboarding is not

- **Not a meal plan.** This system records what he eats; it does not prescribe
  menus. Meal timing, food choice and the carb/fat split are preference and
  satiety management, never a prescription, and never moralised about.
- **Not micronutrients.** Say so and why if asked: nothing in his goals depends
  on them, and tracking them taxes the one resource that actually predicts
  success.
- **Not a weigh-in-and-measure session.** Bodyweight and one rough body-fat
  estimate. No circumferences, no photos, no before-and-after ritual.
- **Not a target invented to have one.** A calorie number presented as this
  system's answer when the system did not produce one is the same failure as
  inventing a food's macros.
- **Not exhaustive.** Three saved meals and a running weigh-in beat a complete
  registry and no habit.

## Handoff

When weighing is running, a body-fat estimate is on record, the staples are
saved, and one entry has actually been logged, say so plainly and name what
happens next: daily logging under `tasks/nutrition-logging`, and the first
`tasks/nutrition-checkin` once there is something to check — which is roughly
two weeks out, not next Monday, because the estimate needs 14 usable days in a
21-day window before it will say anything at all.

Tell him that timeline explicitly. The most common way this system loses someone
is silence in week one, when he is logging diligently and the app appears to
have nothing to say.
