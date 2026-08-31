-- ---------------------------------------------------------------------------
-- One definition of what a day of eating came to
-- ---------------------------------------------------------------------------
-- "A day's intake" was computed in three places, each grouping intake_entries
-- itself and each asking day_flags its own question. Three copies of one idea
-- is how they came to disagree: the weekly means excluded flagged days from
-- mean_kcal and not from mean_protein_g, eight lines apart, with no comment
-- claiming it was meant. #27 made the two agree. It could not stop a fourth
-- copy appearing, because nothing owned the definition.
--
-- This does. The sites keep reading it in the shape each needs — a set of
-- excluded days for the back-solve, a reported boolean for the fourteen-day
-- display, a filter for the weekly means — but they no longer each decide what
-- a day came to.
--
-- Days come from both tables, not just from intake_entries. A day can carry a
-- flag having logged nothing, and the fourteen-day display reports that day as
-- incomplete today; grouping intake_entries alone would drop it and quietly
-- turn that report false.
--
-- No coalesce on the sums. A day with no entries reports null, not 0, because
-- unknown is not zero and a floor of zeros under an average reads as fasting.
-- `entries` counts instead, and is 0 there — a caller can tell "nothing eaten"
-- from "nothing known" without either number lying. This is the same rule
-- sumMacros applies inside a single day.
--
-- kcal, protein_g and entries are what the readers need; carbs, fat and fiber
-- are not here because nothing rolls them up by day. A day's full macro totals
-- are a different and richer question — sumMacros reports which entries left
-- each macro unaccounted for, which no sum can express — and GET /intake
-- answers it from the entries themselves.
--
-- security_invoker: without it the view runs as its owner and would leak
-- through PostgREST past the RLS on the tables underneath.

create view daily_intake
  with (security_invoker = on) as
select
  d.day,
  sum(i.kcal)::float8 as kcal,
  sum(i.protein_g)::float8 as protein_g,
  count(i.id)::int as entries,
  exists (
    select 1 from day_flags f
    where f.day = d.day and f.flag = 'incomplete'
  ) as incomplete
from (
  select day from intake_entries
  union
  select day from day_flags
) d
left join intake_entries i on i.day = d.day
group by d.day;
