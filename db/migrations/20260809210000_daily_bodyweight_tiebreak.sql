-- daily_bodyweight picks each day's earliest instant, but its tiebreak stopped
-- at measured_at — and the unique key is (measured_at, source), so two sources
-- reporting the same instant are both legal rows. Between equal instants the
-- winner was whatever the planner felt like, and that value seeds the day,
-- which seeds the EMA, which seeds the calorie target: a nondeterministic read
-- at the very bottom of the trend. Adding id makes the first-recorded row win,
-- every time, on every plan.

create or replace view daily_bodyweight
  with (security_invoker = on) as
select distinct on (day)
  (measured_at at time zone 'Europe/Rome')::date as day,
  value_kg::float8 as value_kg,
  measured_at
from bodyweight
order by day, measured_at, id;
