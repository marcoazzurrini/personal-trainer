import type { Client } from "../../client.ts";
import { statement } from "../../native.ts";
import type { Parameter } from "../../native.ts";

// These assertions must share the atomic batch with the guarded changes.
export const beginNutritionWrite = (db: Client) =>
  statement(db, "INSERT INTO nutrition_write_assertions (id) VALUES (1)");
export const finishNutritionWrite = (db: Client) =>
  statement(db, "DELETE FROM nutrition_write_assertions WHERE id = 1");
export const nutritionRows = (db: Client, count: number) =>
  statement(
    db,
    "UPDATE nutrition_write_assertions SET valid = (changes() = ?) WHERE id = 1",
    count
  );
export const nutritionCheck = (
  db: Client,
  predicate: string,
  ...values: Parameter[]
) =>
  statement(
    db,
    `UPDATE nutrition_write_assertions SET valid = (${predicate}) WHERE id = 1`,
    ...values
  );
