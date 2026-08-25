# Nutrition — API reference

The food registry, what was eaten, and the current nutrition picture.

House conventions apply: `request_id` (a fresh UUID) is **required** on every creating
POST and is what makes a retry safe; errors are prompts — read and fix, don't retry
blindly; foods and meals resolve by id, name, or alias, case-insensitively; days are
Europe/Rome calendar dates.

## Reads

| Endpoint | Returns |
| --- | --- |
| `GET /nutrition-state` | The complete current picture: today's entries and totals against the active target, trend weight and its 7/21-day slope, the expenditure estimate with band and status, active target, active transients, the last 13 finished days, logging and weigh-in adherence. The start of every nutrition conversation. |
| `GET /nutrition/weekly` | Finished weeks: mean kcal and protein, days logged and flagged, weigh-ins, trend start/end/delta, the week's own `rate_pct_bw_week`, implied expenditure, events, and **the target that governed that week**. `?weeks=N` (default 8). |
| `GET /nutrition-targets` | Every target ever set, plus the active one. |
| `GET /nutrition-events` | Registered transients, plus those still inside the damping window. |
| `GET /intake` | Today's entries, totals, and flags. `?day=YYYY-MM-DD` for another day. |
| `GET /days/:day` | The same view for one day. |
| `GET /bodyweight` | Two series in one call: `bodyweight` (raw instants) and `trend` (one point per day, the EMA the estimate runs on). The bodyweight chart's single read. |
| `GET /foods?q=<search>` | Foods matching a substring of name, brand, or alias. No `q` returns the whole registry. |
| `GET /foods/:idOrName` | One food, with its aliases. Resolves by id, name, or alias. |
| `GET /meals` | Saved meals with their aliases and item counts. |
| `GET /meals/:idOrName` | One meal: items with resolved foods, and computed totals. |
| `GET /bodyweight` | Bodyweight measurements — see `reference/tracking`. |
| `GET /bodyfat` | Body-fat estimates over time. |

## Foods

```json
POST /foods
{
  "name": "Greek Yogurt 0%",
  "brand": "<optional>",
  "kcal_100g": 57, "protein_100g": 10.3, "carbs_100g": 4, "fat_100g": 0.2,
  "fiber_100g": "<optional>",
  "grams_per_unit": "<optional, for foods eaten in pieces>",
  "source": "label | crea | usda | off | estimate",
  "source_note": "<optional>",
  "aliases": ["optional", "alternative names"],
  "request_id": "<uuid>"
}
```

Values are **per 100 g, always** — including for foods bought by the piece. Set
`grams_per_unit` on those (an egg at 55) and intake can then be logged as `units`.

`source` is not decorative. `estimate` is the honest label for a number with no good
source, and an estimate is disclosed to Marco as one. A confident invention is the
single unforgivable failure of this endpoint family — see `tasks/nutrition-logging`
for the lookup ladder.

**One food, one row.** Names are case-insensitive and unique. A synonym never becomes
a second food — that splits its history exactly the way a duplicate exercise splits a
lift's. Add synonyms with `POST /foods/:ref/aliases` (`{"alias": "..."}` or
`{"aliases": [...]}`), remove one with `DELETE /foods/:ref/aliases/:alias`. `brand` is
descriptive and nothing resolves on it, so two brands of the same product need distinct
names.

`DELETE /foods/:ref` removes a food **nothing currently references** — a typo'd
duplicate caught before it was logged. The test is present references, not history: a
food whose only logged entry has since been deleted becomes deletable again. Any food
still referenced by an intake entry or a meal item is refused, with the counts; if its
numbers are wrong, PATCH fixes them and the history with them. Aliases are not a
reference — they are removed with the food.

### Correcting a food — retroactive, and only ever a mistake

```json
PATCH /foods/:ref
{ "kcal_100g": 360, "protein_100g": 6.6, ... , "source_note": "raw, not cooked" }
```

**Editing a food fixes every entry ever logged against it.** If white rice was saved at
130 kcal and it is 360, those entries were wrong the moment they were written — that is
an error, not history. The grams on each entry never change; only what those grams mean.
The response says how many entries were rewritten and over what dates.

This is the exact opposite of a meal, and the difference is the whole rule:

| | What a change means | Past entries |
| --- | --- | --- |
| **Food** | the numbers were always wrong | corrected too |
| **Meal** | Marco started eating differently | stand, untouched |

**A different product is never an edit.** Another brand of Greek yogurt, a reformulated
recipe, cooked versus raw — those are separate foods, saved with `POST /foods` under
their own name. Editing the original would assert that its old numbers were a mistake,
and they weren't. This rule is what makes blanket retroactivity safe; breaking it
corrupts history silently.

The energy check below runs on the corrected values too.

### The energy check

The server checks stated energy against the macros (protein and carbs 4 kcal/g, fat 9)
and rejects a food that disagrees by more than 15% **in either direction**. The 15% is
measured against **the energy the macros imply**, not against the stated figure — so a
food whose macros come to 400 kcal is allowed to state anything within ±60 of it. A
20 kcal/100 g floor sits under that, so near-zero foods (black coffee, diet drinks)
pass on the absolute allowance rather than on a percentage of almost nothing. Almost
every rejection is a real transcription error — most often per-serving macros pasted
against per-100 g energy. **Recheck the label first.**

A second, separate guard rejects macros that outweigh the food: protein + carbs + fat
above 105 g per 100 g cannot be true whatever the energy says, and scaling per-serving
values keeps the energy identity intact while breaking this one. Fibre is not counted
in that sum, because USDA folds it into the carbohydrate figure and EU declares it
apart. This guard has no override — no labelling convention makes it legitimate. The
fix is always the same: divide by the serving size in grams and multiply by 100.

Both directions are overridable, because EU labelling makes both legitimately possible:

- **Stated energy above the macros** — alcohol is 7 kcal/g and appears in no macro.
- **Stated energy below the macros** — polyols (sugar alcohols) sit inside the
  carbohydrate figure but only carry ~2.4 kcal/g in the energy line. A sugar-free bar
  with 90 g of maltitol computes to ~360 kcal against a stated ~240. The label is
  correct; the identity simply doesn't apply.

When the label really does say what it says, resend with `"energy_check": "override"`
and a `source_note` naming the cause. The override without a note is refused — it would
be indistinguishable from a typo.

## Meals

```json
POST /meals
{
  "name": "Colazione",
  "aliases": ["la solita colazione"],
  "items": [{ "food": "il solito yogurt", "grams": 200 },
            { "food": "Honey", "grams": 20 }],
  "request_id": "<uuid>"
}
```

Created whole, in one transaction. Foods are referenced by id, name, or alias and must
already exist. Totals are computed at read time, never stored.

**Meals are routines, not history.** Logging a meal copies its foods' numbers onto the
intake rows, so editing a meal — or the foods in it — changes what future logs write
and cannot reach anything already logged. A one-off variation ("usual breakfast but
double yogurt") is the meal plus a separate food entry, not a new meal; create a new
meal only when a variation has become a routine.

```json
PATCH /meals/:ref
{ "name": "<optional>", "aliases": ["<added, not replaced>"],
  "items": [{ "food": "...", "grams": 200 }] }
```

`items`, when sent, is the **complete replacement list** — a partial edit of a recipe is
ambiguous about what was meant to survive. The edit changes future logs only; nothing in
it can reach anything already logged, by construction rather than by care.

**Meals are never deleted.** The intake rows point at them, and a routine that was
abandoned is still a routine that was followed. Retiring one means taking its aliases
away — `DELETE /meals/:ref/aliases/:alias`. It keeps its name and its history and stops
answering to the word Marco says out loud, so a replacement can claim that word. A meal
created by mistake doesn't need deleting either: edit it into what you meant.

## Intake

```json
POST /intake
{ "day": "<optional, defaults to today in Rome>",
  "note": "<optional>", "request_id": "<uuid>",
  ... exactly one of the three forms below }
```

| Form | Fields | Writes |
| --- | --- | --- |
| A saved meal | `"meal": "<id, name, or alias>"`, optional `"scale"` | one row per item, sharing `meal_id` |
| A single food | `"food": "<id, name, or alias>"` plus `"grams"` **or** `"units"` | one row |
| An ad-hoc estimate | `"adhoc_kcal": 1200`, optional `"adhoc_protein_g"` | one row |

Exactly one form per call. Multiple entries per day are normal, and the day's totals
are computed at read time.

`scale` is a fraction of a saved meal — `0.5` for half the usual portion, `2` for a
double — and multiplies every item's grams, macros following the grams actually
stored. It goes with `meal` and only with `meal`: part of a single food is that food
at fewer grams, and part of an estimate is the estimate at the number you mean. It
must be greater than 0 and at most 10; past that the decimal point is in the wrong
place. Use it rather than expanding a meal into separate food entries by hand — the
expansion loses the `meal_id` that says these rows were one routine.

`adhoc_kcal` is a **required number**, not an optional one. Estimate conversationally,
state the assumption, and log it — an ad-hoc entry is a first-class record, not a
failure. A day genuinely beyond estimating gets flagged `incomplete` instead, which
excludes it rather than counting it as zero.

Every entry stores its own kcal and macros, copied from the food at the moment of
logging. This is the design, not an optimisation, and it splits into two rules that
look contradictory until you see what each is for:

- **A food's numbers were wrong** — they were always wrong, including on the day it
  was eaten. `PATCH /foods/:ref` corrects the food *and every entry ever logged from
  it*, and says how many it rewrote.
- **A meal's recipe changed** — the old version really was eaten. Editing a meal
  changes what future logs write and leaves history alone.

The test is whether the record was wrong or the world moved on.

### Correcting what was logged

```json
PATCH /intake/:id     { "day": "2026-08-20" }   // moves it; the numbers do not change
PATCH /intake/:id     { "grams": 165 }          // re-scales from the food as it is NOW
PATCH /intake/:id     { "kcal": 250, "protein_g": 12 }   // overrides outright
DELETE /intake/:id                              // a duplicate log, removed not zeroed
```

These fix **one entry**, when that entry is what was wrong: the amount was misheard, or
that day's portion was unusual. If the *food's* numbers are wrong, don't correct entries
one by one — `PATCH /foods/:ref` fixes the food and every entry at once.

Sending `day` moves an entry to another date and changes nothing else — for logging
after midnight, or a day misremembered by one. Use it instead of deleting and logging
again: re-logging retypes every ad-hoc number by hand and re-reads a meal's recipe as
it is now. It cannot land in the future, and the reply is the day the entry moved to,
with `moved_from` naming the day it left, since that day's totals changed as well.

Sending `grams` re-scales from the food; an ad-hoc entry has no food to re-scale from,
so correct it with `kcal` directly. Delete rather than zero a mis-log: a 0 kcal row
still counts as a logged entry and would inflate adherence.

### Reading totals: `unaccounted`

Totals come back with an `unaccounted` object, keyed by macro, listing how many entries
and how many kcal carried no value for it. Only macros with a gap appear; an empty
object means the totals are complete.

This matters. An ad-hoc entry is usually silent about protein, so a protein total over
a day containing one is a **floor, not a total** — never tell Marco he ate 55 g of
protein when 1200 kcal of the day said nothing about it. A macro that no entry carried
reports `null` rather than `0`, because unknown is not zero. Fibre is routinely absent
from ordinary foods, which is why the gaps are reported per macro rather than per entry.

## Day flags

```json
POST /days/:day/flags     { "flag": "incomplete" }
DELETE /days/:day/flags/incomplete
```

"I didn't track today at all." The day leaves the intake record's usable set rather
than entering it as zero, which would drag any mean computed over it. Removable — a
flag is a statement about the record, not part of it. Treat a flagged day as
unremarkable: one missed day is statistically nothing.

## Body fat

```json
POST /bodyfat
{ "percent": 14.5, "method": "bia | dxa | caliper | visual | other",
  "day": "<optional, defaults to today>", "note": "<optional>",
  "request_id": "<uuid>" }
```

Exists for one reason: the energy density of a weight change is composition-weighted
rather than a flat 7,700 kcal/kg, and the expenditure back-solve needs fat mass to
compute it. Precision is not critical — the result is only modestly sensitive to error
here — but it needs re-anchoring occasionally, which is why it is a series.

Deduped on `(day, method)` like bodyweight on `(measured_at, source)`: resending is a
no-op, and a different value for the same day and method is rejected rather than
silently overwritten. A typo is removed with `DELETE /bodyfat/:id` and re-entered — 41%
instead of 14% moves fat mass by 22 kg, which moves the energy density and therefore the
calorie target.

## The expenditure estimate

`GET /nutrition-state` returns `expenditure` with a `status`, and the status decides
what the coach is allowed to say.

| Status | Meaning |
| --- | --- |
| `ok` | Back-solved over the current window. `tdee_kcal` ± `band_kcal`. |
| `damped` | A registered transient is being absorbed; the update is capped at 100 kcal/day. Explain the water, don't chase it. |
| `stale` | The current window stopped qualifying, so the last good estimate is **held** — `as_of` says which window it came from. Frozen, never extrapolated. |
| `insufficient_data` | No estimate at all. `blockers` lists every unmet condition; `as_of` is null, because there is nothing to date-stamp. |

`as_of` is the window the returned number belongs to: today's under `ok` and `damped`,
an older one under `stale`, and **null under `insufficient_data`**. A date beside a null
`tdee_kcal` would read as "current as of", implying a number exists when none does.

The method is `TDEE ≈ mean(intake) − ΔE_stored/Δt`, validated against doubly-labeled
water to roughly ±150–250 kcal/day for an individual. **The band is not decoration.**
A week-over-week move inside it is noise by construction, and reacting to one is the
single most common way to make this system worse.

**The window is the last three finished Monday–Sunday weeks** — 21 days ending on the
most recent finished Sunday, never the running week — whole-week aligned so weekend
eating cancels out. Anything logged or weighed this week is real but outside it until
the week finishes; the blockers name the window's dates and acknowledge weigh-ins made
since it closed, so relay those rather than "you have no weigh-ins". A day inside the
window is *usable* if it has logged intake; days flagged `incomplete` are excluded
rather than counted as zero. So the requirement is 14 usable days out of 21 — roughly
two days logged in every three. That ratio is what lets you answer the question Marco
will actually ask: how many more days until there's a number.

Three things the server refuses to fudge, all reported as `insufficient_data` rather
than a guess:

- fewer than **14 usable days out of the 21**;
- fewer than **3 weigh-in days a week** — days, not scale readings: a morning that
  syncs eight readings is one weigh-in day. Under this, the trend cannot carry a slope
  worth solving;
- **no body-fat estimate on record.** The energy density of a weight change is
  composition-weighted (Forbes: `p = 10.4/(10.4+FM)`, blending 1,020 kcal/kg for
  fat-free mass and 9,440 for fat). A flat 7,700 would bias the estimate upward
  throughout a lean cut. `POST /bodyfat` with a rough number fixes it; precision is
  not critical, presence is. Nothing in daily use asks for this, so it is the one that
  gets forgotten — and without it the estimate never arrives no matter how well Marco
  logs.

**All unmet conditions are reported together**, in `blockers` as a list and joined into
`reason`. Tell Marco everything that is missing at once; the alternative is him
perfecting his logging for a fortnight and then discovering he also needed a body-fat
number.

Trend weight is an EMA (α = 0.10) over the earliest weigh-in of each Rome day. A single
missing day is interpolated; longer gaps are **not** filled, because inventing a flat
stretch would drag the slope toward zero and read as a stalled diet.

`earliest_scale_kg` in `/nutrition-state` is that chosen reading, not the most recent
one. On a day Marco stepped on the scale several times, `GET /bodyweight` will show
later and higher numbers, and they are not being ignored by mistake — the earliest is
the most fasted and so the one comparable across days. If he asks why the trend used a
number lower than what the scale said this afternoon, that is the answer.

## Targets

```json
POST /nutrition-targets
{ "goal": "cut | maintain | gain | recomp",
  "rate_pct_bw_week": -0.5,
  "protein_g_per_kg_ffm": 2.7,
  "decision": "<required: why now>",
  "effective_from": "<optional, defaults to today>",
  "request_id": "<uuid>" }
```

**Neither number is sent as a finished figure.** You choose a rate and a protein
multiplier; the server turns them into calories and grams and shows its working in
`computation` and `protein_computation`. That split is the same one as everywhere else:
the judgment is yours, the arithmetic is not.

Protein — send exactly one:

| Input | Basis | Use when |
| --- | --- | --- |
| `protein_g_per_kg_ffm` | fat-free mass | in a deficit — 2.3–3.1. Muscle retention scales with the mass being retained, not the fat being lost. Needs a body-fat estimate. |
| `protein_g_per_kg_bw` | bodyweight | maintenance or surplus — 1.6–2.2 |
| `protein_g_target` | none | a finished number, when neither basis fits |

The two bases are ~40 g/day apart at the same multiplier, which is exactly why this is
not multiplication to do in your head.

Calories — omit `kcal_target` and the server computes it from the current estimate and
the rate. Sending an explicit `kcal_target` bypasses the arithmetic and should be rare.

- The goal is a **rate**, signed: negative cuts, positive gains, ~0 maintains. A
  recomp holds or drops slowly — accepted from −0.7 to +0.15, with the real bound
  enforced in kcal below. A sign that contradicts a cut or a gain is rejected — that
  mistake turns a cut into a bulk.
- Both directions clip, and `clipped_reason` says which guard fired. A cut: `rate`
  (past −0.7%/week) or `deficit` (past 500 kcal/day). A gain: `rate` (past +0.5%/week)
  or `surplus` (past 350 kcal/day). A recomp: `recomp_deficit` (past 200 kcal/day —
  its doctrine is a kcal band, so it is enforced in kcal at any bodyweight, and a
  doctrine-compliant recomp never needs relabelling as a cut). A percentage and an
  absolute number diverge as bodyweight changes, which is why each direction carries
  both kinds — and `clipped: true` comes back so you explain the difference rather
  than quietly delivering something other than what was asked for.
- `decision` is required, like a mesocycle revision's. Nothing changes what Marco eats
  without a written reason.
- Append-only. The latest row by `effective_from` (then id) is active; two targets can
  share a day and the later wins. Never edit a target — supersede it.
- Changing `goal` **automatically registers a `phase_switch` event**, because a phase
  switch moves 1–2 kg of water within days and the estimate must damp through it.
  `phase_switch_registered` in the response confirms it.

## Events

```json
POST /nutrition-events
{ "kind": "creatine_start | phase_switch | program_change | logging_change | other",
  "day": "<optional, defaults to today>", "note": "...", "request_id": "<uuid>" }
```

Register anything that moves bodyweight for reasons that are not fat or muscle. For
~14 days afterwards the back-solve damps large jumps instead of reading them as
metabolism. `DELETE /nutrition-events/:id` removes one registered by mistake — a
transient on the wrong day damps an estimate that had nothing to absorb. `logging_change` matters more than it looks: the estimate self-corrects for
*stable* under-logging, so a change in logging habit is the one thing that genuinely
breaks it.

## Reading a week against its target

Each row in `GET /nutrition/weekly` carries a `target` object — the one in force at the
week's end — alongside what actually happened. That join exists so nobody has to
reconstruct which target applied to which week by date from an append-only history.

- `target` is **null for weeks that predate any target**. A target set today governs
  nothing that already finished, and pretending otherwise would score Marco against a
  rule that did not exist.
- `target.changed_during_week` is true when one target superseded another mid-week. The
  comparison is muddy there; say so rather than drawing a clean bar against the later one.
- `rate_pct_bw_week` on the row is what the week's trend actually did; `target.rate_pct_bw_week`
  is what was asked for. Those two together are the answer to "is this working" — see
  `tasks/charts` view 6.
- `mean_kcal` is an average over `days_logged`, not over seven days. A week averaging
  2,100 kcal across three logged days is not a 2,100 kcal week, and reading it as one is
  the most likely way this endpoint misleads.

## What can be removed, and what cannot

**Measurements, mistakes and pointers come out. Routines and decisions stay.**

| | |
| --- | --- |
| food and meal aliases | deletable — a pointer, not a fact. This is how a spoken name moves. |
| foods | deletable only if nothing currently references it; otherwise PATCH, which fixes the past too |
| meals | never deleted — retire by removing aliases |
| bodyweight, body fat | deletable — a mistyped measurement is a mistake, not history |
| nutrition events | deletable — a claim about the world can be wrong |
| intake entries | deletable — a mis-log is not a meal |
| targets | append-only, never deleted or edited: supersede with a new row |
