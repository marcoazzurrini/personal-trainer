-- The dose gets a history. mesocycle_exercises.weekly_dose is a flat number —
-- deliberately, it is "the current truth, not a trajectory" — but a redose
-- was a destructive UPDATE, so after one, /weekly-exercise-sets judged every
-- past week against the new dose and the only record of the old one was
-- prose in the decision log. Evaluation question 1 and the dose-vs-delivered
-- chart both need dose-as-of-week, and the chart rules forbid reconstructing
-- it by reading prose.
--
-- Append-only side table; the flat column stays as the fast path and nothing
-- that reads it changes. Keyed by (mesocycle_id, exercise_id) rather than by
-- mesocycle_exercises.id: a revision can remove an exercise from the plan,
-- and the history of what it was dosed at while it was in must survive that
-- removal — the work it delivered while it was in the plan already does.

create table mesocycle_exercise_doses (
  id bigint generated always as identity primary key,
  mesocycle_id bigint not null references mesocycles,
  exercise_id bigint not null references exercises,
  weekly_dose numeric(6, 1) not null,
  weekly_dose_unit text not null,
  -- The first Rome day this dose was in force. Creation writes started_on;
  -- a redose writes the day it was decided.
  effective_from date not null,
  created_at timestamptz not null default now()
);

create index mesocycle_exercise_doses_lookup_idx
  on mesocycle_exercise_doses (mesocycle_id, exercise_id, effective_from);

comment on table mesocycle_exercise_doses is
  'Append-only history of each plan exercise''s weekly dose. The current dose lives on mesocycle_exercises; this table exists so a mid-mesocycle redose cannot silently rewrite what past weeks were judged against.';

alter table mesocycle_exercise_doses enable row level security;

-- Backfill: every existing plan exercise's current dose, dated at the plan's
-- start. This is the one chance to give existing plans a history at all — a
-- plan that already redosed before this table existed keeps only its current
-- dose, dated to its start, which is the least wrong statement available.
insert into mesocycle_exercise_doses
  (mesocycle_id, exercise_id, weekly_dose, weekly_dose_unit, effective_from)
select me.mesocycle_id, me.exercise_id, me.weekly_dose, me.weekly_dose_unit,
  mc.started_on
from mesocycle_exercises me
join mesocycles mc on mc.id = me.mesocycle_id;
