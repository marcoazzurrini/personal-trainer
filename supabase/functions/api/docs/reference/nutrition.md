# Nutrition — API reference

The food registry, what was eaten, and the current nutrition picture.

House conventions apply: `request_id` (a fresh UUID) on every creating POST; errors
are prompts — read and fix, don't retry blindly; foods and meals resolve by id, name,
or alias, case-insensitively; days are Europe/Rome calendar dates.

## Reads

| Endpoint | Returns |
| --- | --- |
| `GET /nutrition-state` | The complete current picture: today's entries and totals against the active target, trend weight and its 7/21-day slope, the expenditure estimate with band and status, active target, active transients, the last 13 finished days, logging and weigh-in adherence. The start of every nutrition conversation. |
| `GET /nutrition/weekly` | Finished weeks: mean kcal and protein, days logged and flagged, weigh-ins, trend start/end/delta, implied expenditure, events. `?weeks=N` (default 8). |
| `GET /nutrition-targets` | Every target ever set, plus the active one. |
| `GET /nutrition-events` | Registered transients, plus those still inside the damping window. |
| `GET /intake` | Today's entries, totals, and flags. `?day=YYYY-MM-DD` for another day. |
| `GET /days/:day` | The same view for one day. |
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
`{"aliases": [...]}`). `brand` is descriptive and nothing resolves on it, so two brands
of the same product need distinct names.

### The energy check

The server checks stated energy against the macros (protein and carbs 4 kcal/g, fat 9)
and rejects a food that disagrees by more than 15% **in either direction**, with a
20 kcal/100 g floor so near-zero foods pass. Almost every rejection is a real
transcription error — most often per-serving macros pasted against per-100 g energy.
**Recheck the label first.**

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

## Intake

```json
POST /intake
{ "day": "<optional, defaults to today in Rome>",
  "note": "<optional>", "request_id": "<uuid>",
  ... exactly one of the three forms below }
```

| Form | Fields | Writes |
| --- | --- | --- |
| A saved meal | `"meal": "<id, name, or alias>"` | one row per item, sharing `meal_id` |
| A single food | `"food": "<id, name, or alias>"` plus `"grams"` **or** `"units"` | one row |
| An ad-hoc estimate | `"adhoc_kcal": 1200`, optional `"adhoc_protein_g"` | one row |

Exactly one form per call. Multiple entries per day are normal, and the day's totals
are computed at read time.

`adhoc_kcal` is a **required number**, not an optional one. Estimate conversationally,
state the assumption, and log it — an ad-hoc entry is a first-class record, not a
failure. A day genuinely beyond estimating gets flagged `incomplete` instead, which
excludes it rather than counting it as zero.

Every entry stores its own kcal and macros, copied from the food at the moment of
logging. This is the design, not an optimisation: history stays what it was. The cost
is that correcting a mistyped food does **not** fix past entries — when that matters,
correct those rows explicitly.

### Correcting what was logged

```json
PATCH /intake/:id     { "grams": 165 }          // re-scales from the food as it is NOW
PATCH /intake/:id     { "kcal": 250, "protein_g": 12 }   // overrides outright
DELETE /intake/:id                              // a duplicate log, removed not zeroed
```

The snapshot is the default, not a prison. When a food turns out to have been wrong, or
an amount was misheard, fix the affected rows explicitly — sending `grams` re-scales
from the food's current numbers, which is exactly the "that yogurt was mislabelled, fix
this week" case. An ad-hoc entry has no food to re-scale from, so correct it with `kcal`
directly. Delete rather than zero a mis-log: a 0 kcal row still counts as a logged entry
and would inflate adherence.

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
silently overwritten.

## The expenditure estimate

`GET /nutrition-state` returns `expenditure` with a `status`, and the status decides
what the coach is allowed to say.

| Status | Meaning |
| --- | --- |
| `ok` | Back-solved over the current window. `tdee_kcal` ± `band_kcal`. |
| `damped` | A registered transient is being absorbed; the update is capped at 100 kcal/day. Explain the water, don't chase it. |
| `stale` | The current window stopped qualifying, so the last good estimate is **held** — `as_of` says which window it came from. Frozen, never extrapolated. |
| `insufficient_data` | No estimate. `reason` says exactly what is missing. |

The method is `TDEE ≈ mean(intake) − ΔE_stored/Δt`, validated against doubly-labeled
water to roughly ±150–250 kcal/day for an individual. **The band is not decoration.**
A week-over-week move inside it is noise by construction, and reacting to one is the
single most common way to make this system worse.

Three things the server refuses to fudge, all reported as `insufficient_data` with a
reason rather than a guess:

- fewer than 14 usable days in the window (days flagged `incomplete` are excluded, not
  counted as zero);
- fewer than 3 weigh-ins a week — the trend cannot carry a slope worth solving;
- **no body-fat estimate on record.** The energy density of a weight change is
  composition-weighted (Forbes: `p = 10.4/(10.4+FM)`, blending 1,020 kcal/kg for
  fat-free mass and 9,440 for fat). A flat 7,700 would bias the estimate upward
  throughout a lean cut. `POST /bodyfat` with a rough number fixes it; precision is
  not critical, presence is.

Trend weight is an EMA (α = 0.10) over the earliest weigh-in of each Rome day. A single
missing day is interpolated; longer gaps are **not** filled, because inventing a flat
stretch would drag the slope toward zero and read as a stalled diet.

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

- The goal is a **rate**, signed: negative cuts, positive gains, ~0 maintains. A sign
  that contradicts the goal is rejected — that mistake turns a cut into a bulk.
- Two guards clip a cut, and `clipped_reason` says which fired: `rate` (past
  −0.7%/week) or `deficit` (past 500 kcal/day). They are not the same guard — a
  percentage and an absolute number diverge as bodyweight changes — and `clipped: true`
  comes back so you explain the difference rather than quietly delivering something
  other than what was asked for.
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
metabolism. `logging_change` matters more than it looks: the estimate self-corrects for
*stable* under-logging, so a change in logging habit is the one thing that genuinely
breaks it.
