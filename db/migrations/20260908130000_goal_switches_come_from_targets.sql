-- A target is the saved eating plan; its effective-dated goal changes are
-- arithmetic over that history, not a second log to maintain on every write.
-- Dismissal is bookkeeping only: the saved plan and decision remain unchanged.
alter table nutrition_targets
  add column phase_switch_suppressed boolean not null default false;

comment on column nutrition_targets.phase_switch_suppressed is
  'Explicit dismissal of the automatic transient for this target. Does not alter the eating plan or suppress a later replacement target.';

-- Choose the same winner as activeTarget before comparing adjacent dates.
-- Comparing all appended rows would invent switches between same-day revisions
-- that never governed separate days. Filtering by a reader window must happen
-- outside this view, after lag has seen the full history.
create view nutrition_goal_switches with (security_invoker = on) as
with effective_targets as (
  select distinct on (effective_from)
    id, effective_from, goal, created_at, phase_switch_suppressed
  from nutrition_targets
  order by effective_from, id desc
), transitions as (
  select *, lag(goal) over (order by effective_from) as previous_goal
  from effective_targets
)
select -id as id, effective_from as day, 'phase_switch'::text as kind,
  previous_goal || ' -> ' || goal as note, created_at
from transitions
where previous_goal is not null and previous_goal <> goal
  and not phase_switch_suppressed;

-- Existing events have no reliable automatic/manual provenance. Keep every
-- row, id and request_id rather than guessing from a null request_id or note.
-- Legacy recorded switches may overlap derived ones; either can be withdrawn
-- independently. No historical row is deleted or silently reclassified.
create view nutrition_effective_events with (security_invoker = on) as
select id, day, kind, note, created_at from nutrition_events
union all
select id, day, kind, note, created_at from nutrition_goal_switches;

comment on view nutrition_effective_events is
  'Recorded transients plus unsuppressed goal changes between effective eating plans. Positive ids name recorded events; negative ids name the target that starts an automatic switch. All event readers use this view.';
