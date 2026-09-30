import { and, asc, eq, sql } from "drizzle-orm";

import type { Client } from "../client.ts";
import { classifyDatabaseFailure } from "../errors.ts";
import {
  api_write_assertions,
  bodyweight,
  daily_bodyweight,
  withings_auth,
} from "../schema/index.ts";
import { romeDate, scaledInteger } from "../storage.ts";

const measurement = {
  id: bodyweight.id,
  value_kg: sql<number>`${bodyweight.value_kg} / 100.0`,
  measured_at: bodyweight.measured_at,
  source: bodyweight.source,
};

export interface BodyweightMeasurement {
  id: number;
  value_kg: number;
  measured_at: string;
  source: string;
}

export type SaveBodyweightResult =
  | { kind: "created" | "replayed" | "conflict"; row: BodyweightMeasurement }
  | { kind: "missing" };

export function bodyweightRepository(db: Client, withingsUserId?: string) {
  async function save(input: {
    valueKg: number;
    measuredAt: string;
    source: string;
  }): Promise<SaveBodyweightResult> {
    const value = scaledInteger(input.valueKg, 5, 2);
    try {
      // Both statements share one D1 transaction. A concurrent deletion cannot
      // slip between a duplicate insertion and its readback.
      const insert = db
        .insert(bodyweight)
        .values({
          value_kg: value,
          measured_at: input.measuredAt,
          measured_date: romeDate(input.measuredAt),
          source: input.source,
        })
        .onConflictDoNothing({
          target: [bodyweight.measured_at, bodyweight.source],
        })
        .returning(measurement);
      const read = db
        .select({ ...measurement, stored_value: bodyweight.value_kg })
        .from(bodyweight)
        .where(
          and(
            eq(bodyweight.measured_at, input.measuredAt),
            eq(bodyweight.source, input.source)
          )
        );
      const persist = async () => {
        if (withingsUserId === undefined) {
          return await db.batch([insert, read]);
        }
        const [, insertedRows, existingRows] = await db.batch([
          db.insert(api_write_assertions).values({
            id: 1,
            rows_match: sql`exists (select 1 from ${withings_auth} where ${withings_auth.id} = 1 and ${withings_auth.withings_user_id} = ${withingsUserId})`,
          }),
          insert,
          read,
          db.delete(api_write_assertions).where(eq(api_write_assertions.id, 1)),
        ]);
        return [insertedRows, existingRows] as const;
      };
      const [[inserted], [existing]] = await persist();
      if (inserted) {
        return { kind: "created", row: inserted };
      }
      if (!existing) {
        return { kind: "missing" };
      }
      const { stored_value, ...row } = existing;
      return { kind: stored_value === value ? "replayed" : "conflict", row };
    } catch (error) {
      throw classifyDatabaseFailure(error);
    }
  }

  async function list(): Promise<BodyweightMeasurement[]> {
    try {
      return await db
        .select(measurement)
        .from(bodyweight)
        .orderBy(asc(bodyweight.measured_at), asc(bodyweight.id));
    } catch (error) {
      throw classifyDatabaseFailure(error);
    }
  }

  async function dailyMeasurements(): Promise<
    { day: string; value_kg: number }[]
  > {
    try {
      // The SQL-managed view projects two non-null bodyweight columns and
      // divides an integer by a nonzero literal; neither expression is nullable.
      return await db
        .select({
          day: sql<string>`${daily_bodyweight.day}`,
          value_kg: sql<number>`${daily_bodyweight.value_kg}`,
        })
        .from(daily_bodyweight)
        .orderBy(asc(daily_bodyweight.day));
    } catch (error) {
      throw classifyDatabaseFailure(error);
    }
  }

  async function remove(
    id: number
  ): Promise<BodyweightMeasurement | undefined> {
    try {
      const result = await db
        .delete(bodyweight)
        .where(eq(bodyweight.id, id))
        .returning(measurement);
      return result[0];
    } catch (error) {
      throw classifyDatabaseFailure(error);
    }
  }

  return { save, list, dailyMeasurements, remove };
}

export type BodyweightRepository = ReturnType<typeof bodyweightRepository>;
