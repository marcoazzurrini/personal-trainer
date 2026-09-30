import type { D1PreparedStatement } from "@cloudflare/workers-types";

import type { Client } from "./client.ts";
import { classifyDatabaseFailure } from "./errors.ts";

export type Parameter = string | number | null;
export type Statement = D1PreparedStatement;
export interface StoredRow {
  [column: string]: Parameter | ArrayBuffer;
}

/** Escape hatch for reviewed SQLite queries that the typed builder cannot express clearly. */
export function statement(
  db: Client,
  text: string,
  ...values: Parameter[]
): Statement {
  return db.$client.prepare(text).bind(...values);
}

export async function rows<T>(
  db: Client,
  text: string,
  ...values: Parameter[]
): Promise<T[]> {
  try {
    return (await statement(db, text, ...values).all<T>()).results;
  } catch (error) {
    throw classifyDatabaseFailure(error);
  }
}

/** Keep native assertion statements adjacent to the writes whose changes() they inspect. */
export async function batch<T = StoredRow>(
  db: Client,
  statements: Statement[]
) {
  try {
    return await db.$client.batch<T>(statements);
  } catch (error) {
    throw classifyDatabaseFailure(error);
  }
}
