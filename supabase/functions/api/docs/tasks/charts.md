# Charts

"Show me my progress" should look the same every time. Standard views, built as artifacts
from these reads. Don't invent new chart shapes on the spot — a view that changes shape
between conversations can't be compared with the last one, which is most of what a chart
is for.

Training and nutrition share this document deliberately. The trigger is one phrase and
usually ambiguous, and the view that matters most during a cut spans both halves (view 10).
Build what was asked about; read the whole list before deciding what that was.

## Training

**1. One exercise over time** — `GET /exercises/:name/history`. The top set's weight per
date as a line, with reps annotated on the points. This is the view that answers the
question people actually mean: is the bar moving.

**2. Weekly volume by muscle** — `GET /weekly-volume` (`?mesocycle=all` for the long
view). One series per muscle, week by week. Never sum muscles into a total: one set can
count for two muscles, so the total means nothing. Worth stating once when showing it
that sets are weighted by `volume_factor` — direct work counts 1.0, indirect 0.5 — so
the numbers read lower than published set counts for the same training. A per-plan read
is that plan's sets only; `?mesocycle=all` counts everything, off-plan lifting included.

**3. Dose against delivered** — `GET /weekly-exercise-sets`: every row carries the
delivered work and, beside it, the `dose`/`dose_unit` **in force during that week**, so
a mid-mesocycle redose shows each week against the number it was actually judged by.
Paired bars per exercise per week. This is the adherence picture and it belongs in
every review, because it decides whether any other chart can be interpreted.

The decision log still matters here, but for the *why*, not the numbers: a backed-off
lift or a declared light week is a chosen reduction, and the decision row is what says
so. `?mesocycle=all` is not available here the way it is on view 2 — these week numbers
count from the mesocycle's start, so weeks from different plans cannot share an axis.

**4. How hard it's felt** — `GET /sessions?limit=30`: the effort mix per session from
its sets (`easy` / `hard` / `failure` — the plottable series), with `overall_feel`
quoted as annotations where it says something. It is free text by design and has no
axis to sit on; the chips are what goes on the chart. Two patterns are worth naming
when you see them: drift toward `failure` at flat weights is fatigue showing up before
the numbers stall, and a wall of `easy` means the loads are too light no matter what
the other charts show.

## Bodyweight — the number both halves read

**5. Bodyweight and its trend** — `GET /bodyweight`, one call, two series: `bodyweight`
(the raw instants) and `trend` (one point per day; `interpolated` marks bridged one-day
gaps). Plot **both**: raw as faint points, trend as the line that carries the eye.
Never the raw series alone — that is the number Marco misreads on a Monday morning,
and the whole point of the trend is that a 1.5 kg water swing is not information. The
trend is computed by the API (an EMA over the earliest weigh-in of each day); do not
compute your own.

## Nutrition

**6. Rate of change against the rate he chose** — `GET /nutrition/weekly`:
`rate_pct_bw_week` per week against `target.rate_pct_bw_week`. Two lines, one axis.

This is the chart that answers whether the cut is working, and it is the first one to
build when a target is active. Everything else is diagnosis; this is the result. A gap
that persists across two finished weeks and sits outside ~0.15%/week is the signal the
check-in acts on — inside that, it is noise and reacting to it is how the loop gets
made worse. Weeks where the trend is missing a bookend weigh-in come back null and stay
empty; never join across a gap.

**7. Intake and protein against target** — `GET /nutrition/weekly` carries both what was
eaten (`mean_kcal`, `mean_protein_g`) and the target in force that week (`target.kcal`,
`target.protein_g`), so no reconstruction is needed. Bars for intake, a step line for the
target — a step, not a flat line, because the target changes between phases and drawing
it flat would hide exactly the moment worth looking at.

Two things this chart must show or it will lie. **`days_logged`**: a week averaging
2,100 kcal over three logged days is not a 2,100 kcal week. And
**`target.changed_during_week`**: where it is true, two targets governed the week and the
comparison is muddy — say so rather than drawing a clean bar against the later one.

Protein deserves its own panel rather than a second series on the calorie axis. It is
the one macro with a hard target, and it is the number that decides whether a deficit
costs muscle.

**8. Expenditure over time** — `GET /nutrition/weekly` `implied_tdee_kcal` per week, with
the current estimate's band from `GET /nutrition-state` drawn **as a band, not a line**.
The band is the finding. A reader who sees a crisp line will chase week-to-week movement
that is noise by construction, which is exactly what the method document forbids. Weeks
where it is null stay empty — never interpolate across them.

**9. Logging adherence** — days logged per week from `GET /nutrition/weekly`, weigh-ins
beside them. The nutrition twin of view 3, and read first for the same reason: it decides
whether any other nutrition chart can be interpreted at all. A visible decline by week 2–3
is the signal the method document says to act on.

## Both halves at once

**10. Is the cut costing muscle?** — trend weight (view 5) against top-set strength on the
main lifts (view 1) and weekly volume (view 2), over the same weeks. This is the question
the nutrition system exists to keep from being answered wrong, and no single-domain chart
answers it: weight falling with strength holding is the cut working, weight falling with
strength sliding is the deficit or the recovery being too aggressive. Build this whenever
a cut has been running more than a few weeks, asked for or not.

Rules:

- Finished weeks only in weekly views. The reads already enforce it; don't work around it.
- Kilograms and dates labelled plainly.
- No computed trend lines presented as facts. A regression through six noisy points is a
  drawing, not a finding. Trend weight is the exception and not a violation of this: the
  API computes it, it is a first-class value with a documented method, and it is the one
  the method document calls the only weight. Show what the API returns; never smooth
  anything yourself.
- Estimates are drawn as ranges. The expenditure band is not decoration and must never be
  flattened to a line to make a chart tidier.
- If a view needs data the API doesn't return, that's an API change to discuss — never a
  number to estimate.

A chart is not an answer. Say what it shows and what you make of it; the person asked how
it's going, not for a picture.
