-- Aliases and muscle classifications belong to their registry entry. A single
-- parent DELETE removes these auxiliaries atomically. References from sets,
-- plans, dose history, intake_entries and meal_items keep their existing
-- restrictions: deleting a registry entry must never delete its history or
-- silently remove a food from a meal.
alter table food_aliases
  drop constraint food_aliases_food_id_fkey,
  add constraint food_aliases_food_id_fkey
    foreign key (food_id) references foods (id) on delete cascade;

alter table exercise_aliases
  drop constraint exercise_aliases_exercise_id_fkey,
  add constraint exercise_aliases_exercise_id_fkey
    foreign key (exercise_id) references exercises (id) on delete cascade;

alter table exercise_muscles
  drop constraint exercise_muscles_exercise_id_fkey,
  add constraint exercise_muscles_exercise_id_fkey
    foreign key (exercise_id) references exercises (id) on delete cascade;
