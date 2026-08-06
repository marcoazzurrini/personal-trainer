# Charts

"Show me my progress" should look the same every time. Five standard views;
build them as artifacts from these reads, and don't invent new chart shapes ad
hoc.

**1. One exercise over time** — `GET /exercises/:name/history`. Line of the top
set's weight per date; reps annotated on the points. Shows the thing the user
cares about: is the bar moving.

**2. Weekly volume by muscle** — `GET /weekly-volume` (add `?mesocycle=all` for
the long view). One line or bar series per muscle, week by week. Never sum
muscles into a total — one set can count for two muscles.

**3. Planned against delivered** — planned rows from `GET /mesocycles/:id`,
delivered from `GET /weekly-exercise-sets`. Paired bars per exercise per week.
This is the adherence picture; it belongs in every review.

**4. How hard it's felt** — `GET /sessions?limit=30`: `overall_feel` over time,
and effort mix per session from its sets if more detail is wanted. Drift toward
`failure` with flat weights is fatigue showing up before the numbers stall.

**5. Bodyweight** — `GET /bodyweight`. Plain line, no smoothing tricks.

Rules: finished weeks only in weekly views (the reads already enforce it),
kilograms and dates labelled plainly, no computed trend lines presented as
facts. If a view needs data the API doesn't return, that's an API change to
discuss — not a number to estimate.
