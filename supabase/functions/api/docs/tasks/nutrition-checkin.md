# Task — Nutrition check-in (weekly) and target changes

Fetch when: it is check-in time (weekly, or Marco asks "how's the cut going",
"should we adjust", "set me up for a cut/bulk"). Reference:
`GET /docs/reference/nutrition`. Method: `GET /docs/method/nutrition` — the
target and rate ranges there are binding.

## Procedure

1. `GET /nutrition-state` and `GET /nutrition/weekly`. You need: trend weight
   and its slope, expenditure estimate + band + status, logging and weigh-in
   adherence for the window, the active target, active transients.
2. **Gate before touching the target.** Adjust only if ALL hold:
   - expenditure status is `ok` (not `stale`, `insufficient_data`, or `damped`);
   - the window has enough usable days (the API enforces its thresholds — read
     the status, don't second-guess it);
   - the gap between observed rate and desired rate is outside noise — as a
     rule, don't react to less than ~0.15%BW/week of divergence sustained for
     less than two finished weeks;
   - no phase switch or registered transient in the last ~10 days.
   If the gate fails: report state honestly, name what's missing or settling,
   change nothing. Holding is a decision too — say why.
3. If adjusting: request the server-computed target
   (`POST /nutrition-targets`, rate in, kcal out — the arithmetic is the
   server's). Send protein as a multiplier too, not a gram figure:
   `protein_g_per_kg_ffm` (2.3–3.1) in a deficit,`protein_g_per_kg_bw`
   (1.6–2.2) at maintenance or in surplus. The decision field is mandatory and
   must say *why now*: observed vs desired rate, expenditure movement,
   adherence context.
4. Explain to Marco in plain terms: what the trend did, what expenditure looks
   like (with the band — present it as a range, never a point), what the new
   target is and what it changes in practice (which meal absorbs the change).
   Keep the guards visible: a cut is clipped at −0.7%/week or a 500 kcal/day
   deficit, a gain at +0.5%/week or a 350 kcal/day surplus, a recomp at a
   200 kcal/day deficit — whichever binds first. The server clips and says
   which in `clipped_reasons` — every guard that bound, not just the last —
   and you explain why Marco got a different number
   than he asked for.

## Setting up a new goal phase

- Translate the goal into a rate per the method doc (cut −0.5%/wk default,
  gain +0.25–0.5%/wk ceiling, recomp maintenance to a 200 kcal/day deficit —
  all three enforced by the server's clips) and set protein for the phase
  (deficit → 2.3–3.1 g/kg FFM).
- Register the phase switch as a nutrition event so expenditure updates damp
  through the water/glycogen step; tell Marco the scale will jump and that it
  is glycogen, before it happens, not after.
- After a long cut, default to a maintenance phase, and when a cut passes
  6–12 weeks or diet-fatigue signals climb, offer a 1-week diet break — framed
  as an adherence tool, never as metabolic protection.

## Adherence review (part of every check-in)

- Read logging frequency over the last 2–3 weeks. A visible decline —
  especially by week 2–3 of a new phase — gets addressed now, lightly:
  reduce friction (more saved meals, coarser logging) before asking for more
  discipline. Intervene before any gap reaches two weeks.
- If logging lapsed but weighing continued, say the system still works and
  rebuild from the easiest meal.
- Around weeks 3–6 of a new habit and around week 10 of a phase, expect the
  dip; front-load encouragement there without being asked.
