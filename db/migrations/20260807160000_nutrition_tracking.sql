-- Nutrition, phase 1: the food registry and the intake record.
--
-- The coach extends from training-only to training + nutrition. This migration
-- carries only what tracking needs — foods, meals, what was eaten, and the
-- body-fat series the phase-2 expenditure model will read. Goals, targets and
-- the back-solve arrive in phase 2, once there is data for them to chew on.
--
-- Two decisions in this file are load-bearing, so they are stated here rather
-- than inferred from the columns:
--
-- 1. INTAKE IS SNAPSHOTTED, NOT REFERENCED. An intake row carries its own
--    kcal and macros, copied from the food at the moment it was logged. The
--    same pattern as sets.target_weight_kg, which copies its target instead of
--    pointing at one: editing a routine must never rewrite history. A meal's
--    recipe evolves; the breakfast logged in March stays the breakfast that
--    was eaten in March. (MacroFactor made the same call; Cronometer's
--    propagate-to-past dialog is a documented footgun.) Superseded in part: a
--    later change made PATCH /foods rewrite every entry logged from the food,
--    because a mistyped food was always wrong and its entries always were too.
--    The snapshot still holds where it was aimed — a meal's recipe evolving
--    never touches what was already eaten.
--
-- 2. THE ROW'S SHAPE IS ITS KIND. There is no kind column. A food entry has
--    food_id and grams; an ad-hoc entry ("pizza out, call it 1200") has
--    neither and just carries kcal. Logging a saved meal writes one row per
--    item, all sharing meal_id. So a day's total is one sum over one uniform
--    table, and "the usual breakfast but double yogurt" is an ordinary extra
--    row rather than a special case.
--
-- Conventions are the initial schema's, unchanged: bigint identity keys,
-- CHECK constraints over enums, no ON DELETE CASCADE, date for calendar days
-- and timestamptz for instants, every FK column indexed, every column NOT NULL
-- unless null carries meaning, numeric for anything measured, RLS on with no
-- policies so PostgREST stays locked out, and request_id on everything a
-- creating POST writes.

-- ---------------------------------------------------------------------------
-- The food registry
-- ---------------------------------------------------------------------------

-- Per 100 g always. The coach sources a food once — from a label photo, CREA,
-- USDA or Open Food Facts — and saves it back so it is never searched twice.
-- source is never decorative: an 'estimate' row is disclosed to Marco as one.
create table foods (
  id bigint generated always as identity primary key,
  name text not null,
  brand text, -- descriptive only, nothing resolves on it
  kcal_100g numeric(6, 1) not null,
  protein_100g numeric(5, 1) not null,
  carbs_100g numeric(5, 1) not null,
  fat_100g numeric(5, 1) not null,
  fiber_100g numeric(5, 1), -- null = unknown, not zero
  -- Set for foods counted in pieces, so "1 egg" resolves to grams.
  grams_per_unit numeric(6, 1),
  source text not null,
  source_note text,
  request_id uuid,
  created_at timestamptz not null default now(),
  constraint foods_source_check
    check (source in ('label', 'crea', 'usda', 'off', 'estimate')),
  constraint foods_kcal_not_negative check (kcal_100g >= 0),
  constraint foods_protein_not_negative check (protein_100g >= 0),
  constraint foods_carbs_not_negative check (carbs_100g >= 0),
  constraint foods_fat_not_negative check (fat_100g >= 0),
  constraint foods_fiber_not_negative
    check (fiber_100g is null or fiber_100g >= 0),
  constraint foods_grams_per_unit_positive
    check (grams_per_unit is null or grams_per_unit > 0),
  constraint foods_request_id_key unique (request_id)
);

comment on column foods.source is
  'Where the numbers came from: label (Marco''s own product, best), crea/usda/off (official composition tables), estimate (no good source — disclosed to Marco as an estimate, never presented as fact).';

comment on column foods.brand is
  'Descriptive. Resolution happens on name and aliases only, so two brands of the same food need distinct names — the discipline that keeps an exercise''s history from splitting applies here too.';

-- Case-insensitive, like exercises: one food, one row. A duplicate splits the
-- food's history exactly the way a duplicate exercise splits a lift's.
create unique index foods_name_key on foods (lower(name));

create table food_aliases (
  id bigint generated always as identity primary key,
  food_id bigint not null references foods,
  alias text not null
);

-- Case-insensitive: load-bearing for server-side name resolution.
create unique index food_aliases_alias_key on food_aliases (lower(alias));
create index food_aliases_food_id_idx on food_aliases (food_id);

-- ---------------------------------------------------------------------------
-- Meals: routines, not history
-- ---------------------------------------------------------------------------

-- "il mio solito yogurt" — a named set of foods and amounts, so a logged day
-- costs seconds. Editing a meal changes what future logs write; it cannot
-- reach anything already logged.
create table meals (
  id bigint generated always as identity primary key,
  name text not null,
  request_id uuid,
  created_at timestamptz not null default now(),
  constraint meals_request_id_key unique (request_id)
);

create unique index meals_name_key on meals (lower(name));

create table meal_aliases (
  id bigint generated always as identity primary key,
  meal_id bigint not null references meals,
  alias text not null
);

create unique index meal_aliases_alias_key on meal_aliases (lower(alias));
create index meal_aliases_meal_id_idx on meal_aliases (meal_id);

create table meal_items (
  id bigint generated always as identity primary key,
  meal_id bigint not null references meals,
  food_id bigint not null references foods,
  grams numeric(7, 1) not null,
  constraint meal_items_grams_positive check (grams > 0),
  -- One line per food: a second helping is grams, not a second row.
  constraint meal_items_meal_food_key unique (meal_id, food_id)
);

create index meal_items_food_id_idx on meal_items (food_id);

-- ---------------------------------------------------------------------------
-- The intake record
-- ---------------------------------------------------------------------------

-- One row per food eaten. Macros are the snapshot described at the top of this
-- file: written at log time, never recomputed from foods afterwards.
create table intake_entries (
  id bigint generated always as identity primary key,
  day date not null, -- Europe/Rome calendar day
  -- Both null on an ad-hoc entry; food_id and grams arrive together otherwise.
  food_id bigint references foods,
  grams numeric(7, 1),
  -- Provenance and grouping: which saved meal produced this row, if any.
  -- Never a live reference — the macros above already stand on their own.
  meal_id bigint references meals,
  kcal numeric(7, 1) not null,
  protein_g numeric(6, 1),
  carbs_g numeric(6, 1),
  fat_g numeric(6, 1),
  fiber_g numeric(6, 1),
  note text,
  request_id uuid,
  created_at timestamptz not null default now(),
  constraint intake_entries_grams_positive check (grams is null or grams > 0),
  constraint intake_entries_kcal_not_negative check (kcal >= 0),
  constraint intake_entries_protein_not_negative
    check (protein_g is null or protein_g >= 0),
  constraint intake_entries_carbs_not_negative
    check (carbs_g is null or carbs_g >= 0),
  constraint intake_entries_fat_not_negative
    check (fat_g is null or fat_g >= 0),
  constraint intake_entries_fiber_not_negative
    check (fiber_g is null or fiber_g >= 0),
  -- "A food, this much of it" is one fact, not two.
  constraint intake_entries_food_grams_pair
    check ((food_id is null) = (grams is null)),
  -- A food-backed row always snapshots the full macro set; only an ad-hoc
  -- estimate is allowed to be kcal-only. Fiber stays optional either way:
  -- the source food may not carry it.
  constraint intake_entries_food_macros_complete
    check (
      food_id is null
      or (protein_g is not null and carbs_g is not null and fat_g is not null)
    )
);

-- Idempotency, one row further out than elsewhere. A creating POST normally
-- writes one row and carries a unique request_id on it; logging a saved meal
-- writes one row per item, all from the same request, so a plain unique
-- request_id would reject every meal past its first food.
--
-- (request_id, food_id) is the right grain instead: a meal's items are unique
-- by (meal_id, food_id) and an ad-hoc entry is a single row, so one request
-- can never legitimately produce two rows for the same food. nulls not
-- distinct makes the ad-hoc case (food_id null) comparable so retries collide
-- there too; the partial predicate keeps rows written without a request_id
-- out of the index entirely, where they would otherwise collide with each
-- other on (null, food_id).
create unique index intake_entries_request_food_key
  on intake_entries (request_id, food_id) nulls not distinct
  where request_id is not null;

create index intake_entries_day_idx on intake_entries (day);
create index intake_entries_food_id_idx on intake_entries (food_id);
create index intake_entries_meal_id_idx on intake_entries (meal_id);

-- A day Marco declares a lost cause. The expenditure window excludes flagged
-- days rather than counting them as zero intake, which would drag the mean
-- and corrupt the back-solve. Removable: a flag is a statement about the
-- record, not part of it.
create table day_flags (
  id bigint generated always as identity primary key,
  day date not null,
  flag text not null,
  created_at timestamptz not null default now(),
  constraint day_flags_flag_check check (flag in ('incomplete')),
  constraint day_flags_day_flag_key unique (day, flag)
);

-- ---------------------------------------------------------------------------
-- Body fat: the input Forbes needs
-- ---------------------------------------------------------------------------

-- The energy density of a weight change is composition-weighted, not a flat
-- 7,700 kcal/kg: p = C / (C + FM) with Forbes' C = 10.4 kg, and fat mass comes
-- from here. Precision is not critical — the result is only modestly sensitive
-- to FM error — but it must be a number the server can read, which is why this
-- is a table and not a user_context row, and a series rather than a column:
-- the estimate gets re-anchored as the phase goes on.
create table bodyfat_estimates (
  id bigint generated always as identity primary key,
  day date not null,
  percent numeric(4, 1) not null,
  method text not null,
  note text,
  request_id uuid,
  created_at timestamptz not null default now(),
  constraint bodyfat_estimates_method_check
    check (method in ('bia', 'dxa', 'caliper', 'visual', 'other')),
  constraint bodyfat_estimates_percent_range
    check (percent > 0 and percent < 75),
  -- Natural key, like bodyweight's (measured_at, source): a retried write
  -- bounces instead of planting a second point on the same day.
  constraint bodyfat_estimates_day_method_key unique (day, method),
  constraint bodyfat_estimates_request_id_key unique (request_id)
);

-- ---------------------------------------------------------------------------
-- Lock the auto-generated REST API
-- ---------------------------------------------------------------------------

alter table foods enable row level security;
alter table food_aliases enable row level security;
alter table meals enable row level security;
alter table meal_aliases enable row level security;
alter table meal_items enable row level security;
alter table intake_entries enable row level security;
alter table day_flags enable row level security;
alter table bodyfat_estimates enable row level security;

-- ---------------------------------------------------------------------------
-- The one weight per day the trend model reads
-- ---------------------------------------------------------------------------
-- bodyweight stores instants, and the EMA needs one value per calendar day.
-- Earliest wins: the morning weigh-in is the standardized measurement, and an
-- evening weight would blend in a day of food and water. Not a stored value —
-- the view computes it, like weekly_volume.
-- security_invoker: without it the view runs as its owner and would leak
-- through PostgREST past the RLS lock above.

create view daily_bodyweight
  with (security_invoker = on) as
select distinct on (day)
  (measured_at at time zone 'Europe/Rome')::date as day,
  value_kg::float8 as value_kg,
  measured_at
from bodyweight
order by day, measured_at;
