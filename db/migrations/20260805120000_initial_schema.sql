-- Initial schema. Design: docs/design-brief.md §7.
--
-- Conventions (decided in the brief):
--   - Primary keys are bigint generated always as identity.
--   - Small fixed lists are CHECK constraints, not enums.
--   - No ON DELETE CASCADE anywhere: a wrong delete must fail loudly,
--     and deleting plan rows must never be able to touch training history.
--   - date for calendar dates, timestamptz for instants.
--   - Nothing computed is ever stored; the two views compute at read time.
--
-- Engineering conventions (this file):
--   - Every column is NOT NULL unless the design gives null a meaning.
--   - Every foreign key column is covered by an index (Postgres does not
--     index FK columns automatically).
--   - Constraints that an API error will quote are named, so the message
--     can say what rule was broken.
--   - Weights are numeric kilograms; numeric, not float, so 2.5 stays 2.5.
--   - RLS is enabled on every table with no policies. The coach API connects
--     as postgres and is unaffected; the point is that Supabase's
--     auto-generated REST API (anon key) can neither read nor write anything.

-- ---------------------------------------------------------------------------
-- The athlete
-- ---------------------------------------------------------------------------

create table users (
  id bigint generated always as identity primary key,
  name text not null,
  height_cm numeric(4, 1)
);

-- Append-only. Never update or delete: correcting a fact means writing a new
-- row on the same topic. Current context = latest row per topic.
create table user_context (
  id bigint generated always as identity primary key,
  topic text not null,
  content text not null,
  written_at timestamptz not null default now()
);

create index user_context_topic_written_at_idx
  on user_context (topic, written_at desc);

create table bodyweight (
  id bigint generated always as identity primary key,
  value_kg numeric(5, 2) not null,
  measured_at timestamptz not null,
  source text not null default 'manual',
  constraint bodyweight_value_positive check (value_kg > 0),
  -- Natural key: a retried write bounces instead of planting a phantom point.
  constraint bodyweight_measured_at_source_key unique (measured_at, source)
);

-- ---------------------------------------------------------------------------
-- Reference data
-- ---------------------------------------------------------------------------

create table muscles (
  id bigint generated always as identity primary key,
  name text not null,
  constraint muscles_name_key unique (name)
);

create table exercises (
  id bigint generated always as identity primary key,
  name text not null,
  equipment text,
  pattern text, -- descriptive only, nothing depends on it
  stimulus_type text not null default 'strength',
  notes text,
  constraint exercises_stimulus_type_check
    check (stimulus_type in ('strength', 'power', 'conditioning'))
);

-- Case-insensitive: "Back Squat" and "back squat" are the same exercise.
create unique index exercises_name_key on exercises (lower(name));

create table exercise_aliases (
  id bigint generated always as identity primary key,
  exercise_id bigint not null references exercises,
  alias text not null
);

-- Case-insensitive: load-bearing for server-side name resolution.
create unique index exercise_aliases_alias_key on exercise_aliases (lower(alias));
create index exercise_aliases_exercise_id_idx on exercise_aliases (exercise_id);

create table exercise_muscles (
  id bigint generated always as identity primary key,
  exercise_id bigint not null references exercises,
  muscle_id bigint not null references muscles,
  counts boolean not null, -- 1 or 0, never a fraction: near failure or not
  fatigue text not null,
  constraint exercise_muscles_fatigue_check
    check (fatigue in ('none', 'some', 'lots')),
  constraint exercise_muscles_exercise_muscle_key unique (exercise_id, muscle_id)
);

create index exercise_muscles_muscle_id_idx on exercise_muscles (muscle_id);

-- ---------------------------------------------------------------------------
-- The plan
-- ---------------------------------------------------------------------------

create table blocks (
  id bigint generated always as identity primary key,
  name text not null,
  goal text not null,
  started_on date not null,
  ended_on date,
  constraint blocks_dates_ordered
    check (ended_on is null or ended_on >= started_on)
);

create table mesocycles (
  id bigint generated always as identity primary key,
  block_id bigint not null references blocks,
  name text not null,
  intent text not null, -- prose: purpose, never arithmetic
  planned_weeks integer not null,
  sessions_per_week integer not null,
  started_on date not null,
  ended_on date, -- null = active; earlier than planned = cut short, why is in decisions
  request_id uuid,
  constraint mesocycles_planned_weeks_positive check (planned_weeks > 0),
  constraint mesocycles_sessions_per_week_positive check (sessions_per_week > 0),
  -- Mesocycles start on a Monday (ISO dow 1) and run whole weeks.
  constraint mesocycles_starts_on_monday
    check (extract(isodow from started_on) = 1),
  constraint mesocycles_dates_ordered
    check (ended_on is null or ended_on >= started_on),
  constraint mesocycles_request_id_key unique (request_id)
);

create index mesocycles_block_id_idx on mesocycles (block_id);

-- "Only one active mesocycle" is a database guarantee, not a convention.
create unique index mesocycles_one_active
  on mesocycles ((true))
  where ended_on is null;

create table mesocycle_exercises (
  id bigint generated always as identity primary key,
  mesocycle_id bigint not null references mesocycles,
  exercise_id bigint not null references exercises,
  role text not null,
  priority integer not null, -- lower goes earlier in the week
  rep_low integer,
  rep_high integer,
  notes text,
  constraint mesocycle_exercises_role_check
    check (role in ('main', 'accessory')),
  constraint mesocycle_exercises_mesocycle_exercise_key
    unique (mesocycle_id, exercise_id),
  -- A rep range is a pair: both bounds or neither.
  constraint mesocycle_exercises_rep_range_pair
    check ((rep_low is null) = (rep_high is null)),
  constraint mesocycle_exercises_rep_range_ordered
    check (rep_low is null or (rep_low > 0 and rep_low <= rep_high))
);

create index mesocycle_exercises_exercise_id_idx
  on mesocycle_exercises (exercise_id);

-- One row per exercise per week; this table carries the whole progression.
create table mesocycle_weekly_exercise_sets (
  id bigint generated always as identity primary key,
  mesocycle_exercise_id bigint not null references mesocycle_exercises,
  week integer not null,
  sets integer not null,
  constraint mesocycle_weekly_exercise_sets_week_positive check (week > 0),
  -- 0 is allowed: an exercise can rest a week without leaving the plan.
  constraint mesocycle_weekly_exercise_sets_sets_not_negative check (sets >= 0),
  constraint mesocycle_weekly_exercise_sets_exercise_week_key
    unique (mesocycle_exercise_id, week)
);

create table mesocycle_load_targets (
  id bigint generated always as identity primary key,
  mesocycle_exercise_id bigint not null references mesocycle_exercises,
  target_weight_kg numeric(6, 2) not null,
  target_reps integer not null,
  -- Baseline: where you were when the mesocycle started. Written once,
  -- because it isn't cleanly derivable. Nullable pair: a lift new to the
  -- athlete has no baseline yet.
  baseline_weight_kg numeric(6, 2),
  baseline_reps integer,
  by_week integer,
  constraint mesocycle_load_targets_target_weight_not_negative
    check (target_weight_kg >= 0),
  constraint mesocycle_load_targets_target_reps_positive check (target_reps > 0),
  constraint mesocycle_load_targets_baseline_pair
    check ((baseline_weight_kg is null) = (baseline_reps is null)),
  constraint mesocycle_load_targets_baseline_reps_positive
    check (baseline_reps is null or baseline_reps > 0),
  constraint mesocycle_load_targets_by_week_positive
    check (by_week is null or by_week > 0),
  -- One load target per exercise per mesocycle.
  constraint mesocycle_load_targets_exercise_key unique (mesocycle_exercise_id)
);

-- Append only.
create table mesocycle_decisions (
  id bigint generated always as identity primary key,
  mesocycle_id bigint not null references mesocycles,
  made_at timestamptz not null default now(),
  what_changed text not null,
  why text not null
);

create index mesocycle_decisions_mesocycle_id_idx
  on mesocycle_decisions (mesocycle_id);

-- ---------------------------------------------------------------------------
-- The training record
-- ---------------------------------------------------------------------------

create table sessions (
  id bigint generated always as identity primary key,
  public_id text not null, -- unguessable, used in the log page URL
  mesocycle_id bigint not null references mesocycles,
  date date not null,
  type text not null default 'lift', -- free text on purpose: 'run' later needs no migration
  rationale text not null, -- why the session looks like this; written every time
  notes text,
  overall_feel text,
  started_at timestamptz,
  completed_at timestamptz,
  request_id uuid,
  constraint sessions_public_id_key unique (public_id),
  constraint sessions_request_id_key unique (request_id),
  constraint sessions_times_ordered
    check (started_at is null or completed_at is null or completed_at >= started_at)
);

create index sessions_date_idx on sessions (date);
create index sessions_mesocycle_id_idx on sessions (mesocycle_id);

-- Rows are created when the session is generated: targets filled, actuals
-- null. Logging fills actuals in. A planned row with null actuals is the
-- record of work planned and not done — never delete it. A retro-logged set
-- is the mirror image: actuals filled, targets null.
create table sets (
  id bigint generated always as identity primary key,
  session_id bigint not null references sessions,
  exercise_id bigint not null references exercises,
  position integer not null, -- order within the session
  kind text not null,
  target_weight_kg numeric(6, 2),
  target_reps integer,
  weight_kg numeric(6, 2), -- null = not done; 0 = a real unloaded set
  reps integer,
  effort text,
  performed_at timestamptz, -- gives rest times for free
  notes text,
  constraint sets_kind_check check (kind in ('warmup', 'working')),
  constraint sets_effort_check
    check (effort in ('easy', 'hard', 'failure')),
  constraint sets_position_positive check (position > 0),
  constraint sets_position_key unique (session_id, position),
  constraint sets_target_weight_not_negative
    check (target_weight_kg is null or target_weight_kg >= 0),
  constraint sets_target_reps_positive
    check (target_reps is null or target_reps > 0),
  constraint sets_weight_not_negative
    check (weight_kg is null or weight_kg >= 0),
  constraint sets_reps_positive check (reps is null or reps > 0),
  -- "Performed" is one fact, not two: weight and reps arrive together.
  constraint sets_actuals_pair check ((weight_kg is null) = (reps is null)),
  constraint sets_targets_pair
    check ((target_weight_kg is null) = (target_reps is null)),
  -- The effort rule, enforced at the source of truth: no path in can skip it.
  constraint sets_effort_required
    check (kind <> 'working' or weight_kg is null or effort is not null),
  -- Effort is information about working sets; warmups don't carry it.
  constraint sets_effort_working_only
    check (kind = 'working' or effort is null)
);

create index sets_session_id_idx on sets (session_id);
create index sets_exercise_id_performed_at_idx on sets (exercise_id, performed_at);

-- ---------------------------------------------------------------------------
-- Lock the auto-generated REST API
-- ---------------------------------------------------------------------------
-- RLS on, no policies: PostgREST (anon/authenticated) is denied everything.
-- The coach API connects as postgres, which bypasses RLS.

alter table users enable row level security;
alter table user_context enable row level security;
alter table bodyweight enable row level security;
alter table muscles enable row level security;
alter table exercises enable row level security;
alter table exercise_aliases enable row level security;
alter table exercise_muscles enable row level security;
alter table blocks enable row level security;
alter table mesocycles enable row level security;
alter table mesocycle_exercises enable row level security;
alter table mesocycle_weekly_exercise_sets enable row level security;
alter table mesocycle_load_targets enable row level security;
alter table mesocycle_decisions enable row level security;
alter table sessions enable row level security;
alter table sets enable row level security;

-- ---------------------------------------------------------------------------
-- Views: the two counting queries with real rules in them
-- ---------------------------------------------------------------------------
-- Shared rules: working sets only, performed only, strength stimulus only,
-- finished weeks only. A week is Monday–Sunday in Europe/Rome; sessions carry
-- a calendar date, so the only place the timezone matters is deciding which
-- week is the current (unfinished) one.
-- security_invoker: without it a view runs as its owner and would leak
-- through PostgREST past the RLS lock above.

-- Working sets per muscle per week. One row per muscle, never a total:
-- one set can count for two muscles, so totals only come from sets.
create view weekly_volume
  with (security_invoker = on) as
select
  date_trunc('week', s.date)::date as week_start,
  m.name as muscle,
  count(*)::integer as working_sets
from sets t
join sessions s on s.id = t.session_id
join exercises e on e.id = t.exercise_id
join exercise_muscles em on em.exercise_id = e.id and em.counts
join muscles m on m.id = em.muscle_id
where t.kind = 'working'
  and t.reps is not null
  and e.stimulus_type = 'strength'
  and date_trunc('week', s.date)
    < date_trunc('week', now() at time zone 'Europe/Rome')
group by 1, 2;

-- Delivered working sets per exercise per week of the mesocycle: the direct
-- comparison partner of mesocycle_weekly_exercise_sets. Week N is computed
-- from the mesocycle's Monday start, so it lines up with planned week N.
create view weekly_exercise_sets_done
  with (security_invoker = on) as
select
  s.mesocycle_id,
  t.exercise_id,
  ((s.date - mc.started_on) / 7) + 1 as week,
  count(*)::integer as sets_done
from sets t
join sessions s on s.id = t.session_id
join mesocycles mc on mc.id = s.mesocycle_id
join exercises e on e.id = t.exercise_id
where t.kind = 'working'
  and t.reps is not null
  and e.stimulus_type = 'strength'
  and date_trunc('week', s.date)
    < date_trunc('week', now() at time zone 'Europe/Rome')
group by 1, 2, 3;
