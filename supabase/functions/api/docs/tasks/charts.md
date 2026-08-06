# Charts

"Show me my progress" should look the same every time. Five standard views. Build them as
artifacts from these reads and don't invent new chart shapes on the spot — a view that
changes shape between conversations can't be compared with the last one, which is most of
what a chart is for.

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

**5. Bodyweight** — `GET /bodyweight`. Plain line, no smoothing tricks.

Rules:

- Finished weeks only in weekly views. The reads already enforce it; don't work around it.
- Kilograms and dates labelled plainly.
- No computed trend lines presented as facts. A regression through six noisy points is a
  drawing, not a finding.
- If a view needs data the API doesn't return, that's an API change to discuss — never a
  number to estimate.

A chart is not an answer. Say what it shows and what you make of it; the person asked how
it's going, not for a picture.
