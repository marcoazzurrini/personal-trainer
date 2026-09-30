import { asc, eq, sql } from "drizzle-orm";

import type { Client } from "../../client.ts";
import { classifyDatabaseFailure } from "../../errors.ts";
import { batch, rows, statement } from "../../native.ts";
import type { Parameter } from "../../native.ts";
import { foods, intake_entries } from "../../schema/index.ts";
import { scaledInteger } from "../../storage.ts";
import {
  beginNutritionWrite,
  finishNutritionWrite,
  nutritionCheck,
  nutritionRows,
} from "./write.ts";

export interface IntakeRecord {
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

export interface IntakeDay {
  entries: IntakeRecord[];
  flags: string[];
}

type Macro = "kcal" | "protein_g" | "carbs_g" | "fat_g" | "fiber_g";
const MACROS: readonly Macro[] = [
  "kcal",
  "protein_g",
  "carbs_g",
  "fat_g",
  "fiber_g",
];
const per100g = {
  kcal: "kcal_100g",
  protein_g: "protein_100g",
  carbs_g: "carbs_100g",
  fat_g: "fat_100g",
  fiber_g: "fiber_100g",
};

type IntakeResult =
  | IntakeRecord
  | { flag: string }
  | { day: string }
  | { id: number };
type Results = Awaited<ReturnType<typeof batch<IntakeResult>>>;

function dayResult(result: Results): IntakeDay {
  // SAFETY: dayReads selects intake records followed by flags; callers pass only that pair.
  const entries = result[0].results as IntakeRecord[];
  // SAFETY: the second dayReads statement selects only flags.
  const flags = result[1].results as { flag: string }[];
  return { entries, flags: flags.map((row) => row.flag) };
}

export type LogIntake = {
  day: string;
  note: string | null;
  requestId: string;
  createdAt: string;
} & (
  | { kind: "adhoc"; kcal: number; protein: number | null }
  | { kind: "meal"; mealId: number; scale: number }
  | {
      kind: "food";
      foodId: number;
      grams: number;
      // Omission means the caller supplied grams, not units.
      gramsPerUnit?: number | null;
    }
);

export interface CorrectIntake {
  note?: string | null;
  day: string | null;
  grams: number | null;
  macros: Partial<Record<Macro, number>>;
  foodBacked: boolean;
}

export function intakeRepository(db: Client) {
  function dayReads(day: string, byEntry = false) {
    const on = byEntry ? "(SELECT day FROM intake_entries WHERE id = ?)" : "?";
    return [
      statement(
        db,
        `SELECT i.id, i.day, i.grams, i.kcal, i.protein_g, i.carbs_g, i.fat_g, i.fiber_g, i.note,
      i.created_at, i.food_id, f.name AS food, i.meal_id, m.name AS meal
      FROM intake_values i LEFT JOIN foods f ON f.id = i.food_id LEFT JOIN meals m ON m.id = i.meal_id
      WHERE i.day = ${on} ORDER BY i.created_at, i.id`,
        day
      ),
      statement(
        db,
        `SELECT flag FROM day_flags WHERE day = ${on} ORDER BY flag`,
        day
      ),
    ];
  }

  async function readDay(on: string): Promise<IntakeDay> {
    return dayResult(await batch<IntakeResult>(db, dayReads(on)));
  }

  async function requestDay(uuid: string) {
    try {
      const [record] = await db
        .select({ day: intake_entries.day })
        .from(intake_entries)
        .where(eq(intake_entries.request_id, uuid))
        .orderBy(asc(intake_entries.id))
        .limit(1);
      return record?.day;
    } catch (error) {
      throw classifyDatabaseFailure(error);
    }
  }

  function meal(id: number) {
    return rows<{ name: string; items: number }>(
      db,
      "SELECT name, (SELECT count(*) FROM meal_items WHERE meal_id = m.id) AS items FROM meals m WHERE id = ?",
      id
    );
  }

  async function food(id: number) {
    try {
      return await db
        .select({
          name: foods.name,
          grams_per_unit: sql<number | null>`${foods.grams_per_unit} / 10.0`,
        })
        .from(foods)
        .where(eq(foods.id, id));
    } catch (error) {
      throw classifyDatabaseFailure(error);
    }
  }

  async function entry(id: number) {
    try {
      return await db
        .select({ day: intake_entries.day, food_id: intake_entries.food_id })
        .from(intake_entries)
        .where(eq(intake_entries.id, id));
    } catch (error) {
      throw classifyDatabaseFailure(error);
    }
  }

  async function log(input: LogIntake): Promise<IntakeDay> {
    const writes = [
      beginNutritionWrite(db),
      nutritionCheck(
        db,
        "NOT EXISTS (SELECT 1 FROM intake_entries WHERE request_id = ?)",
        input.requestId
      ),
    ];
    if (input.kind === "adhoc") {
      writes.push(
        statement(
          db,
          "INSERT INTO intake_entries (day, kcal, protein_g, note, request_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
          input.day,
          scaledInteger(input.kcal, 7, 1),
          input.protein === null ? null : scaledInteger(input.protein, 6, 1),
          input.note,
          input.requestId,
          input.createdAt
        ),
        nutritionRows(db, 1)
      );
    } else if (input.kind === "meal") {
      // Read the recipe inside the write. Match Math.round(grams * scale * 10),
      // including floating-point ties, without taking a stale recipe snapshot.
      writes.push(
        statement(
          db,
          `WITH portions AS (
          SELECT id, food_id, meal_id, grams / 10.0 * ? * 10 AS amount FROM meal_items WHERE meal_id = ?
        ) INSERT INTO intake_entries (day, food_id, grams, meal_id, note, request_id, created_at)
          SELECT ?, food_id, CAST(amount AS INTEGER) + (amount - CAST(amount AS INTEGER) >= 0.5), meal_id, ?, ?, ?
          FROM portions ORDER BY id`,
          input.scale,
          input.mealId,
          input.day,
          input.note,
          input.requestId,
          input.createdAt
        ),
        nutritionCheck(db, "changes() > 0")
      );
    } else {
      if (input.gramsPerUnit !== undefined) {
        writes.push(
          nutritionCheck(
            db,
            "EXISTS (SELECT 1 FROM foods WHERE id = ? AND grams_per_unit IS ?)",
            input.foodId,
            input.gramsPerUnit === null
              ? null
              : scaledInteger(input.gramsPerUnit, 6, 1)
          )
        );
      }
      writes.push(
        statement(
          db,
          "INSERT INTO intake_entries (day, food_id, grams, note, request_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
          input.day,
          input.foodId,
          scaledInteger(input.grams, 7, 1),
          input.note,
          input.requestId,
          input.createdAt
        ),
        nutritionRows(db, 1)
      );
    }
    const result = await batch<IntakeResult>(db, [
      ...writes,
      ...dayReads(input.day),
      finishNutritionWrite(db),
    ]);
    return dayResult(result.slice(-3, -1));
  }

  async function correct(id: number, input: CorrectIntake) {
    const updates: string[] = [];
    const values: Parameter[] = [];
    const set = (key: string, value: Parameter) => {
      updates.push(`${key} = ?`);
      values.push(value);
    };
    if (input.note !== undefined) {
      set("note", input.note);
    }
    if (input.day !== null) {
      set("day", input.day);
    }
    if (input.grams !== null) {
      set("grams", scaledInteger(input.grams, 7, 1));
      updates.push(
        "food_macro_revision = NULL",
        ...MACROS.map((m) => `${m} = NULL`)
      );
    }
    const overrides = Object.keys(input.macros).length > 0;
    for (const macro of MACROS) {
      const value = input.macros[macro];
      if (value !== undefined) {
        set(macro, scaledInteger(value, macro === "kcal" ? 7 : 6, 1));
      } else if (input.foodBacked && overrides) {
        updates.push(`${macro} = CASE
        WHEN i.food_macro_revision = (SELECT macro_revision FROM foods WHERE id = i.food_id) THEN i.${macro}
        ELSE (SELECT (${per100g[macro]} * i.grams + 500) / 1000 FROM foods WHERE id = i.food_id) END`);
      }
    }
    if (input.foodBacked && overrides) {
      updates.push(
        "food_macro_revision = (SELECT macro_revision FROM foods WHERE id = i.food_id)"
      );
    }
    const result = await batch<IntakeResult>(db, [
      beginNutritionWrite(db),
      statement(db, "SELECT day FROM intake_entries WHERE id = ?", id),
      statement(
        db,
        `UPDATE intake_entries AS i SET ${updates.join(", ")} WHERE id = ? RETURNING day`,
        ...values,
        id
      ),
      nutritionRows(db, 1),
      ...dayReads(String(id), true),
      finishNutritionWrite(db),
    ]);
    // SAFETY: the adjacent assertion requires one update; statements 1 and 2 return its old and new day.
    const { day: previous } = result[1].results[0] as { day: string };
    // SAFETY: statement 2 returns the updated day and its adjacent assertion requires one row.
    const { day: landed } = result[2].results[0] as { day: string };
    return { previous, landed, day: dayResult(result.slice(-3, -1)) };
  }

  async function remove(id: number) {
    try {
      return await db
        .delete(intake_entries)
        .where(eq(intake_entries.id, id))
        .returning({ day: intake_entries.day });
    } catch (error) {
      throw classifyDatabaseFailure(error);
    }
  }

  async function addFlag(
    day: string,
    flag: string,
    createdAt: string
  ): Promise<IntakeDay> {
    const result = await batch<IntakeResult>(db, [
      statement(
        db,
        "INSERT INTO day_flags (day, flag, created_at) VALUES (?, ?, ?) ON CONFLICT (day, flag) DO NOTHING",
        day,
        flag,
        createdAt
      ),
      ...dayReads(day),
    ]);
    return dayResult(result.slice(-2));
  }

  async function unflag(day: string, flag: string) {
    const result = await batch<IntakeResult>(db, [
      statement(
        db,
        "DELETE FROM day_flags WHERE day = ? AND flag = ? RETURNING id",
        day,
        flag
      ),
      ...dayReads(day),
    ]);
    return {
      removed: result[0].results.length > 0,
      day: dayResult(result.slice(-2)),
    };
  }

  return {
    day: readDay,
    requestDay,
    meal,
    food,
    entry,
    log,
    correct,
    remove,
    flag: addFlag,
    unflag,
  };
}

export type IntakeRepository = ReturnType<typeof intakeRepository>;
