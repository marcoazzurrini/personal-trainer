-- A request can trip more than one guard on its way to the target — the rate
-- ceiling first, then a kcal cap at a heavy enough bodyweight — and the row
-- recorded only the last one to fire. The history's job is to say why Marco
-- got a different target than was asked for, all of why. The column becomes
-- a list, empty when nothing bound, so clipped stays derivable from it.

alter table nutrition_targets
  drop constraint nutrition_targets_clipped_reason_check,
  drop constraint nutrition_targets_clipped_pair;

alter table nutrition_targets
  alter column clipped_reason drop default,
  alter column clipped_reason type text[]
    using case
      when clipped_reason is null then '{}'::text[]
      else array[clipped_reason]
    end,
  alter column clipped_reason set default '{}',
  alter column clipped_reason set not null;

alter table nutrition_targets
  rename column clipped_reason to clipped_reasons;

alter table nutrition_targets
  add constraint nutrition_targets_clipped_reasons_check
    check (
      clipped_reasons <@ array['rate', 'deficit', 'recomp_deficit', 'surplus']
    ),
  add constraint nutrition_targets_clipped_pair
    check (clipped = (cardinality(clipped_reasons) > 0));

comment on column nutrition_targets.clipped_reasons is
  'Every guard that fired, in the order the cascade runs them, so the history says why Marco got a different target than was asked for. rate = past 0.7%/week losing or 0.5%/week gaining; deficit = past 500 kcal/day; recomp_deficit = past 200 kcal/day on a recomp; surplus = past 350 kcal/day gaining. Empty when nothing bound.';
