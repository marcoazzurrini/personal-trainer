-- Rep ranges leave the schema. Nothing computes over them — their only
-- reader is the coach, and the coach reads prose. As structured columns they
-- quietly prescribed a methodology (ranges and double progression) that
-- belongs in the coaching docs and in this mesocycle's own prose.
--
-- Where the information now lives:
--   - the methodology and this mesocycle's rep intentions: mesocycles.intent
--   - per-exercise specifics ("5-8, add 2.5 kg at the top"): mesocycle_exercises.notes

alter table mesocycle_exercises drop column rep_low;
alter table mesocycle_exercises drop column rep_high;

-- intent's widened mandate, recorded where the schema is read.
comment on column mesocycles.intent is
  'Purpose and approach, in prose: what this mesocycle is for, the methodology chosen, how progression is meant to run, and what would trigger a rethink. Written at creation as the founding statement. Never restates a number held in a table.';
