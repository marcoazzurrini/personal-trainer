-- The plan's numbers leave the tables. Weekly doses, load goals and
-- progression parameters live in mesocycles.intent — the single source of
-- the plan. The database keeps the plan's nouns (mesocycle_exercises) and
-- everything that has happened.
--
-- Why: the weekly grain of mesocycle_weekly_exercise_sets existed to express
-- ramped volume, which the only methodology in the system rejects; load-target
-- baselines are reconstructible from the first sessions' history; and by the
-- house criterion SQL holds what happened and what is fixed — doses and goals
-- are the coach's forecasts.

drop table mesocycle_weekly_exercise_sets;
drop table mesocycle_load_targets;

-- A revision that replaces the intent snapshots the text it replaced here.
-- History must never be lost, and prose belongs in a column, not in a
-- convention buried in what_changed.
alter table mesocycle_decisions add column prior_intent text;
comment on column mesocycle_decisions.prior_intent is
  'The full intent text this decision''s revision replaced; null when the revision did not touch the intent.';

comment on column mesocycles.intent is
  'The plan itself, in prose: goal, method and why it fits, weekly dose per exercise as numbers, load goals on the main lifts, the progression mechanism with its parameters, and what would trigger a rethink. The single source of the plan''s numbers — no table restates them.';
