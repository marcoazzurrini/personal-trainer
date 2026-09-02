-- Which plan a set belongs to has lived on the set since plans could run
-- side by side — but weekly_volume never carried it, so the route's
-- ?mesocycle=<id> filter could only cut by date range. With two overlapping
-- plans, each plan's read swept in the other's strength sets, and off-plan
-- work bled into every plan whose dates covered it — while the response
-- echoed a mesocycle_id as if the rows were attributed. The view now says
-- whose set it summed; the route filters on that instead of on the calendar.
--
-- Dropped and recreated rather than replaced: the group-by gains a column,
-- which changes what a row means, and pretending otherwise with a bare
-- replace would be the quiet kind of change this schema avoids.

drop view weekly_volume;

create view weekly_volume
  with (security_invoker = on) as
select
  date_trunc('week', s.date)::date as week_start,
  m.name as muscle,
  sum(em.volume_factor)::float8 as working_sets,
  t.mesocycle_id
from sets t
join sessions s on s.id = t.session_id
join exercises e on e.id = t.exercise_id
join exercise_muscles em on em.exercise_id = e.id and em.volume_factor > 0
join muscles m on m.id = em.muscle_id
where t.kind = 'working'
  and set_performed(t.reps, t.distance_m, t.duration_s)
  and e.stimulus_type = 'strength'
  and date_trunc('week', s.date)
    < date_trunc('week', now() at time zone 'Europe/Rome')
group by 1, 2, 4;
