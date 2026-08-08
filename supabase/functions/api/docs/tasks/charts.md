# Charts

"Show me my progress" should look the same every time. Standard views, built as artifacts
from these reads. Don't invent new chart shapes on the spot — a view that changes shape
between conversations can't be compared with the last one, which is most of what a chart
is for.

Training and nutrition share this document deliberately. The trigger is one phrase and
usually ambiguous, and the view that matters most during a cut spans both halves (view 9).
Build what was asked about; read the whole list before deciding what that was.

## Training

**1. One exercise over time** — `GET /exercises/:name/history`. The top set's weight per
date as a line, with reps annotated on the points. This is the view that answers the
question people actually mean: is the bar moving.

**2. Weekly volume by muscle** — `GET /weekly-volume` (`?mesocycle=all` for the long
view). One series per muscle, week by week. Never sum muscles into a total: one set can
count for two muscles, so the total means nothing. Worth stating once when showing it that
these are direct working sets only — indirect work isn't counted and the numbers read
lower than published figures for the same training.

**3. Dose against delivered** — the weekly dose per exercise from the current intent
(and the decision log's adjustments for backed-off lifts or declared light weeks),
delivered from `GET /weekly-exercise-sets`. Paired bars per exercise per week. This is the adherence
picture and it belongs in every review, because it decides whether any other chart can be
interpreted.

**4. How hard it's felt** — `GET /sessions?limit=30`: `overall_feel` over time, and the
effort mix per session from its sets when more detail helps. Two patterns are worth naming
when you see them: drift toward `failure` at flat weights is fatigue showing up before the
numbers stall, and a wall of `easy` means the loads are too light no matter what the other
charts show.

## Bodyweight — the number both halves read

**5. Bodyweight and its trend** — `GET /nutrition-state` for `trend_weight`, with the raw
series from `GET /bodyweight`. Plot **both**: raw as faint points, trend as the line that
carries the eye. Never the raw series alone — that is the number Marco misreads on a
Monday morning, and the whole point of the trend is that a 1.5 kg water swing is not
information. The trend is computed by the API (an EMA over the earliest weigh-in of each
day); do not compute your own.

## Nutrition

**6. Intake against target** — `GET /nutrition/weekly` for the weekly means, or
`GET /nutrition-state` `recent_days` for the daily view. Bars for logged kcal, a
horizontal line at the active target. Show `days_logged` alongside — a week averaging
2,100 kcal over three logged days is not a 2,100 kcal week, and presenting it as one is
the most likely way this chart lies.

**7. Expenditure over time** — `GET /nutrition/weekly` `implied_tdee_kcal` per week, with
the current estimate's band from `GET /nutrition-state` drawn **as a band, not a line**.
The band is the finding. A reader who sees a crisp line will chase week-to-week movement
that is noise by construction, which is exactly what the method document forbids. Weeks
where it is null stay empty — never interpolate across them.

**8. Logging adherence** — days logged per week from `GET /nutrition/weekly`, weigh-ins
beside them. The nutrition twin of view 3, and read first for the same reason: it decides
whether any other nutrition chart can be interpreted at all. A visible decline by week 2–3
is the signal the method document says to act on.

## Both halves at once

**9. Is the cut costing muscle?** — trend weight (view 5) against top-set strength on the
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
