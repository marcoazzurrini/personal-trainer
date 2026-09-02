-- Fractional volume counting. The binary counts flag ("a muscle counts only
-- if it can approach failure in the lift") becomes volume_factor: 1.0 direct,
-- 0.5 indirect, 0 considered-and-excluded. Fractional counting best predicts
-- measured hypertrophy (Pelland et al. 2025 meta-regression), and the
-- criterion for classifying is longitudinal growth evidence, not which muscle
-- fails first — squats grow glutes despite quad failure, and don't grow
-- hamstrings despite hamstring "involvement".
--
-- A 0 row is kept, never deleted: it records "assessed and deliberately
-- excluded", so a future reclassification can't quietly undo a decision.
-- Absent row = never assessed.
--
-- Per-muscle fatigue goes with it. No validated per-exercise fatigue scale
-- exists; the phenomenon worth flagging is systemic (axial loading,
-- whole-body cost), which per-muscle rows cannot express. It becomes a
-- binary exercises.systemic_fatigue. Nothing computes with it — it feeds
-- session-generation judgment (space axial loaders, don't stack them).
--
-- Every data statement below no-ops on an empty database: a fresh local
-- stack runs this migration before the catalogue is loaded.

-- The adductor magnus is a primary hip extensor in deep squats and grows as
-- much as the quads there (Kubo 2019); until now it wasn't representable.
insert into muscles (name) values ('adductors');

alter table exercise_muscles drop column fatigue;

alter table exercise_muscles add column volume_factor numeric(2, 1);

comment on column exercise_muscles.volume_factor is
  '1.0 = direct: primary force generator, loaded dynamically through meaningful range. 0.5 = indirect: meaningfully trained, not primary. 0 = considered and excluded: isometric/stabilizer, no expected growth stimulus — the row records a deliberate decision. Tiebreaker when mechanics and evidence disagree: longitudinal hypertrophy evidence wins.';

-- Backfill: counts true -> 1.0, false -> 0.
update exercise_muscles set volume_factor = counts::int;

-- Reclassifications: rows whose value differs from the backfill. Assigned
-- per (exercise, muscle) pair from growth evidence and anatomy, ratified by
-- Marco 2026-08-07.
update exercise_muscles em
set volume_factor = c.factor
from (values
  ('Back Extension', 'glutes', 0.5),
  ('Back Extension', 'hamstrings', 0.5),
  ('Back Squat', 'glutes', 0.5),
  ('Band Face Pull', 'shoulders', 0.5),
  ('Barbell Row', 'biceps', 0.5),
  ('Bench Press', 'triceps', 0.5),
  ('Bench Press', 'shoulders', 0.5),
  ('Chin-Up', 'upper back', 0.5),
  ('Close-Grip Bench Press', 'chest', 0.5),
  ('Close-Grip Bench Press', 'shoulders', 0.5),
  ('Deadlift', 'hamstrings', 0.5),
  ('Deadlift', 'lower back', 0.5),
  ('Deficit Push-Up', 'triceps', 0.5),
  ('Dip', 'shoulders', 0.5),
  ('Dumbbell Bench Press', 'triceps', 0.5),
  ('Dumbbell Bench Press', 'shoulders', 0.5),
  ('Dumbbell Overhead Press', 'triceps', 0.5),
  ('Goblet Squat', 'glutes', 0.5),
  ('Good Morning', 'lower back', 0.5),
  ('Hammer Curl', 'forearms', 0.5),
  ('Incline Bench Press', 'shoulders', 0.5),
  ('Incline Bench Press', 'triceps', 0.5),
  ('Inverted Row', 'lats', 0.5),
  ('Inverted Row', 'biceps', 0.5),
  ('Neutral-Grip Pull-Up', 'biceps', 0.5),
  ('One-Arm Dumbbell Row', 'upper back', 0.5),
  ('One-Arm Dumbbell Row', 'biceps', 0.5),
  ('Overhead Press', 'triceps', 0.5),
  ('Pause Back Squat', 'glutes', 0.5),
  ('Pike Push-Up', 'triceps', 0.5),
  ('Pull-Up', 'biceps', 0.5),
  ('Pull-Up', 'upper back', 0.5),
  ('Push-Up', 'triceps', 0.5),
  ('Push-Up', 'shoulders', 0.5),
  ('Romanian Deadlift', 'glutes', 0.5),
  ('Romanian Deadlift', 'lower back', 0.5),
  ('Step-Up', 'glutes', 1.0),
  ('Stiff-Leg Deadlift', 'glutes', 0.5),
  ('Stiff-Leg Deadlift', 'lower back', 0.5)
) as c (exercise, muscle, factor)
join exercises e on lower(e.name) = lower(c.exercise)
join muscles m on lower(m.name) = lower(c.muscle)
where em.exercise_id = e.id and em.muscle_id = m.id;

-- counts (and the view reading it) go before the new rows arrive: the new
-- rows have no counts value to give. weekly_volume is recreated at the end —
-- dropped rather than replaced because working_sets changes type.
drop view weekly_volume;

alter table exercise_muscles drop column counts;

-- Pairs assessed for the first time. Deliberately absent: adductors on the
-- hinges (adductor growth evidence is squat-pattern only) and any splitting
-- of shoulders/upper back into heads.
insert into exercise_muscles (exercise_id, muscle_id, volume_factor)
select e.id, m.id, c.factor
from (values
  ('Back Squat', 'adductors', 1.0),
  ('Front Squat', 'adductors', 1.0),
  ('Front Squat', 'glutes', 0.5),
  ('Pause Back Squat', 'adductors', 1.0),
  ('Bulgarian Split Squat', 'adductors', 0.5),
  ('Deficit Split Squat', 'adductors', 0.5),
  ('Goblet Squat', 'adductors', 0.5),
  ('Reverse Lunge', 'adductors', 0.5),
  ('Walking Lunge', 'adductors', 0.5),
  ('Band Pull-Apart', 'shoulders', 0.5),
  ('Deficit Push-Up', 'shoulders', 0.5),
  ('Good Morning', 'glutes', 0.5),
  ('Neutral-Grip Pull-Up', 'upper back', 0.5),
  ('Pendlay Row', 'biceps', 0.5)
) as c (exercise, muscle, factor)
join exercises e on lower(e.name) = lower(c.exercise)
join muscles m on lower(m.name) = lower(c.muscle);

-- Only the empirically validated values: 0.5 is the one intermediate the
-- dose-response literature tested. No free-form fractions.
alter table exercise_muscles
  alter column volume_factor set not null,
  add constraint exercise_muscles_volume_factor_check
    check (volume_factor in (0, 0.5, 1.0));

alter table exercises add column systemic_fatigue text not null default 'normal',
  add constraint exercises_systemic_fatigue_check
    check (systemic_fatigue in ('normal', 'high'));

comment on column exercises.systemic_fatigue is
  'high = whole-body cost disproportionate to set count: heavy axial loading plus large total mass moved. Nothing computes with it; it feeds session-generation judgment (space these out, never stack them). Local brutality (split squats, lunges) stays normal.';

update exercises set systemic_fatigue = 'high'
where name in (
  'Deadlift', 'Romanian Deadlift', 'Stiff-Leg Deadlift', 'Good Morning',
  'Back Squat', 'Front Squat', 'Pause Back Squat',
  'Barbell Row', 'Pendlay Row'
);

-- weekly_volume on the new column: working_sets becomes a fractional sum.
-- The join keeps a > 0 filter so considered-and-excluded rows record the
-- decision without producing zero-volume noise rows.
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
  and t.reps is not null
  and e.stimulus_type = 'strength'
  and date_trunc('week', s.date)
    < date_trunc('week', now() at time zone 'Europe/Rome')
group by 1, 2;
