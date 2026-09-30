import { asc, eq, gte, sql } from "drizzle-orm";

import type { Client } from "../../client.ts";
import { classifyDatabaseFailure } from "../../errors.ts";
import { rows } from "../../native.ts";
import { day_flags, foods, intake_values, meals } from "../../schema/index.ts";
import { targetsRepository } from "./targets.ts";

export interface StateIntakeRecord {
  id: number;
  day: string;
  grams: number | null;
  kcal: number;
  protein_g: number | null;
  carbs_g: number | null;
  fat_g: number | null;
  fiber_g: number | null;
  note: string | null;
  created_at: string;
  food_id: number | null;
  food: string | null;
  meal_id: number | null;
  meal: string | null;
}

export interface RecentDayRecord {
  day: string;
  kcal: number | null;
  protein_g: number | null;
  entries: number;
  incomplete: number;
  weight_kg: number | null;
}

export interface AdherenceRecord {
  days_logged_last_7: number;
  days_logged_last_21: number;
  weigh_ins_last_7: number;
  weigh_ins_last_21: number;
  last_logged_day: string | null;
  last_weigh_in: string | null;
}

export function stateRepository(db: Client) {
  async function entries(day: string): Promise<StateIntakeRecord[]> {
    try {
      // Labels and macros come from the live view, including invalidated overrides.
      return await db
        .select({
          id: intake_values.id,
          day: intake_values.day,
          grams: intake_values.grams,
          // Each valid intake entry has either explicit or food-derived calories.
          kcal: sql<number>`${intake_values.kcal}`,
          protein_g: intake_values.protein_g,
          carbs_g: intake_values.carbs_g,
          fat_g: intake_values.fat_g,
          fiber_g: intake_values.fiber_g,
          note: intake_values.note,
          created_at: intake_values.created_at,
          food_id: intake_values.food_id,
          food: foods.name,
          meal_id: intake_values.meal_id,
          meal: meals.name,
        })
        .from(intake_values)
        .leftJoin(foods, eq(foods.id, intake_values.food_id))
        .leftJoin(meals, eq(meals.id, intake_values.meal_id))
        .where(eq(intake_values.day, day))
        .orderBy(asc(intake_values.created_at), asc(intake_values.id));
    } catch (error) {
      throw classifyDatabaseFailure(error);
    }
  }

  async function recentDays(
    from: string,
    to: string
  ): Promise<RecentDayRecord[]> {
    return await rows<RecentDayRecord>(
      db,
      `
      WITH RECURSIVE days(day) AS (
        SELECT ? UNION ALL SELECT date(day, '+1 day') FROM days WHERE day < ?
      )
      SELECT d.day, i.kcal, i.protein_g, coalesce(i.entries, 0) AS entries,
        coalesce(i.incomplete, 0) AS incomplete, b.value_kg AS weight_kg
      FROM days d LEFT JOIN daily_intake i ON i.day = d.day
      LEFT JOIN daily_bodyweight b ON b.day = d.day ORDER BY d.day`,
      from,
      to
    );
  }

  async function adherence(bounds: {
    today: string;
    loggedFrom7: string;
    loggedFrom21: string;
    weighedFrom7: string;
    weighedFrom21: string;
  }): Promise<AdherenceRecord> {
    const [record] = await rows<AdherenceRecord>(
      db,
      `
      SELECT
        (SELECT count(*) FROM daily_intake WHERE day >= ? AND day < ? AND entries > 0) AS days_logged_last_7,
        (SELECT count(*) FROM daily_intake WHERE day >= ? AND day < ? AND entries > 0) AS days_logged_last_21,
        (SELECT count(*) FROM daily_bodyweight WHERE day >= ? AND day <= ?) AS weigh_ins_last_7,
        (SELECT count(*) FROM daily_bodyweight WHERE day >= ? AND day <= ?) AS weigh_ins_last_21,
        (SELECT max(day) FROM daily_intake WHERE day < ? AND entries > 0) AS last_logged_day,
        (SELECT max(day) FROM daily_bodyweight) AS last_weigh_in`,
      bounds.loggedFrom7,
      bounds.today,
      bounds.loggedFrom21,
      bounds.today,
      bounds.weighedFrom7,
      bounds.today,
      bounds.weighedFrom21,
      bounds.today,
      bounds.today
    );
    return record;
  }

  async function flags(from: string): Promise<{ day: string; flag: string }[]> {
    try {
      return await db
        .select({ day: day_flags.day, flag: day_flags.flag })
        .from(day_flags)
        .where(gte(day_flags.day, from))
        .orderBy(asc(day_flags.day));
    } catch (error) {
      throw classifyDatabaseFailure(error);
    }
  }

  const targets = targetsRepository(db);
  return {
    entries,
    recentDays,
    adherence,
    flags,
    targets,
    expenditure: targets.expenditure,
  };
}

export type StateRepository = ReturnType<typeof stateRepository>;
