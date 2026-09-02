-- More than one line of training at a time.
--
-- Until now the system could hold exactly one plan, and that plan could only
-- be hypertrophy: one active mesocycle, sets measured in kilograms and reps,
-- and a volume view that counts sets per muscle. Sprinting, running, and
-- powerlifting-style strength each need a plan of their own running at the
-- same time, and the first two need work units that are not reps.
--
-- Five changes, in dependency order:
--
--   1. Mesocycles carry a track, and one may be active per track. The track
--      is also the key that names the method document the coach must read.
--   2. Plan attribution moves from the session to the set. A session stops
--      being owned by a plan; each unit of work says which plan it serves.
--   3. Sets gain distance and duration, and the constraints that assumed
--      "a set is weight and reps" are rewritten around "a set carries at
--      least one measure".
--   4. The weekly dose becomes structured — the one number that leaves the
--      intent's prose, because the server must be able to compute behind and
--      ahead without a model re-reading a paragraph every session.
--   5. The week gets a schedule row: prose, one per week, the LLM's own note
--      to itself about the shape it proposed and Marco accepted.
--
-- Rehab is deliberately not a track. It is a role an exercise plays inside an
-- existing plan, so shoulder rehab lives in the hypertrophy mesocycle and
-- multiple rehab progressions are just multiple rehab-role exercises.
--
-- The database has no rows yet, so nothing here backfills and every new NOT
-- NULL column arrives without a default it would have to invent. If this
-- migration fails because rows exist, that is the failure working: the values
-- would have been guesses.

-- ---------------------------------------------------------------------------
-- 1. Tracks
-- ---------------------------------------------------------------------------

alter table mesocycles add column track text not null;

alter table mesocycles add constraint mesocycles_track_check
  check (track in ('hypertrophy', 'strength', 'speed', 'endurance'));

comment on column mesocycles.track is
  'The line of training this plan belongs to, and the key that names its method document (GET /api/docs/method/<track>). A CHECK rather than free text: a typo would create a phantom track, which would silently defeat the one-active-per-track guarantee below and route the coach to a document that does not exist.';

-- "Only one active mesocycle" becomes "only one active mesocycle per track".
-- Two hypertrophy plans at once is still incoherent; hypertrophy alongside
-- speed is the whole point of this migration.
drop index mesocycles_one_active;

create unique index mesocycles_one_active_per_track
  on mesocycles (track)
  where ended_on is null;

-- ---------------------------------------------------------------------------
-- 2. Rehab is a role
-- ---------------------------------------------------------------------------

alter table mesocycle_exercises drop constraint mesocycle_exercises_role_check;

alter table mesocycle_exercises add constraint mesocycle_exercises_role_check
  check (role in ('main', 'accessory', 'rehab'));

comment on column mesocycle_exercises.role is
  'main | accessory | rehab. rehab marks work that is in the plan to fix something rather than to drive the plan''s adaptation: it carries a weekly dose like anything else, but its progression rules come from the rehab guidance rather than the track''s method document.';

-- ---------------------------------------------------------------------------
-- 3. The weekly dose leaves the prose
-- ---------------------------------------------------------------------------
-- The single exception to "the intent holds the plan's numbers"
-- (20260806210000). Everything else in that migration stands: progression
-- mechanisms, load goals, deload rules and rep intentions stay prose, because
-- nothing computes over them and a model reading them is the point.
--
-- The dose is different because something does compute over it. Behind-and-
-- ahead is arithmetic performed at every session generation, and doing it by
-- re-extracting numbers from a paragraph makes a misread dose a quiet fact
-- instead of a loud error. One flat number per exercise — the current truth,
-- not a per-week trajectory; a changed dose is a revision with a decision,
-- exactly like every other plan change.

alter table mesocycle_exercises
  add column weekly_dose numeric(6, 1) not null,
  add column weekly_dose_unit text not null,
  -- 0 is not a dose. An exercise that should not be trained this week leaves
  -- the plan, or is backed off by a decision row that says for how long.
  add constraint mesocycle_exercises_weekly_dose_positive check (weekly_dose > 0),
  add constraint mesocycle_exercises_weekly_dose_unit_check
    check (weekly_dose_unit in ('sets', 'minutes', 'km'));

comment on column mesocycle_exercises.weekly_dose is
  'How much of this exercise the plan asks for each week, in weekly_dose_unit. Flat: the current truth, not a trajectory. The number delivery is judged against.';

comment on column mesocycle_exercises.weekly_dose_unit is
  'sets | minutes | km. Which unit is legal depends on how the exercise is measured, which a CHECK cannot see from here — the API rejects a km dose on a barbell squat and says why.';

-- ---------------------------------------------------------------------------
-- 4. What an exercise is measured in
-- ---------------------------------------------------------------------------

alter table exercises add column measure text not null default 'load_reps';

alter table exercises add constraint exercises_measure_check
  check (measure in ('load_reps', 'reps', 'distance', 'duration', 'distance_duration'));

comment on column exercises.measure is
  'What a set of this exercise records. load_reps = weight and reps (the barbell default). reps = reps alone (push-ups, jump contacts). distance = metres (broad jump). duration = seconds (plank, an easy run logged by time). distance_duration = both together (a sprint, an interval, a tempo run). A property of the exercise, never a per-set choice: a back squat is never measured in metres. It drives which inputs the log page renders, and the API validates a set''s fields against it.';

-- The catalogue predates this column, and the default is right for all but
-- three of it: the exercises that were never weight-and-reps. Left alone they
-- would be silently unloggable — a sprint would be asked for kilograms — and
-- the default makes that the quiet outcome rather than the loud one, so it is
-- corrected here. No-ops on an empty database, where the catalogue loader
-- supplies the measure at creation instead.
update exercises e
set measure = c.measure
from (values
  ('Sprint', 'distance_duration'),
  ('Box Jump', 'reps'),
  ('Broad Jump', 'distance')
) as c (name, measure)
where lower(e.name) = lower(c.name);

-- ---------------------------------------------------------------------------
-- 5. Sets gain measures, and the pair constraints are rewritten
-- ---------------------------------------------------------------------------
-- Targets and actuals keep their existing meaning exactly: a target is what
-- was asked before the work and is frozen, an actual is what happened.

alter table sets
  add column target_distance_m numeric(7, 1),
  add column distance_m numeric(7, 1),
  add column target_duration_s numeric(8, 2),
  add column duration_s numeric(8, 2),
  -- Two decimals on duration because a 40 m sprint is read to the hundredth
  -- of a second and rounding it away would erase the progression.
  add constraint sets_distance_positive
    check (distance_m is null or distance_m > 0),
  add constraint sets_target_distance_positive
    check (target_distance_m is null or target_distance_m > 0),
  add constraint sets_duration_positive
    check (duration_s is null or duration_s > 0),
  add constraint sets_target_duration_positive
    check (target_duration_s is null or target_duration_s > 0);

-- The old rule was a biconditional: weight and reps arrive together or not at
-- all. It cannot survive a sprint, which has neither, or a sled push, which
-- has weight and metres and no reps. The rule that generalises it: weight is
-- a modifier on a measurement, never a measurement itself. It may accompany
-- any measure, and it may never stand alone.
alter table sets drop constraint sets_actuals_pair;
alter table sets drop constraint sets_targets_pair;

alter table sets
  add constraint sets_weight_accompanies_a_measure
    check (
      weight_kg is null
      or reps is not null
      or distance_m is not null
      or duration_s is not null
    ),
  add constraint sets_target_weight_accompanies_a_measure
    check (
      target_weight_kg is null
      or target_reps is not null
      or target_distance_m is not null
      or target_duration_s is not null
    );

-- The effort rule leaves the database, because it can no longer be stated here.
--
-- It used to key off weight_kg: when every set was weight and reps, a non-null
-- weight was the same thing as a performed set. That reading breaks twice over
-- now. A push-up measured in reps alone has no weight, so the guarantee would
-- silently lapse on exactly the sets it exists to protect. And rep-counting is
-- not the right test either: a box jump counts contacts, but easy/hard/failure
-- is a proximity-to-failure vocabulary, and explosive work is neither taken to
-- failure nor judged by how near it came. A chip forced onto a jump set would
-- not merely be uninformative — 'easy' is documented as "too light, a
-- programming error", so a plyometric plan would emit that diagnosis forever.
--
-- The condition that is actually right is "a rep-counted working set of a
-- strength-stimulus exercise", and stimulus_type lives on exercises, which a
-- CHECK on sets cannot see. So this rule joins the other cross-table set rule —
-- which fields a set of an exercise may carry — in the API, where it can also
-- explain itself. sets_effort_working_only stays: that a warmup carries no
-- effort needs nothing but the row.
alter table sets drop constraint sets_effort_required;

-- ---------------------------------------------------------------------------
-- 6. "Was this set performed?", defined once
-- ---------------------------------------------------------------------------
-- The predicate used to be `reps is not null`, written out at eleven call
-- sites. Now that a set can be performed without reps, the expression has
-- three limbs and will grow a fourth the day something else is measurable —
-- so it gets one definition. A function, not a stored column: nothing
-- computed is ever stored, and this stores nothing.

create function set_performed(reps integer, distance_m numeric, duration_s numeric)
  returns boolean
  language sql
  immutable
  parallel safe
as $$
  select reps is not null or distance_m is not null or duration_s is not null
$$;

comment on function set_performed(integer, numeric, numeric) is
  'True when a set carries any actual measurement — the single definition of "this happened", used by every view and read that distinguishes planned work from delivered work. A planned row that was never done has targets and nothing else, and must stay that way: it is the record of work asked for and not delivered.';

-- Consistent with the RLS lock: PostgREST's anon and authenticated roles get
-- nothing, including a function they could otherwise call over /rpc. It leaks
-- nothing (it is a pure predicate over its arguments), but the surface stays
-- closed on purpose.
revoke execute on function set_performed(integer, numeric, numeric) from public;

-- ---------------------------------------------------------------------------
-- 7. Attribution moves from the session to the set
-- ---------------------------------------------------------------------------
-- A session that sprints and then squats serves two plans. Making it pick a
-- primary would be a fiction, and the per-exercise delivery view — which
-- reached the mesocycle through the session — would credit half the work to
-- the wrong plan. So the session stops being owned by a plan and becomes what
-- it always was, a training bout on a date, and each unit of work names the
-- plan it serves.
--
-- Not enforced, deliberately: that the set's exercise is in that mesocycle's
-- exercise list. It is true when the set is written, and a later revision that
-- drops the exercise must not be able to break history.

alter table sets add column mesocycle_id bigint references mesocycles;

create index sets_mesocycle_id_idx on sets (mesocycle_id);

comment on column sets.mesocycle_id is
  'The plan this work serves. Null = off-plan: incidental activity — a hike, a game of five-a-side — recorded as fact and measured against no dose. Resolved server-side when a set is written, never asked of the log page.';

-- The views read the session-level link, so they go first and are rebuilt at
-- the end of this file.
drop view weekly_volume;
drop view weekly_exercise_sets_done;

alter table sessions drop column mesocycle_id;

-- sessions.type was free text holding 'lift', kept against the day a run
-- needed recording. That day is here and the column has no job: what kind of
-- work a session held is read from its sets — their plan links and their
-- exercises' stimulus_type — and a second, hand-written answer to the same
-- question could only ever disagree with the first.
alter table sessions drop column type;

-- ---------------------------------------------------------------------------
-- 8. The week's shape
-- ---------------------------------------------------------------------------
-- One row per week, prose, whose only reader is the coach. At the first
-- session generation of a week it proposes a shape from the active plans'
-- doses, Marco accepts or edits it, and the accepted text is written here.
-- From then on it is the default answer to "what am I doing today" — a
-- default, never a contract. Deviating from it is always allowed and needs no
-- edit; the next week is written from scratch.
--
-- Deliberately shapeless: no day rows, no exercise links, no foreign keys.
-- Structure here would make it a template, and pre-planned sessions are the
-- thing this system has refused from the beginning.
--
-- No request_id, by the rule 20260808100000 set: the write upserts on
-- week_start, so a retry cannot duplicate and an id would be ceremony rather
-- than a guarantee. A second call with different text is not a duplicate —
-- it is Marco editing the week, which is the endpoint's whole purpose.

create table week_schedules (
  id bigint generated always as identity primary key,
  week_start date not null,
  schedule text not null,
  written_at timestamptz not null default now(),
  constraint week_schedules_week_start_key unique (week_start),
  -- Weeks are Monday–Sunday everywhere else in this schema; a Tuesday here
  -- would silently describe a different seven days than every read.
  constraint week_schedules_starts_on_monday
    check (extract(isodow from week_start) = 1)
);

comment on table week_schedules is
  'The shape of one week, in prose, as proposed by the coach and accepted by Marco. A default for session generation, not a plan: what actually happened is in sessions.';

alter table week_schedules enable row level security;

-- ---------------------------------------------------------------------------
-- 9. The views, rebuilt
-- ---------------------------------------------------------------------------

-- Unchanged in intent: fractional working sets per muscle per finished week,
-- strength stimulus only, so sprint and endurance work can never leak into a
-- hypertrophy volume number. Only the performed predicate moved.
create view weekly_volume
  with (security_invoker = on) as
select
  date_trunc('week', s.date)::date as week_start,
  m.name as muscle,
  sum(em.volume_factor)::float8 as working_sets
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
group by 1, 2;

-- Delivered work per exercise per week of the mesocycle: the direct comparison
-- partner of mesocycle_exercises.weekly_dose. Two changes beyond the new link.
--
-- The stimulus_type = 'strength' filter is gone. It belonged here only because
-- every plan was a lifting plan; keeping it would make a speed mesocycle's
-- delivery read as zero every week, which is precisely the reading this view
-- exists to prevent. The filter stays where it means something — weekly_volume,
-- where sets are being summed into muscles.
--
-- The distance and duration sums sit beside the set count rather than
-- replacing it, because which one is the dose is the plan's choice: a sprint
-- session's dose is legitimately six sets or 300 metres, and both readings are
-- available without the coach asking for a different endpoint.
create view weekly_exercise_sets_done
  with (security_invoker = on) as
select
  t.mesocycle_id,
  t.exercise_id,
  ((s.date - mc.started_on) / 7) + 1 as week,
  count(*)::integer as sets_done,
  sum(t.distance_m)::float8 as distance_m,
  sum(t.duration_s)::float8 as duration_s
from sets t
join sessions s on s.id = t.session_id
join mesocycles mc on mc.id = t.mesocycle_id
where t.kind = 'working'
  and set_performed(t.reps, t.distance_m, t.duration_s)
  and date_trunc('week', s.date)
    < date_trunc('week', now() at time zone 'Europe/Rome')
group by 1, 2, 3;
