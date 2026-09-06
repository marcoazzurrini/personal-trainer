-- Append coverage to the existing view without changing its day/flag or null
-- semantics. Applied migrations stay immutable; all readers share this view.
create or replace view daily_intake
  with (security_invoker = on) as
select
  d.day,
  sum(i.kcal)::float8 as kcal,
  sum(i.protein_g)::float8 as protein_g,
  count(i.id)::int as entries,
  exists (
    select 1 from day_flags f
    where f.day = d.day and f.flag = 'incomplete'
  ) as incomplete,
  count(i.protein_g)::int as protein_entries
from (
  select day from intake_entries
  union
  select day from day_flags
) d
left join intake_entries i on i.day = d.day
group by d.day;
