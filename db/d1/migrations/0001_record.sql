-- D1 record schema: the final state of every db/migrations file through
-- 20260908160000_owned_registry_rows_cascade.sql, not a replay or a data copy.
-- No seed rows, backfills, migration receipts, or dropped historical tables.
-- ADR-0006/0011/0012/0013/0014 boundaries remain; the approved Workers/D1
-- migration supersedes ADR-0008's PostgreSQL/Coolify runtime, not API ownership.
--
-- STORAGE CONTRACT (also machine-readable in ../storage.json):
-- * STRICT tables prevent fractional REAL values from entering INTEGER columns.
-- * numeric(p,s) uses the original name and an INTEGER scaled by 10^s, bounded
--   to +/-(10^p - 1). Original checks below use those scaled units.
-- * Instants are YYYY-MM-DDTHH:MM:SS.ffffffZ; lexicographic order is time order.
--   UTC defaults have millisecond resolution padded to six fractional digits
--   and use statement time, not PostgreSQL's transaction-start now(). Writers
--   needing one instant across a batch must supply it. API/importer-supplied
--   instants retain all six original fractional digits.
-- * Dates are canonical YYYY-MM-DD. Dates/instants accept years 0001..9999;
--   PostgreSQL BC, extended years, infinity and numeric NaN are not representable.
-- * UUIDs are canonical lowercase, with no version restriction. Canonical
--   checks count bytes, not characters: SQLite length(TEXT) stops at NUL.
-- * JSON arrays use TEXT; array membership is checked by triggers because
--   SQLite forbids json_each subqueries inside CHECK constraints. clipped_reasons
--   is a one-dimensional JSON list. The importer must refuse PostgreSQL arrays
--   with multiple dimensions or non-default lower bounds, not silently flatten
--   them or discard their bounds.
-- * name_key/alias_key are REQUIRED Unicode String.toLowerCase() results from
--   the API/importer, including on rename. SQLite lower()/NOCASE are not used.
--   The DB enforces key uniqueness, not the Unicode derivation. muscles.name
--   retains its original case-sensitive UNIQUE constraint.
-- * bodyweight.measured_date is REQUIRED: compute the Europe/Rome calendar day
--   from measured_at in the API/importer, including on correction. SQLite
--   cannot verify that relationship without a named-timezone implementation.
-- * AUTOINCREMENT prevents reuse of committed generated identities. The importer
--   must advance sqlite_sequence to at least both the PostgreSQL sequence
--   high-water mark (including deleted ids) and MAX(imported id), and preserve
--   64-bit integers without JavaScript Number precision loss. Explicit id inserts
--   bypass allocation, as required for a faithful import; the importer must
--   reject nonpositive event/target ids because their signs distinguish events.
-- * Only the three owned-registry foreign keys cascade, exactly as in PostgreSQL.
--   Other references still block deletion; dose history is not membership.
-- * D1 supplies foreign-key enforcement. Local SQLite callers must enable
--   PRAGMA foreign_keys = ON before applying this file, outside a transaction.
--   There is no PostgreSQL RLS/security_invoker, stored function, or advisory lock
--   here. The API remains the sole record boundary; transaction/locking and
--   constraint-error translation must be ported in its readers and writers.
--
-- IMPORTANT: BOTH WEEKLY VIEWS INCLUDE ALL WEEKS, INCLUDING UNFINISHED/FUTURE
-- WEEKS. Their TypeScript API readers MUST filter completed weeks using the
-- Europe/Rome calendar. Never use SQLite's UTC clock as a Rome calendar, invent
-- DST rules, or add a calendar-control table. No database clock filters views.

-- Athlete and reference data -------------------------------------------------
create table users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  height_cm INTEGER CHECK (height_cm BETWEEN -9999 AND 9999)
) STRICT;

create table user_context (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  topic TEXT NOT NULL,
  content TEXT NOT NULL,
  written_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now') || '000Z'),
  request_id TEXT,
  CONSTRAINT user_context_request_id_key UNIQUE (request_id),
  CONSTRAINT user_context_written_at_utc CHECK (written_at IS NULL OR (
    length(cast(written_at as blob)) = 27 AND substr(written_at, 1, 4) >= '0001'
    AND strftime('%Y-%m-%dT%H:%M:%S', substr(written_at, 1, 19), '+0 seconds') IS substr(written_at, 1, 19)
    AND substr(written_at, 20) GLOB '.[0-9][0-9][0-9][0-9][0-9][0-9]Z'
  )),
  CONSTRAINT user_context_request_id_uuid CHECK (request_id IS NULL OR (
    length(cast(request_id as blob)) = 36 AND substr(request_id, 9, 1) = '-' AND substr(request_id, 14, 1) = '-'
    AND substr(request_id, 19, 1) = '-' AND substr(request_id, 24, 1) = '-'
    AND length(replace(request_id, '-', '')) = 32 AND replace(request_id, '-', '') NOT GLOB '*[^0-9a-f]*'
  ))
) STRICT;
create index user_context_topic_written_at_idx on user_context (topic, written_at desc);

create table bodyweight (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  value_kg INTEGER NOT NULL CHECK (value_kg BETWEEN -99999 AND 99999),
  measured_at TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'manual',
  measured_date TEXT NOT NULL,
  CONSTRAINT bodyweight_value_positive CHECK (value_kg > 0),
  CONSTRAINT bodyweight_measured_at_source_key UNIQUE (measured_at, source),
  CONSTRAINT bodyweight_measured_date_date CHECK (measured_date IS NULL OR (
    length(cast(measured_date as blob)) = 10 AND substr(measured_date, 1, 4) >= '0001'
    AND date(measured_date, '+0 days') IS measured_date
  )),
  CONSTRAINT bodyweight_measured_at_utc CHECK (measured_at IS NULL OR (
    length(cast(measured_at as blob)) = 27 AND substr(measured_at, 1, 4) >= '0001'
    AND strftime('%Y-%m-%dT%H:%M:%S', substr(measured_at, 1, 19), '+0 seconds') IS substr(measured_at, 1, 19)
    AND substr(measured_at, 20) GLOB '.[0-9][0-9][0-9][0-9][0-9][0-9]Z'
  ))
) STRICT;
create index bodyweight_measured_date_instant_idx on bodyweight (measured_date, measured_at, id);

create table muscles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  CONSTRAINT muscles_name_key UNIQUE (name)
) STRICT;

create table exercises (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  equipment TEXT,
  pattern TEXT,
  stimulus_type TEXT NOT NULL DEFAULT 'strength',
  notes TEXT,
  systemic_fatigue TEXT NOT NULL DEFAULT 'normal',
  measure TEXT NOT NULL DEFAULT 'load_reps',
  name_key TEXT NOT NULL,
  CONSTRAINT exercises_stimulus_type_check CHECK (stimulus_type IN ('strength', 'power', 'conditioning')),
  CONSTRAINT exercises_systemic_fatigue_check CHECK (systemic_fatigue IN ('normal', 'high')),
  CONSTRAINT exercises_measure_check CHECK (measure IN ('load_reps', 'reps', 'distance', 'duration', 'distance_duration'))
) STRICT;
create unique index exercises_name_key on exercises (name_key);

create table exercise_aliases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  exercise_id INTEGER NOT NULL,
  alias TEXT NOT NULL,
  alias_key TEXT NOT NULL,
  CONSTRAINT exercise_aliases_exercise_id_fkey FOREIGN KEY (exercise_id) REFERENCES exercises (id) ON DELETE CASCADE
) STRICT;
create unique index exercise_aliases_alias_key on exercise_aliases (alias_key);
create index exercise_aliases_exercise_id_idx on exercise_aliases (exercise_id);

create table exercise_muscles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  exercise_id INTEGER NOT NULL,
  muscle_id INTEGER NOT NULL REFERENCES muscles (id),
  volume_factor INTEGER NOT NULL CHECK (volume_factor BETWEEN -99 AND 99),
  CONSTRAINT exercise_muscles_exercise_id_fkey FOREIGN KEY (exercise_id) REFERENCES exercises (id) ON DELETE CASCADE,
  CONSTRAINT exercise_muscles_exercise_muscle_key UNIQUE (exercise_id, muscle_id),
  CONSTRAINT exercise_muscles_volume_factor_check CHECK (volume_factor IN (0, 5, 10))
) STRICT;
create index exercise_muscles_muscle_id_idx on exercise_muscles (muscle_id);

-- Plans, membership and decisions -------------------------------------------
create table blocks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  goal TEXT NOT NULL,
  started_on TEXT NOT NULL,
  ended_on TEXT,
  request_id TEXT,
  CONSTRAINT blocks_dates_ordered CHECK (ended_on IS NULL OR ended_on >= started_on),
  CONSTRAINT blocks_request_id_key UNIQUE (request_id),
  CONSTRAINT blocks_started_on_date CHECK (started_on IS NULL OR (
    length(cast(started_on as blob)) = 10 AND substr(started_on, 1, 4) >= '0001'
    AND date(started_on, '+0 days') IS started_on
  )),
  CONSTRAINT blocks_ended_on_date CHECK (ended_on IS NULL OR (
    length(cast(ended_on as blob)) = 10 AND substr(ended_on, 1, 4) >= '0001'
    AND date(ended_on, '+0 days') IS ended_on
  )),
  CONSTRAINT blocks_request_id_uuid CHECK (request_id IS NULL OR (
    length(cast(request_id as blob)) = 36 AND substr(request_id, 9, 1) = '-' AND substr(request_id, 14, 1) = '-'
    AND substr(request_id, 19, 1) = '-' AND substr(request_id, 24, 1) = '-'
    AND length(replace(request_id, '-', '')) = 32 AND replace(request_id, '-', '') NOT GLOB '*[^0-9a-f]*'
  ))
) STRICT;

create table mesocycles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  block_id INTEGER NOT NULL REFERENCES blocks (id),
  name TEXT NOT NULL,
  intent TEXT NOT NULL,
  planned_weeks INTEGER NOT NULL CHECK (planned_weeks BETWEEN -2147483648 AND 2147483647),
  sessions_per_week INTEGER NOT NULL CHECK (sessions_per_week BETWEEN -2147483648 AND 2147483647),
  started_on TEXT NOT NULL,
  ended_on TEXT,
  request_id TEXT,
  track TEXT NOT NULL,
  CONSTRAINT mesocycles_planned_weeks_positive CHECK (planned_weeks > 0),
  CONSTRAINT mesocycles_sessions_per_week_positive CHECK (sessions_per_week > 0),
  CONSTRAINT mesocycles_starts_on_monday CHECK (strftime('%w', started_on) = '1'),
  CONSTRAINT mesocycles_dates_ordered CHECK (ended_on IS NULL OR ended_on >= started_on),
  CONSTRAINT mesocycles_request_id_key UNIQUE (request_id),
  CONSTRAINT mesocycles_track_check CHECK (track IN ('hypertrophy', 'strength', 'speed', 'endurance')),
  CONSTRAINT mesocycles_started_on_date CHECK (started_on IS NULL OR (
    length(cast(started_on as blob)) = 10 AND substr(started_on, 1, 4) >= '0001'
    AND date(started_on, '+0 days') IS started_on
  )),
  CONSTRAINT mesocycles_ended_on_date CHECK (ended_on IS NULL OR (
    length(cast(ended_on as blob)) = 10 AND substr(ended_on, 1, 4) >= '0001'
    AND date(ended_on, '+0 days') IS ended_on
  )),
  CONSTRAINT mesocycles_request_id_uuid CHECK (request_id IS NULL OR (
    length(cast(request_id as blob)) = 36 AND substr(request_id, 9, 1) = '-' AND substr(request_id, 14, 1) = '-'
    AND substr(request_id, 19, 1) = '-' AND substr(request_id, 24, 1) = '-'
    AND length(replace(request_id, '-', '')) = 32 AND replace(request_id, '-', '') NOT GLOB '*[^0-9a-f]*'
  ))
) STRICT;
create index mesocycles_block_id_idx on mesocycles (block_id);
create unique index mesocycles_one_active_per_track on mesocycles (track) where ended_on is null;

-- Membership contains no current-dose copy. Removal must not erase dose history.
create table mesocycle_exercises (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mesocycle_id INTEGER NOT NULL REFERENCES mesocycles (id),
  exercise_id INTEGER NOT NULL REFERENCES exercises (id),
  role TEXT NOT NULL,
  priority INTEGER NOT NULL CHECK (priority BETWEEN -2147483648 AND 2147483647),
  notes TEXT,
  CONSTRAINT mesocycle_exercises_role_check CHECK (role IN ('main', 'accessory', 'rehab')),
  CONSTRAINT mesocycle_exercises_mesocycle_exercise_key UNIQUE (mesocycle_id, exercise_id)
) STRICT;
create index mesocycle_exercises_exercise_id_idx on mesocycle_exercises (exercise_id);

create table mesocycle_decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mesocycle_id INTEGER NOT NULL REFERENCES mesocycles (id),
  made_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now') || '000Z'),
  what_changed TEXT NOT NULL,
  why TEXT NOT NULL,
  request_id TEXT,
  prior_intent TEXT,
  CONSTRAINT mesocycle_decisions_request_id_key UNIQUE (request_id),
  CONSTRAINT mesocycle_decisions_made_at_utc CHECK (made_at IS NULL OR (
    length(cast(made_at as blob)) = 27 AND substr(made_at, 1, 4) >= '0001'
    AND strftime('%Y-%m-%dT%H:%M:%S', substr(made_at, 1, 19), '+0 seconds') IS substr(made_at, 1, 19)
    AND substr(made_at, 20) GLOB '.[0-9][0-9][0-9][0-9][0-9][0-9]Z'
  )),
  CONSTRAINT mesocycle_decisions_request_id_uuid CHECK (request_id IS NULL OR (
    length(cast(request_id as blob)) = 36 AND substr(request_id, 9, 1) = '-' AND substr(request_id, 14, 1) = '-'
    AND substr(request_id, 19, 1) = '-' AND substr(request_id, 24, 1) = '-'
    AND length(replace(request_id, '-', '')) = 32 AND replace(request_id, '-', '') NOT GLOB '*[^0-9a-f]*'
  ))
) STRICT;
create index mesocycle_decisions_mesocycle_id_idx on mesocycle_decisions (mesocycle_id);

-- Training record -----------------------------------------------------------
create table sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  rationale TEXT NOT NULL,
  notes TEXT,
  overall_feel TEXT,
  started_at TEXT,
  completed_at TEXT,
  request_id TEXT,
  CONSTRAINT sessions_request_id_key UNIQUE (request_id),
  CONSTRAINT sessions_times_ordered CHECK (started_at IS NULL OR completed_at IS NULL OR completed_at >= started_at),
  CONSTRAINT sessions_date_date CHECK (date IS NULL OR (
    length(cast(date as blob)) = 10 AND substr(date, 1, 4) >= '0001'
    AND date(date, '+0 days') IS date
  )),
  CONSTRAINT sessions_started_at_utc CHECK (started_at IS NULL OR (
    length(cast(started_at as blob)) = 27 AND substr(started_at, 1, 4) >= '0001'
    AND strftime('%Y-%m-%dT%H:%M:%S', substr(started_at, 1, 19), '+0 seconds') IS substr(started_at, 1, 19)
    AND substr(started_at, 20) GLOB '.[0-9][0-9][0-9][0-9][0-9][0-9]Z'
  )),
  CONSTRAINT sessions_completed_at_utc CHECK (completed_at IS NULL OR (
    length(cast(completed_at as blob)) = 27 AND substr(completed_at, 1, 4) >= '0001'
    AND strftime('%Y-%m-%dT%H:%M:%S', substr(completed_at, 1, 19), '+0 seconds') IS substr(completed_at, 1, 19)
    AND substr(completed_at, 20) GLOB '.[0-9][0-9][0-9][0-9][0-9][0-9]Z'
  )),
  CONSTRAINT sessions_request_id_uuid CHECK (request_id IS NULL OR (
    length(cast(request_id as blob)) = 36 AND substr(request_id, 9, 1) = '-' AND substr(request_id, 14, 1) = '-'
    AND substr(request_id, 19, 1) = '-' AND substr(request_id, 24, 1) = '-'
    AND length(replace(request_id, '-', '')) = 32 AND replace(request_id, '-', '') NOT GLOB '*[^0-9a-f]*'
  ))
) STRICT;
create index sessions_date_idx on sessions (date);

create table sets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES sessions (id),
  exercise_id INTEGER NOT NULL REFERENCES exercises (id),
  position INTEGER NOT NULL CHECK (position BETWEEN -2147483648 AND 2147483647),
  kind TEXT NOT NULL,
  target_weight_kg INTEGER CHECK (target_weight_kg BETWEEN -999999 AND 999999),
  target_reps INTEGER CHECK (target_reps BETWEEN -2147483648 AND 2147483647),
  weight_kg INTEGER CHECK (weight_kg BETWEEN -999999 AND 999999),
  reps INTEGER CHECK (reps BETWEEN -2147483648 AND 2147483647),
  effort TEXT,
  performed_at TEXT,
  notes TEXT,
  request_id TEXT,
  target_distance_m INTEGER CHECK (target_distance_m BETWEEN -9999999 AND 9999999),
  distance_m INTEGER CHECK (distance_m BETWEEN -9999999 AND 9999999),
  target_duration_s INTEGER CHECK (target_duration_s BETWEEN -99999999 AND 99999999),
  duration_s INTEGER CHECK (duration_s BETWEEN -99999999 AND 99999999),
  mesocycle_id INTEGER REFERENCES mesocycles (id),
  CONSTRAINT sets_kind_check CHECK (kind IN ('warmup', 'working')),
  CONSTRAINT sets_effort_check CHECK (effort IN ('easy', 'hard', 'failure')),
  CONSTRAINT sets_position_positive CHECK (position > 0),
  CONSTRAINT sets_position_key UNIQUE (session_id, position),
  CONSTRAINT sets_target_weight_not_negative CHECK (target_weight_kg IS NULL OR target_weight_kg >= 0),
  CONSTRAINT sets_target_reps_positive CHECK (target_reps IS NULL OR target_reps > 0),
  CONSTRAINT sets_weight_not_negative CHECK (weight_kg IS NULL OR weight_kg >= 0),
  CONSTRAINT sets_reps_positive CHECK (reps IS NULL OR reps > 0),
  CONSTRAINT sets_effort_working_only CHECK (kind = 'working' OR effort IS NULL),
  CONSTRAINT sets_request_id_key UNIQUE (request_id),
  CONSTRAINT sets_distance_positive CHECK (distance_m IS NULL OR distance_m > 0),
  CONSTRAINT sets_target_distance_positive CHECK (target_distance_m IS NULL OR target_distance_m > 0),
  CONSTRAINT sets_duration_positive CHECK (duration_s IS NULL OR duration_s > 0),
  CONSTRAINT sets_target_duration_positive CHECK (target_duration_s IS NULL OR target_duration_s > 0),
  CONSTRAINT sets_weight_accompanies_a_measure CHECK (weight_kg IS NULL OR reps IS NOT NULL OR distance_m IS NOT NULL OR duration_s IS NOT NULL),
  CONSTRAINT sets_target_weight_accompanies_a_measure CHECK (target_weight_kg IS NULL OR target_reps IS NOT NULL OR target_distance_m IS NOT NULL OR target_duration_s IS NOT NULL),
  CONSTRAINT sets_performed_at_utc CHECK (performed_at IS NULL OR (
    length(cast(performed_at as blob)) = 27 AND substr(performed_at, 1, 4) >= '0001'
    AND strftime('%Y-%m-%dT%H:%M:%S', substr(performed_at, 1, 19), '+0 seconds') IS substr(performed_at, 1, 19)
    AND substr(performed_at, 20) GLOB '.[0-9][0-9][0-9][0-9][0-9][0-9]Z'
  )),
  CONSTRAINT sets_request_id_uuid CHECK (request_id IS NULL OR (
    length(cast(request_id as blob)) = 36 AND substr(request_id, 9, 1) = '-' AND substr(request_id, 14, 1) = '-'
    AND substr(request_id, 19, 1) = '-' AND substr(request_id, 24, 1) = '-'
    AND length(replace(request_id, '-', '')) = 32 AND replace(request_id, '-', '') NOT GLOB '*[^0-9a-f]*'
  ))
) STRICT;
create index sets_session_id_idx on sets (session_id);
create index sets_exercise_id_performed_at_idx on sets (exercise_id, performed_at);
create index sets_mesocycle_id_idx on sets (mesocycle_id);

-- Food registry and saved recipes -------------------------------------------
create table foods (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  brand TEXT,
  kcal_100g INTEGER NOT NULL CHECK (kcal_100g BETWEEN -999999 AND 999999),
  protein_100g INTEGER NOT NULL CHECK (protein_100g BETWEEN -99999 AND 99999),
  carbs_100g INTEGER NOT NULL CHECK (carbs_100g BETWEEN -99999 AND 99999),
  fat_100g INTEGER NOT NULL CHECK (fat_100g BETWEEN -99999 AND 99999),
  fiber_100g INTEGER CHECK (fiber_100g BETWEEN -99999 AND 99999),
  grams_per_unit INTEGER CHECK (grams_per_unit BETWEEN -999999 AND 999999),
  source TEXT NOT NULL,
  source_note TEXT,
  request_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now') || '000Z'),
  macro_revision INTEGER NOT NULL DEFAULT 0 CHECK (macro_revision >= 0),
  name_key TEXT NOT NULL,
  CONSTRAINT foods_source_check CHECK (source IN ('label', 'crea', 'usda', 'off', 'estimate')),
  CONSTRAINT foods_kcal_not_negative CHECK (kcal_100g >= 0),
  CONSTRAINT foods_protein_not_negative CHECK (protein_100g >= 0),
  CONSTRAINT foods_carbs_not_negative CHECK (carbs_100g >= 0),
  CONSTRAINT foods_fat_not_negative CHECK (fat_100g >= 0),
  CONSTRAINT foods_fiber_not_negative CHECK (fiber_100g IS NULL OR fiber_100g >= 0),
  CONSTRAINT foods_grams_per_unit_positive CHECK (grams_per_unit IS NULL OR grams_per_unit > 0),
  CONSTRAINT foods_request_id_key UNIQUE (request_id),
  CONSTRAINT foods_created_at_utc CHECK (created_at IS NULL OR (
    length(cast(created_at as blob)) = 27 AND substr(created_at, 1, 4) >= '0001'
    AND strftime('%Y-%m-%dT%H:%M:%S', substr(created_at, 1, 19), '+0 seconds') IS substr(created_at, 1, 19)
    AND substr(created_at, 20) GLOB '.[0-9][0-9][0-9][0-9][0-9][0-9]Z'
  )),
  CONSTRAINT foods_request_id_uuid CHECK (request_id IS NULL OR (
    length(cast(request_id as blob)) = 36 AND substr(request_id, 9, 1) = '-' AND substr(request_id, 14, 1) = '-'
    AND substr(request_id, 19, 1) = '-' AND substr(request_id, 24, 1) = '-'
    AND length(replace(request_id, '-', '')) = 32 AND replace(request_id, '-', '') NOT GLOB '*[^0-9a-f]*'
  ))
) STRICT;
create unique index foods_name_key on foods (name_key);

create table food_aliases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  food_id INTEGER NOT NULL,
  alias TEXT NOT NULL,
  alias_key TEXT NOT NULL,
  CONSTRAINT food_aliases_food_id_fkey FOREIGN KEY (food_id) REFERENCES foods (id) ON DELETE CASCADE
) STRICT;
create unique index food_aliases_alias_key on food_aliases (alias_key);
create index food_aliases_food_id_idx on food_aliases (food_id);

create table meals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  request_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now') || '000Z'),
  name_key TEXT NOT NULL,
  CONSTRAINT meals_request_id_key UNIQUE (request_id),
  CONSTRAINT meals_created_at_utc CHECK (created_at IS NULL OR (
    length(cast(created_at as blob)) = 27 AND substr(created_at, 1, 4) >= '0001'
    AND strftime('%Y-%m-%dT%H:%M:%S', substr(created_at, 1, 19), '+0 seconds') IS substr(created_at, 1, 19)
    AND substr(created_at, 20) GLOB '.[0-9][0-9][0-9][0-9][0-9][0-9]Z'
  )),
  CONSTRAINT meals_request_id_uuid CHECK (request_id IS NULL OR (
    length(cast(request_id as blob)) = 36 AND substr(request_id, 9, 1) = '-' AND substr(request_id, 14, 1) = '-'
    AND substr(request_id, 19, 1) = '-' AND substr(request_id, 24, 1) = '-'
    AND length(replace(request_id, '-', '')) = 32 AND replace(request_id, '-', '') NOT GLOB '*[^0-9a-f]*'
  ))
) STRICT;
create unique index meals_name_key on meals (name_key);

-- These references do NOT cascade: the final PostgreSQL migration changes only
-- food_aliases, exercise_aliases and exercise_muscles, not meal-owned rows.
create table meal_aliases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  meal_id INTEGER NOT NULL REFERENCES meals (id),
  alias TEXT NOT NULL,
  alias_key TEXT NOT NULL
) STRICT;
create unique index meal_aliases_alias_key on meal_aliases (alias_key);
create index meal_aliases_meal_id_idx on meal_aliases (meal_id);

create table meal_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  meal_id INTEGER NOT NULL REFERENCES meals (id),
  food_id INTEGER NOT NULL REFERENCES foods (id),
  grams INTEGER NOT NULL CHECK (grams BETWEEN -9999999 AND 9999999),
  CONSTRAINT meal_items_grams_positive CHECK (grams > 0),
  CONSTRAINT meal_items_meal_food_key UNIQUE (meal_id, food_id)
) STRICT;
create index meal_items_food_id_idx on meal_items (food_id);

-- Intake stores quantities, ad-hoc values and revision-bound overrides only.
create table intake_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  day TEXT NOT NULL,
  food_id INTEGER REFERENCES foods (id),
  grams INTEGER CHECK (grams BETWEEN -9999999 AND 9999999),
  meal_id INTEGER REFERENCES meals (id),
  kcal INTEGER CHECK (kcal BETWEEN -9999999 AND 9999999),
  protein_g INTEGER CHECK (protein_g BETWEEN -999999 AND 999999),
  carbs_g INTEGER CHECK (carbs_g BETWEEN -999999 AND 999999),
  fat_g INTEGER CHECK (fat_g BETWEEN -999999 AND 999999),
  fiber_g INTEGER CHECK (fiber_g BETWEEN -999999 AND 999999),
  note TEXT,
  request_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now') || '000Z'),
  food_macro_revision INTEGER CHECK (food_macro_revision >= 0),
  CONSTRAINT intake_entries_grams_positive CHECK (grams IS NULL OR grams > 0),
  CONSTRAINT intake_entries_kcal_not_negative CHECK (kcal >= 0),
  CONSTRAINT intake_entries_protein_not_negative CHECK (protein_g IS NULL OR protein_g >= 0),
  CONSTRAINT intake_entries_carbs_not_negative CHECK (carbs_g IS NULL OR carbs_g >= 0),
  CONSTRAINT intake_entries_fat_not_negative CHECK (fat_g IS NULL OR fat_g >= 0),
  CONSTRAINT intake_entries_fiber_not_negative CHECK (fiber_g IS NULL OR fiber_g >= 0),
  CONSTRAINT intake_entries_food_grams_pair CHECK ((food_id IS NULL) = (grams IS NULL)),
  CONSTRAINT intake_entries_macro_shape CHECK (
    (food_id IS NULL AND kcal IS NOT NULL AND food_macro_revision IS NULL)
    OR (food_id IS NOT NULL AND (
      (food_macro_revision IS NULL AND kcal IS NULL AND protein_g IS NULL
        AND carbs_g IS NULL AND fat_g IS NULL AND fiber_g IS NULL)
      OR (food_macro_revision IS NOT NULL AND kcal IS NOT NULL
        AND protein_g IS NOT NULL AND carbs_g IS NOT NULL AND fat_g IS NOT NULL)
    ))
  ),
  CONSTRAINT intake_entries_day_date CHECK (day IS NULL OR (
    length(cast(day as blob)) = 10 AND substr(day, 1, 4) >= '0001'
    AND date(day, '+0 days') IS day
  )),
  CONSTRAINT intake_entries_created_at_utc CHECK (created_at IS NULL OR (
    length(cast(created_at as blob)) = 27 AND substr(created_at, 1, 4) >= '0001'
    AND strftime('%Y-%m-%dT%H:%M:%S', substr(created_at, 1, 19), '+0 seconds') IS substr(created_at, 1, 19)
    AND substr(created_at, 20) GLOB '.[0-9][0-9][0-9][0-9][0-9][0-9]Z'
  )),
  CONSTRAINT intake_entries_request_id_uuid CHECK (request_id IS NULL OR (
    length(cast(request_id as blob)) = 36 AND substr(request_id, 9, 1) = '-' AND substr(request_id, 14, 1) = '-'
    AND substr(request_id, 19, 1) = '-' AND substr(request_id, 24, 1) = '-'
    AND length(replace(request_id, '-', '')) = 32 AND replace(request_id, '-', '') NOT GLOB '*[^0-9a-f]*'
  ))
) STRICT;
-- PostgreSQL NULLS NOT DISTINCT for (request_id, food_id), but only when a
-- request_id exists. Separate indexes retain ad-hoc retry collisions without
-- using a sentinel food id or making null request ids collide.
create unique index intake_entries_request_food_key on intake_entries (request_id, food_id)
  where request_id is not null and food_id is not null;
create unique index intake_entries_request_adhoc_key on intake_entries (request_id)
  where request_id is not null and food_id is null;
create index intake_entries_day_idx on intake_entries (day);
create index intake_entries_food_id_idx on intake_entries (food_id);
create index intake_entries_meal_id_idx on intake_entries (meal_id);

create table day_flags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  day TEXT NOT NULL,
  flag TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now') || '000Z'),
  CONSTRAINT day_flags_flag_check CHECK (flag IN ('incomplete')),
  CONSTRAINT day_flags_day_flag_key UNIQUE (day, flag),
  CONSTRAINT day_flags_day_date CHECK (day IS NULL OR (
    length(cast(day as blob)) = 10 AND substr(day, 1, 4) >= '0001'
    AND date(day, '+0 days') IS day
  )),
  CONSTRAINT day_flags_created_at_utc CHECK (created_at IS NULL OR (
    length(cast(created_at as blob)) = 27 AND substr(created_at, 1, 4) >= '0001'
    AND strftime('%Y-%m-%dT%H:%M:%S', substr(created_at, 1, 19), '+0 seconds') IS substr(created_at, 1, 19)
    AND substr(created_at, 20) GLOB '.[0-9][0-9][0-9][0-9][0-9][0-9]Z'
  ))
) STRICT;

create table bodyfat_estimates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  day TEXT NOT NULL,
  percent INTEGER NOT NULL CHECK (percent BETWEEN -9999 AND 9999),
  method TEXT NOT NULL,
  note TEXT,
  request_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now') || '000Z'),
  CONSTRAINT bodyfat_estimates_method_check CHECK (method IN ('bia', 'dxa', 'caliper', 'visual', 'other')),
  CONSTRAINT bodyfat_estimates_percent_range CHECK (percent > 0 AND percent < 750),
  CONSTRAINT bodyfat_estimates_day_method_key UNIQUE (day, method),
  CONSTRAINT bodyfat_estimates_request_id_key UNIQUE (request_id),
  CONSTRAINT bodyfat_estimates_day_date CHECK (day IS NULL OR (
    length(cast(day as blob)) = 10 AND substr(day, 1, 4) >= '0001'
    AND date(day, '+0 days') IS day
  )),
  CONSTRAINT bodyfat_estimates_created_at_utc CHECK (created_at IS NULL OR (
    length(cast(created_at as blob)) = 27 AND substr(created_at, 1, 4) >= '0001'
    AND strftime('%Y-%m-%dT%H:%M:%S', substr(created_at, 1, 19), '+0 seconds') IS substr(created_at, 1, 19)
    AND substr(created_at, 20) GLOB '.[0-9][0-9][0-9][0-9][0-9][0-9]Z'
  )),
  CONSTRAINT bodyfat_estimates_request_id_uuid CHECK (request_id IS NULL OR (
    length(cast(request_id as blob)) = 36 AND substr(request_id, 9, 1) = '-' AND substr(request_id, 14, 1) = '-'
    AND substr(request_id, 19, 1) = '-' AND substr(request_id, 24, 1) = '-'
    AND length(replace(request_id, '-', '')) = 32 AND replace(request_id, '-', '') NOT GLOB '*[^0-9a-f]*'
  ))
) STRICT;

-- Nutrition plans and independently recorded transients ---------------------
create table nutrition_targets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  effective_from TEXT NOT NULL,
  goal TEXT NOT NULL,
  rate_pct_bw_week INTEGER NOT NULL CHECK (rate_pct_bw_week BETWEEN -9999 AND 9999),
  kcal_target INTEGER NOT NULL CHECK (kcal_target BETWEEN -2147483648 AND 2147483647),
  protein_g_target INTEGER NOT NULL CHECK (protein_g_target BETWEEN -2147483648 AND 2147483647),
  decision TEXT NOT NULL,
  tdee_at_creation INTEGER CHECK (tdee_at_creation BETWEEN -2147483648 AND 2147483647),
  clipped INTEGER NOT NULL DEFAULT 0 CHECK (clipped IN (0, 1)),
  clipped_reasons TEXT NOT NULL DEFAULT '[]',
  request_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now') || '000Z'),
  phase_switch_suppressed INTEGER NOT NULL DEFAULT 0 CHECK (phase_switch_suppressed IN (0, 1)),
  CONSTRAINT nutrition_targets_goal_check CHECK (goal IN ('cut', 'maintain', 'gain', 'recomp')),
  CONSTRAINT nutrition_targets_kcal_positive CHECK (kcal_target > 0),
  CONSTRAINT nutrition_targets_protein_positive CHECK (protein_g_target > 0),
  CONSTRAINT nutrition_targets_rate_sane CHECK (rate_pct_bw_week > -300 AND rate_pct_bw_week < 300),
  CONSTRAINT nutrition_targets_request_id_key UNIQUE (request_id),
  CONSTRAINT nutrition_targets_clipped_reasons_check CHECK (
    CASE WHEN json_valid(clipped_reasons) THEN json_type(clipped_reasons) = 'array' ELSE 0 END
  ),
  CONSTRAINT nutrition_targets_clipped_pair CHECK (
    CASE WHEN json_valid(clipped_reasons) THEN clipped = (json_array_length(clipped_reasons) > 0) ELSE 0 END
  ),
  CONSTRAINT nutrition_targets_effective_from_date CHECK (effective_from IS NULL OR (
    length(cast(effective_from as blob)) = 10 AND substr(effective_from, 1, 4) >= '0001'
    AND date(effective_from, '+0 days') IS effective_from
  )),
  CONSTRAINT nutrition_targets_created_at_utc CHECK (created_at IS NULL OR (
    length(cast(created_at as blob)) = 27 AND substr(created_at, 1, 4) >= '0001'
    AND strftime('%Y-%m-%dT%H:%M:%S', substr(created_at, 1, 19), '+0 seconds') IS substr(created_at, 1, 19)
    AND substr(created_at, 20) GLOB '.[0-9][0-9][0-9][0-9][0-9][0-9]Z'
  )),
  CONSTRAINT nutrition_targets_request_id_uuid CHECK (request_id IS NULL OR (
    length(cast(request_id as blob)) = 36 AND substr(request_id, 9, 1) = '-' AND substr(request_id, 14, 1) = '-'
    AND substr(request_id, 19, 1) = '-' AND substr(request_id, 24, 1) = '-'
    AND length(replace(request_id, '-', '')) = 32 AND replace(request_id, '-', '') NOT GLOB '*[^0-9a-f]*'
  ))
) STRICT;
create index nutrition_targets_effective_from_idx on nutrition_targets (effective_from desc);

-- Preserve the text[] subset check for every element, without bounding list
-- length or forbidding duplicates. Invalid JSON is left to the named CHECK.
-- Hosted D1's statement parser requires uppercase BEGIN/END trigger delimiters.
create trigger nutrition_targets_clipped_reasons_insert
before insert on nutrition_targets
when exists (
  select 1 from json_each(CASE WHEN json_valid(new.clipped_reasons) THEN new.clipped_reasons ELSE '[]' END)
  where type <> 'text' or value not in ('rate', 'deficit', 'recomp_deficit', 'surplus')
)
BEGIN
  select raise(ABORT, 'nutrition_targets_clipped_reasons_check');
END;
create trigger nutrition_targets_clipped_reasons_update
before update of clipped_reasons on nutrition_targets
when exists (
  select 1 from json_each(CASE WHEN json_valid(new.clipped_reasons) THEN new.clipped_reasons ELSE '[]' END)
  where type <> 'text' or value not in ('rate', 'deficit', 'recomp_deficit', 'surplus')
)
BEGIN
  select raise(ABORT, 'nutrition_targets_clipped_reasons_check');
END;

create table nutrition_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  day TEXT NOT NULL,
  kind TEXT NOT NULL,
  note TEXT,
  request_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now') || '000Z'),
  CONSTRAINT nutrition_events_kind_check CHECK (kind IN ('creatine_start', 'phase_switch', 'program_change', 'logging_change', 'other')),
  CONSTRAINT nutrition_events_request_id_key UNIQUE (request_id),
  CONSTRAINT nutrition_events_day_date CHECK (day IS NULL OR (
    length(cast(day as blob)) = 10 AND substr(day, 1, 4) >= '0001'
    AND date(day, '+0 days') IS day
  )),
  CONSTRAINT nutrition_events_created_at_utc CHECK (created_at IS NULL OR (
    length(cast(created_at as blob)) = 27 AND substr(created_at, 1, 4) >= '0001'
    AND strftime('%Y-%m-%dT%H:%M:%S', substr(created_at, 1, 19), '+0 seconds') IS substr(created_at, 1, 19)
    AND substr(created_at, 20) GLOB '.[0-9][0-9][0-9][0-9][0-9][0-9]Z'
  )),
  CONSTRAINT nutrition_events_request_id_uuid CHECK (request_id IS NULL OR (
    length(cast(request_id as blob)) = 36 AND substr(request_id, 9, 1) = '-' AND substr(request_id, 14, 1) = '-'
    AND substr(request_id, 19, 1) = '-' AND substr(request_id, 24, 1) = '-'
    AND length(replace(request_id, '-', '')) = 32 AND replace(request_id, '-', '') NOT GLOB '*[^0-9a-f]*'
  ))
) STRICT;
create index nutrition_events_day_idx on nutrition_events (day desc);

create table week_schedules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  week_start TEXT NOT NULL,
  schedule TEXT NOT NULL,
  written_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now') || '000Z'),
  CONSTRAINT week_schedules_week_start_key UNIQUE (week_start),
  CONSTRAINT week_schedules_starts_on_monday CHECK (strftime('%w', week_start) = '1'),
  CONSTRAINT week_schedules_week_start_date CHECK (week_start IS NULL OR (
    length(cast(week_start as blob)) = 10 AND substr(week_start, 1, 4) >= '0001'
    AND date(week_start, '+0 days') IS week_start
  )),
  CONSTRAINT week_schedules_written_at_utc CHECK (written_at IS NULL OR (
    length(cast(written_at as blob)) = 27 AND substr(written_at, 1, 4) >= '0001'
    AND strftime('%Y-%m-%dT%H:%M:%S', substr(written_at, 1, 19), '+0 seconds') IS substr(written_at, 1, 19)
    AND substr(written_at, 20) GLOB '.[0-9][0-9][0-9][0-9][0-9][0-9]Z'
  ))
) STRICT;

-- INT (not INTEGER PRIMARY KEY) deliberately avoids SQLite's rowid allocator:
-- this singleton has a default id of 1, not a PostgreSQL identity sequence.
create table withings_auth (
  id INT NOT NULL PRIMARY KEY DEFAULT 1,
  withings_user_id TEXT NOT NULL,
  access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  access_token_expires_at TEXT NOT NULL,
  last_sync_at TEXT,
  last_sync_attempt_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now') || '000Z'),
  CONSTRAINT withings_auth_single_row CHECK (id = 1),
  CONSTRAINT withings_auth_access_token_expires_at_utc CHECK (access_token_expires_at IS NULL OR (
    length(cast(access_token_expires_at as blob)) = 27 AND substr(access_token_expires_at, 1, 4) >= '0001'
    AND strftime('%Y-%m-%dT%H:%M:%S', substr(access_token_expires_at, 1, 19), '+0 seconds') IS substr(access_token_expires_at, 1, 19)
    AND substr(access_token_expires_at, 20) GLOB '.[0-9][0-9][0-9][0-9][0-9][0-9]Z'
  )),
  CONSTRAINT withings_auth_last_sync_at_utc CHECK (last_sync_at IS NULL OR (
    length(cast(last_sync_at as blob)) = 27 AND substr(last_sync_at, 1, 4) >= '0001'
    AND strftime('%Y-%m-%dT%H:%M:%S', substr(last_sync_at, 1, 19), '+0 seconds') IS substr(last_sync_at, 1, 19)
    AND substr(last_sync_at, 20) GLOB '.[0-9][0-9][0-9][0-9][0-9][0-9]Z'
  )),
  CONSTRAINT withings_auth_last_sync_attempt_at_utc CHECK (last_sync_attempt_at IS NULL OR (
    length(cast(last_sync_attempt_at as blob)) = 27 AND substr(last_sync_attempt_at, 1, 4) >= '0001'
    AND strftime('%Y-%m-%dT%H:%M:%S', substr(last_sync_attempt_at, 1, 19), '+0 seconds') IS substr(last_sync_attempt_at, 1, 19)
    AND substr(last_sync_attempt_at, 20) GLOB '.[0-9][0-9][0-9][0-9][0-9][0-9]Z'
  )),
  CONSTRAINT withings_auth_updated_at_utc CHECK (updated_at IS NULL OR (
    length(cast(updated_at as blob)) = 27 AND substr(updated_at, 1, 4) >= '0001'
    AND strftime('%Y-%m-%dT%H:%M:%S', substr(updated_at, 1, 19), '+0 seconds') IS substr(updated_at, 1, 19)
    AND substr(updated_at, 20) GLOB '.[0-9][0-9][0-9][0-9][0-9][0-9]Z'
  ))
) STRICT;

-- No membership FK, no cascade, no backfill, no current dose columns elsewhere.
create table mesocycle_exercise_doses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mesocycle_id INTEGER NOT NULL REFERENCES mesocycles (id),
  exercise_id INTEGER NOT NULL REFERENCES exercises (id),
  weekly_dose INTEGER NOT NULL CHECK (weekly_dose BETWEEN -999999 AND 999999),
  weekly_dose_unit TEXT NOT NULL,
  effective_from TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now') || '000Z'),
  CONSTRAINT mesocycle_exercises_weekly_dose_positive CHECK (weekly_dose > 0),
  CONSTRAINT mesocycle_exercises_weekly_dose_unit_check CHECK (weekly_dose_unit IN ('sets', 'minutes', 'km')),
  CONSTRAINT mesocycle_exercise_doses_effective_from_date CHECK (effective_from IS NULL OR (
    length(cast(effective_from as blob)) = 10 AND substr(effective_from, 1, 4) >= '0001'
    AND date(effective_from, '+0 days') IS effective_from
  )),
  CONSTRAINT mesocycle_exercise_doses_created_at_utc CHECK (created_at IS NULL OR (
    length(cast(created_at as blob)) = 27 AND substr(created_at, 1, 4) >= '0001'
    AND strftime('%Y-%m-%dT%H:%M:%S', substr(created_at, 1, 19), '+0 seconds') IS substr(created_at, 1, 19)
    AND substr(created_at, 20) GLOB '.[0-9][0-9][0-9][0-9][0-9][0-9]Z'
  ))
) STRICT;
create index mesocycle_exercise_doses_lookup_idx on mesocycle_exercise_doses (mesocycle_id, exercise_id, effective_from);

create table api_tokens (
  token_hash TEXT NOT NULL PRIMARY KEY,
  subject TEXT NOT NULL,
  issued_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now') || '000Z'),
  expires_at TEXT NOT NULL,
  CONSTRAINT api_tokens_expires_after_issue CHECK (expires_at > issued_at),
  CONSTRAINT api_tokens_issued_at_utc CHECK (issued_at IS NULL OR (
    length(cast(issued_at as blob)) = 27 AND substr(issued_at, 1, 4) >= '0001'
    AND strftime('%Y-%m-%dT%H:%M:%S', substr(issued_at, 1, 19), '+0 seconds') IS substr(issued_at, 1, 19)
    AND substr(issued_at, 20) GLOB '.[0-9][0-9][0-9][0-9][0-9][0-9]Z'
  )),
  CONSTRAINT api_tokens_expires_at_utc CHECK (expires_at IS NULL OR (
    length(cast(expires_at as blob)) = 27 AND substr(expires_at, 1, 4) >= '0001'
    AND strftime('%Y-%m-%dT%H:%M:%S', substr(expires_at, 1, 19), '+0 seconds') IS substr(expires_at, 1, 19)
    AND substr(expires_at, 20) GLOB '.[0-9][0-9][0-9][0-9][0-9][0-9]Z'
  ))
) STRICT;

-- Views: values exposed here are PUBLIC UNITS, not the scaled storage integers.
-- The set_performed SQL function becomes the identical three-limb predicate.
-- IMPORTANT: ALL WEEKS. Readers MUST apply the completed-week cutoff in
-- TypeScript using Europe/Rome. This view must never infer Rome from UTC now.
create view weekly_volume as
select
  date(s.date, '-' || ((cast(strftime('%w', s.date) as integer) + 6) % 7) || ' days') as week_start,
  m.name as muscle,
  sum(em.volume_factor) / 10.0 as working_sets,
  t.mesocycle_id
from sets t
join sessions s on s.id = t.session_id
join exercises e on e.id = t.exercise_id
join exercise_muscles em on em.exercise_id = e.id and em.volume_factor > 0
join muscles m on m.id = em.muscle_id
where t.kind = 'working'
  and (t.reps is not null or t.distance_m is not null or t.duration_s is not null)
  and e.stimulus_type = 'strength'
group by 1, 2, 4;

-- IMPORTANT: ALL WEEKS, including current/future weeks. The API filters completed
-- Rome weeks in TypeScript using the mesocycle's Monday start and this week index.
-- Integer division truncates toward zero, matching PostgreSQL even before start.
-- No stimulus filter and no current-membership join: removed exercises retain
-- delivered history, and speed/endurance work remains visible.
create view weekly_exercise_sets_done as
select
  t.mesocycle_id,
  t.exercise_id,
  cast(julianday(s.date) - julianday(mc.started_on) as integer) / 7 + 1 as week,
  count(*) as sets_done,
  sum(t.distance_m) / 10.0 as distance_m,
  sum(t.duration_s) / 100.0 as duration_s
from sets t
join sessions s on s.id = t.session_id
join mesocycles mc on mc.id = t.mesocycle_id
where t.kind = 'working'
  and (t.reps is not null or t.distance_m is not null or t.duration_s is not null)
group by 1, 2, 3;

create view daily_bodyweight as
select day, value_kg / 100.0 as value_kg, measured_at
from (
  select measured_date as day, value_kg, measured_at,
    row_number() over (partition by measured_date order by measured_at, id) as position
  from bodyweight
)
where position = 1;

-- Both operands use tenths; their product / 1000 is a macro in tenths.
-- All operands are nonnegative, so (product + 500) / 1000 implements PostgreSQL
-- numeric round(..., 1) exactly (half away from zero), before / 10.0 unscales.
-- Products stay below 10^13 with the declared bounds: no INTEGER overflow or
-- floating-point rounding at the half boundary. Unknown fiber remains NULL.
create view intake_values as
select i.id, i.day, i.food_id, i.grams / 10.0 as grams, i.meal_id,
  case when i.food_id is null or i.food_macro_revision = f.macro_revision then i.kcal / 10.0
    else ((f.kcal_100g * i.grams + 500) / 1000) / 10.0 end as kcal,
  case when i.food_id is null or i.food_macro_revision = f.macro_revision then i.protein_g / 10.0
    else ((f.protein_100g * i.grams + 500) / 1000) / 10.0 end as protein_g,
  case when i.food_id is null or i.food_macro_revision = f.macro_revision then i.carbs_g / 10.0
    else ((f.carbs_100g * i.grams + 500) / 1000) / 10.0 end as carbs_g,
  case when i.food_id is null or i.food_macro_revision = f.macro_revision then i.fat_g / 10.0
    else ((f.fat_100g * i.grams + 500) / 1000) / 10.0 end as fat_g,
  case when i.food_id is null or i.food_macro_revision = f.macro_revision then i.fiber_g / 10.0
    else ((f.fiber_100g * i.grams + 500) / 1000) / 10.0 end as fiber_g,
  i.note, i.request_id, i.created_at
from intake_entries i left join foods f on f.id = i.food_id;

-- Flags without entries remain present with NULL totals, not fictitious zeros.
-- intake_values exposes public REAL values. Recover each exact integer tenth
-- before summing, then unscale once, matching PostgreSQL's decimal sum before
-- its float8 cast (0.1 + 0.2 must yield 0.3, not 0.30000000000000004).
-- The per-entry bounds keep this round-trip safely below 2^53.
create view daily_intake as
select d.day,
  sum(cast(round(i.kcal * 10) as integer)) / 10.0 as kcal,
  sum(cast(round(i.protein_g * 10) as integer)) / 10.0 as protein_g,
  count(i.id) as entries,
  exists (select 1 from day_flags f where f.day = d.day and f.flag = 'incomplete') as incomplete,
  count(i.protein_g) as protein_entries
from (select day from intake_entries union select day from day_flags) d
left join intake_values i on i.day = d.day
group by d.day;

-- Choose each date's highest id BEFORE lag; filter suppression AFTER lag.
-- A dismissed switch still governs the following day's predecessor. Caller
-- window filters must be outside this full-history comparison.
create view nutrition_goal_switches as
with ranked_targets as (
  select id, effective_from, goal, created_at, phase_switch_suppressed,
    row_number() over (partition by effective_from order by id desc) as position
  from nutrition_targets
), effective_targets as (
  select id, effective_from, goal, created_at, phase_switch_suppressed
  from ranked_targets where position = 1
), transitions as (
  select *, lag(goal) over (order by effective_from) as previous_goal
  from effective_targets
)
select -id as id, effective_from as day, 'phase_switch' as kind,
  previous_goal || ' -> ' || goal as note, created_at
from transitions
where previous_goal is not null and previous_goal <> goal
  and not phase_switch_suppressed;

-- Negative target ids identify automatic events; positive recorded ids remain
-- independent. Never guess legacy provenance or deduplicate these facts.
create view nutrition_effective_events as
select id, day, kind, note, created_at from nutrition_events
union all
select id, day, kind, note, created_at from nutrition_goal_switches;
