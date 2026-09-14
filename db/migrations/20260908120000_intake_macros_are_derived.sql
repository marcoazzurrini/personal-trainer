-- The record of eating is the food and grams, not a copy of its label.
-- Explicit per-entry overrides still expire when the food's macros are
-- corrected, matching the former blanket historical correction policy.
alter table foods add column macro_revision bigint not null default 0
  check (macro_revision >= 0);
alter table intake_entries add column food_macro_revision bigint
  check (food_macro_revision >= 0);
alter table intake_entries alter column kcal drop not null;
alter table intake_entries drop constraint intake_entries_food_macros_complete;
alter table intake_entries add constraint intake_entries_macro_shape check (
  (food_id is null and kcal is not null and food_macro_revision is null)
  or (food_id is not null and (
    (food_macro_revision is null and kcal is null and protein_g is null
      and carbs_g is null and fat_g is null and fiber_g is null)
    or (food_macro_revision is not null and kcal is not null
      and protein_g is not null and carbs_g is not null and fat_g is not null)
  ))
) not valid;

-- Retain historical differences as complete overrides, including unknown
-- fiber. We cannot know whether a difference was deliberate, so never discard
-- it. Equal snapshots need no stored copy. Ad-hoc estimates stay untouched.
update intake_entries i set food_macro_revision = f.macro_revision
from foods f where f.id = i.food_id and (
  i.kcal is distinct from round(f.kcal_100g * i.grams / 100, 1)
  or i.protein_g is distinct from round(f.protein_100g * i.grams / 100, 1)
  or i.carbs_g is distinct from round(f.carbs_100g * i.grams / 100, 1)
  or i.fat_g is distinct from round(f.fat_100g * i.grams / 100, 1)
  or i.fiber_g is distinct from round(f.fiber_100g * i.grams / 100, 1)
);
update intake_entries set kcal = null, protein_g = null, carbs_g = null,
  fat_g = null, fiber_g = null
where food_id is not null and food_macro_revision is null;
alter table intake_entries validate constraint intake_entries_macro_shape;

-- All intake readers share this calculation, including expenditure and
-- weekly protein coverage through daily_intake. Null fiber remains unknown.
create view intake_values with (security_invoker = on) as
select i.id, i.day, i.food_id, i.grams, i.meal_id,
  case when i.food_id is null or i.food_macro_revision = f.macro_revision then i.kcal
    else round(f.kcal_100g * i.grams / 100, 1) end as kcal,
  case when i.food_id is null or i.food_macro_revision = f.macro_revision then i.protein_g
    else round(f.protein_100g * i.grams / 100, 1) end as protein_g,
  case when i.food_id is null or i.food_macro_revision = f.macro_revision then i.carbs_g
    else round(f.carbs_100g * i.grams / 100, 1) end as carbs_g,
  case when i.food_id is null or i.food_macro_revision = f.macro_revision then i.fat_g
    else round(f.fat_100g * i.grams / 100, 1) end as fat_g,
  case when i.food_id is null or i.food_macro_revision = f.macro_revision then i.fiber_g
    else round(f.fiber_100g * i.grams / 100, 1) end as fiber_g,
  i.note, i.request_id, i.created_at
from intake_entries i left join foods f on f.id = i.food_id;

create or replace view daily_intake with (security_invoker = on) as
select d.day,
  sum(i.kcal)::float8 as kcal,
  sum(i.protein_g)::float8 as protein_g,
  count(i.id)::int as entries,
  exists (select 1 from day_flags f where f.day = d.day and f.flag = 'incomplete') as incomplete,
  count(i.protein_g)::int as protein_entries
from (select day from intake_entries union select day from day_flags) d
left join intake_values i on i.day = d.day
group by d.day;

comment on column intake_entries.kcal is
  'Ad-hoc calories, or part of an explicit food-backed override. Ordinary food entries derive macros in intake_values.';
comment on column intake_entries.food_macro_revision is
  'Food revision to which an explicit override applies. A food correction invalidates old overrides without rewriting intake.';
