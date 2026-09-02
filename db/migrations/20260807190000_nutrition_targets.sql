-- Nutrition, phase 2: the goal and the things that disturb reading it.
--
-- Phase 1 recorded what was eaten. This adds what it is being eaten *for* —
-- and the register of events that make the bodyweight trend lie for a week or
-- two, so the expenditure back-solve can be told to discount them.
--
-- Nothing here stores a computed number that a query could derive. Trend
-- weight, the expenditure estimate and its confidence band are computed at
-- read time from bodyweight and intake, every time. kcal_target is the one
-- number that looks computed and is not: it is what Marco was *told to eat*
-- from that day forward, a decision that must not change retroactively when
-- the estimate underneath it moves.

-- ---------------------------------------------------------------------------
-- Targets
-- ---------------------------------------------------------------------------

-- Append-only, like mesocycle decisions: the latest effective_from is the
-- active target and the rest is the record of the phase structure. A target
-- is never edited — a changed mind is a new row saying why.
--
-- The goal is a RATE, not a weight and not a calorie number. Bodyweight goals
-- ("get to 78 kg") set no schedule and give the coach nothing to steer with;
-- a rate does both, and it is the form the evidence is expressed in.
create table nutrition_targets (
  id bigint generated always as identity primary key,
  effective_from date not null,
  goal text not null,
  -- Signed: negative cuts, positive gains, zero maintains. Percent of
  -- bodyweight per week.
  rate_pct_bw_week numeric(4, 2) not null,
  kcal_target integer not null,
  protein_g_target integer not null,
  -- Why this target, now. Required, like a mesocycle revision's decision:
  -- there is no way to change what Marco eats without saying why.
  decision text not null,
  -- What the server computed the target from, kept so a later reader can see
  -- whether the estimate or the goal moved. Null when the caller supplied an
  -- explicit kcal_target instead of asking for one.
  tdee_at_creation integer,
  clipped boolean not null default false,
  -- Which guard fired, so the history says why Marco got a different target
  -- than was asked for. 'rate' = past 0.7%/week; 'deficit' = past 500 kcal/day.
  clipped_reason text,
  constraint nutrition_targets_clipped_reason_check
    check (clipped_reason is null or clipped_reason in ('rate', 'deficit')),
  constraint nutrition_targets_clipped_pair
    check (clipped = (clipped_reason is not null)),
  request_id uuid,
  created_at timestamptz not null default now(),
  constraint nutrition_targets_goal_check
    check (goal in ('cut', 'maintain', 'gain', 'recomp')),
  constraint nutrition_targets_kcal_positive check (kcal_target > 0),
  constraint nutrition_targets_protein_positive check (protein_g_target > 0),
  -- Wider than any defensible target, on purpose: the guard against a bad
  -- rate lives in the API, where it can explain itself. This one only stops
  -- a decimal-point catastrophe reaching the table.
  constraint nutrition_targets_rate_sane
    check (rate_pct_bw_week > -3 and rate_pct_bw_week < 3),
  constraint nutrition_targets_request_id_key unique (request_id)
);

-- Deliberately no unique on effective_from. Two targets can share a day —
-- setting one and revising it an hour later is an ordinary thing to do — and
-- the later row simply wins, exactly as the latest row per topic wins in
-- user_context. Forbidding it would push the coach into editing a target in
-- place, which is the one thing an append-only log must not allow: the
-- superseded row and its reasoning are the record of what was decided and
-- when.

create index nutrition_targets_effective_from_idx
  on nutrition_targets (effective_from desc);

comment on column nutrition_targets.rate_pct_bw_week is
  'Signed percent of bodyweight per week: negative cuts, positive gains, 0 maintains. Cutting default -0.5, never past -0.7 (faster costs lean mass in trained people); gaining +0.25 to +0.5; recomp ~0.';

comment on column nutrition_targets.clipped is
  'True when the requested rate implied a deficit past 500 kcal/day and the server clipped it. The coach explains the clip to Marco rather than silently delivering a different target than was asked for.';

comment on column nutrition_targets.kcal_target is
  'What Marco was told to eat from effective_from onward. Stored, not derived: the expenditure estimate underneath it moves every day, and a target that silently moved with it would make adherence unmeasurable and the decision log meaningless.';

-- ---------------------------------------------------------------------------
-- Events: the transients that make the trend lie
-- ---------------------------------------------------------------------------

-- The hard part of a back-solve is that bodyweight is not only fat and muscle.
-- Switching from a deficit to maintenance refills glycogen and adds 1–2 kg of
-- water inside days; creatine adds ~1–2 kg of intracellular water over a week;
-- a new program adds glycogen and inflammatory water. Each of those fakes a
-- change in expenditure that never happened — and at fixed intake, faster
-- apparent gain implies *lower* expenditure, so the estimate moves the
-- opposite way from intuition.
--
-- Registering the event lets the algorithm damp its updates through the
-- window instead of chasing water.
create table nutrition_events (
  id bigint generated always as identity primary key,
  day date not null,
  kind text not null,
  note text,
  request_id uuid,
  created_at timestamptz not null default now(),
  constraint nutrition_events_kind_check
    check (kind in ('creatine_start', 'phase_switch', 'program_change',
                    'logging_change', 'other')),
  constraint nutrition_events_request_id_key unique (request_id)
);

create index nutrition_events_day_idx on nutrition_events (day desc);

comment on table nutrition_events is
  'Transients that corrupt a naive expenditure back-solve. The algorithm damps updates for roughly two weeks after one; the coach explains the scale movement before it happens rather than after.';

alter table nutrition_targets enable row level security;
alter table nutrition_events enable row level security;
