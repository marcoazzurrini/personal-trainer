-- The clip guards grew two reasons: the gain side gained the mirror of the
-- cut's pair (rate past +0.5%/week, surplus past 350 kcal/day), and recomp
-- gained the kcal clip that makes "maintenance to -200 kcal/day" enforceable
-- at any bodyweight. The check that pins clipped_reason to known values has
-- to learn them, or the route computes a clip the table then refuses.
--
-- rate_sane stays as it is: it is a decimal-catastrophe bound, not a guard,
-- and the requested rate is what this table stores — the clip changes what
-- is delivered, never what was asked.

alter table nutrition_targets
  drop constraint nutrition_targets_clipped_reason_check;
alter table nutrition_targets
  add constraint nutrition_targets_clipped_reason_check
    check (
      clipped_reason is null or
      clipped_reason in ('rate', 'deficit', 'recomp_deficit', 'surplus')
    );

comment on column nutrition_targets.clipped_reason is
  'Which guard fired, so the history says why Marco got a different target than was asked for. rate = past 0.7%/week losing or 0.5%/week gaining; deficit = past 500 kcal/day; recomp_deficit = past 200 kcal/day on a recomp; surplus = past 350 kcal/day gaining.';
