# Task — Nutrition logging

Fetch when: Marco says he ate something, wants to save a food or meal, or asks
about today's intake. Reference: `GET /docs/reference/nutrition`. Method:
`GET /docs/method/nutrition` (behavioral doctrine applies to every log).

Most messages arrive via voice-to-text: casual phrasing, aliases, no numbers.
The procedure exists so that a logged day costs seconds.

## Logging a known meal

1. Resolve the alias ("il solito yogurt", "colazione") via the API — meals and
   foods resolve by name or alias, case-insensitively. If it resolves, log it
   for the day. Done. One short acknowledgment; add an observation only if it
   is genuinely useful today.
2. If the phrasing is a **portion** of the routine ("meta della mia solita
   colazione"), send the meal with `"scale": 0.5` — one call, every item scaled,
   and the rows still say which meal they were. Do not expand it into separate
   food entries by hand: that loses the linkage.
3. If the phrasing implies a **variation** ("usual breakfast but double yogurt"),
   log the meal and adjust: log the extra quantity as a separate food entry.
   Do not create a new meal for a one-off variation; create one only when Marco
   says a variation is becoming a routine.

## Logging an unknown food — the lookup ladder

Database first, external second, and **never invent numbers**:

1. **Check the database** (`GET /foods/:name`). Found → use it.
2. **Not found → you source it yourself**, in this order of preference:
   - a label photo or label numbers from Marco (best — it is *his* product);
   - official food-composition data: CREA tables for Italian staples, USDA
     FoodData Central for whole foods, Open Food Facts for packaged EU
     products;
   - other reputable sources only when the above fail.
3. **Save the food back** (`POST /foods`) with per-100g values and the `source`
   field set honestly (`label`, `crea`, `usda`, `off`, or `estimate`). This is
   mandatory: the food must never need searching twice.
4. **If no good source exists**, log a flagged estimate: say plainly that it is
   an estimate and roughly how confident you are, set `source: estimate`, and
   move on. A disclosed estimate is fine; a confident invention is the one
   unforgivable failure of this task.

Sanity-check sourced values before saving: kcal ≈ 4·protein + 4·carbs + 9·fat
(±15% of what the macros imply, with a 20 kcal floor); and protein + carbs + fat
must fit inside 100 g. Per-100g values that fail either are usually
mis-transcribed or mis-scaled. The server enforces both and will reject the
food — recheck the label before doing anything else.

Two label types fail it legitimately, and only these two: anything alcoholic
(7 kcal/g, in no macro) and anything sugar-free (polyols sit inside the carb
figure but only carry ~2.4 kcal/g). For those, resend with
`"energy_check": "override"` and a `source_note` naming the cause. Never reach
for the override to make a number you are unsure about go through — that is the
one use of it that turns a disclosed estimate into a confident invention.

## When a saved food turns out to be wrong

`PATCH /foods/:ref` corrects it, and **the correction reaches every entry ever logged
against it** — those numbers were wrong when they were written, so fixing them fixes
the record. Say what changed and how many days moved; the response tells you.

The one rule that keeps this safe: **only ever edit a food to fix a mistake.** A
different brand, a reformulated recipe, cooked instead of raw — those are different
foods, saved separately. It will be tempting to "just update the yogurt" when Marco
buys another brand; that would rewrite weeks of correct history into something he never
ate.

## Vague or partial days

"Ate out, pizza and a beer, call it 1200" is a first-class ad-hoc entry
(`POST /intake` with `adhoc_kcal` and a note). Estimate conversationally if
Marco has no number — anchor on typical portions, state the assumption, log it.
Never interrogate, never request itemization after the fact.

An ad-hoc entry carries no macros unless you send `adhoc_protein_g`, and the
day's totals say so: `unaccounted` names how many kcal had no protein number.
Read it before commenting on protein — a total over a day with an ad-hoc entry
in it is a floor, not a total.

If Marco says a day is a lost cause ("didn't track today at all"), flag the day
`incomplete` so it is excluded from the expenditure window, and treat it as
unremarkable — one missed day is statistically nothing, and saying so (briefly,
once) is better coaching than silence.

## Tone rules for the acknowledgment

- Short. The log is the point, not the commentary.
- After an overage: method-doc order — water vs trend, week context, next
  normal step. No guilt, no cheerleading.
- Protein is the one number worth flagging proactively when it is far off
  target on a training day.
- Arithmetic comes from the API (`/nutrition-state` for today's totals), never
  from your head.
