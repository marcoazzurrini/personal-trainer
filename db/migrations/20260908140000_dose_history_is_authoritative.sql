-- ADR-0013: membership and dose are separate facts. Keep membership rows and
-- every historical dose; remove only the duplicate current dose columns.
-- The runner applies this file and its receipt in one transaction.
lock table mesocycle_exercises, mesocycle_exercise_doses in access exclusive mode;

-- 20260809240000 already backfilled then-current doses at each plan's start.
-- That lossy legacy baseline cannot tell us earlier doses or change dates.
-- Do not replay that backfill, replace history, or invent a reconciliation
-- event. Refuse a missing/mismatched history instead of dropping known data.
do $$
begin
  if exists (
    select 1
    from mesocycle_exercises me
    join mesocycles m on m.id = me.mesocycle_id
    left join lateral (
      select weekly_dose, weekly_dose_unit
      from mesocycle_exercise_doses d
      where d.mesocycle_id = me.mesocycle_id
        and d.exercise_id = me.exercise_id
        and d.effective_from <= greatest(
          (now() at time zone 'Europe/Rome')::date, m.started_on)
      order by d.effective_from desc, d.id desc
      limit 1
    ) d on true
    where d.weekly_dose is distinct from me.weekly_dose
       or d.weekly_dose_unit is distinct from me.weekly_dose_unit
  ) then
    raise exception 'Dose history is missing or disagrees with a current plan dose. Reconcile from recorded evidence before retrying; this migration will not invent doses or dates.';
  end if;
end $$;

-- Transfer the existing checks with their names intact: errors.ts maps these
-- names to the public refusal messages. Validate all history, including rows
-- for removed exercises, before dropping the old checked columns.
alter table mesocycle_exercise_doses
  add constraint mesocycle_exercises_weekly_dose_positive
    check (weekly_dose > 0),
  add constraint mesocycle_exercises_weekly_dose_unit_check
    check (weekly_dose_unit in ('sets', 'minutes', 'km'));

alter table mesocycle_exercises
  drop column weekly_dose,
  drop column weekly_dose_unit;

comment on table mesocycle_exercise_doses is
  'The authoritative weekly dose history. Current plan reads use the latest applicable effective_from, then id; past weeks use their last day. Membership lives independently on mesocycle_exercises, so removal never deletes doses.';
