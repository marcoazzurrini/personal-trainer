import { and, asc, desc, eq, notExists, sql } from "drizzle-orm";

import type { Client } from "../client.ts";
import { classifyDatabaseFailure } from "../errors.ts";
import { bodyfat_estimates } from "../schema/index.ts";
import { scaledInteger } from "../storage.ts";

const measurement = {
  id: bodyfat_estimates.id,
  day: bodyfat_estimates.day,
  percent: sql<number>`${bodyfat_estimates.percent} / 10.0`,
  method: bodyfat_estimates.method,
  note: bodyfat_estimates.note,
  created_at: bodyfat_estimates.created_at,
};

export interface BodyfatMeasurement {
  id: number;
  day: string;
  percent: number;
  method: string;
  note: string | null;
  created_at: string;
}

export type SaveBodyfatResult =
  | { kind: "created" | "replayed" | "conflict"; row: BodyfatMeasurement }
  | { kind: "missing" };

export function bodyfatRepository(db: Client) {
  async function findByDayMethod(
    day: string,
    method: string
  ): Promise<BodyfatMeasurement | undefined> {
    try {
      const rows = await db
        .select(measurement)
        .from(bodyfat_estimates)
        .where(
          and(
            eq(bodyfat_estimates.day, day),
            eq(bodyfat_estimates.method, method)
          )
        );
      return rows[0];
    } catch (error) {
      throw classifyDatabaseFailure(error);
    }
  }

  async function save(input: {
    day: string;
    percent: number;
    method: string;
    note: string | null;
    requestId: string;
    createdAt: string;
  }): Promise<SaveBodyfatResult> {
    const value = scaledInteger(input.percent, 4, 1);
    const naturalKey = and(
      eq(bodyfat_estimates.day, input.day),
      eq(bodyfat_estimates.method, input.method)
    );
    const replayKey = eq(bodyfat_estimates.request_id, input.requestId);
    try {
      // Read precedence and insertion share one transaction. The conditional
      // insert also skips value constraints on a request-id replay, as before.
      const [existing, seen, inserted] = await db.batch([
        db
          .select({ ...measurement, stored_value: bodyfat_estimates.percent })
          .from(bodyfat_estimates)
          .where(naturalKey),
        db.select(measurement).from(bodyfat_estimates).where(replayKey),
        db
          .insert(bodyfat_estimates)
          .select(
            db
              .select({
                id: sql<number>`null`.as("id"),
                day: sql<string>`${input.day}`.as("day"),
                percent: sql<number>`${value}`.as("percent"),
                method: sql<string>`${input.method}`.as("method"),
                note: sql<string | null>`${input.note}`.as("note"),
                request_id: sql<string>`${input.requestId}`.as("request_id"),
                created_at: sql<string>`${input.createdAt}`.as("created_at"),
              })
              .from(sql`(select 1)`)
              .where(
                and(
                  notExists(
                    db
                      .select({ id: bodyfat_estimates.id })
                      .from(bodyfat_estimates)
                      .where(naturalKey)
                  ),
                  notExists(
                    db
                      .select({ id: bodyfat_estimates.id })
                      .from(bodyfat_estimates)
                      .where(replayKey)
                  )
                )
              )
          )
          .returning(measurement),
      ]);
      if (existing.length) {
        const [{ stored_value, ...row }] = existing;
        return { kind: stored_value === value ? "replayed" : "conflict", row };
      }
      if (seen.length) {
        return { kind: "replayed", row: seen[0] };
      }
      return inserted.length
        ? { kind: "created", row: inserted[0] }
        : { kind: "missing" };
    } catch (error) {
      throw classifyDatabaseFailure(error);
    }
  }

  async function list(): Promise<BodyfatMeasurement[]> {
    try {
      return await db
        .select(measurement)
        .from(bodyfat_estimates)
        .orderBy(asc(bodyfat_estimates.day), asc(bodyfat_estimates.method));
    } catch (error) {
      throw classifyDatabaseFailure(error);
    }
  }

  async function latest(): Promise<BodyfatMeasurement | null> {
    try {
      const rows = await db
        .select(measurement)
        .from(bodyfat_estimates)
        .orderBy(desc(bodyfat_estimates.day), desc(bodyfat_estimates.id))
        .limit(1);
      return rows[0] ?? null;
    } catch (error) {
      throw classifyDatabaseFailure(error);
    }
  }

  async function remove(
    id: number
  ): Promise<
    Pick<BodyfatMeasurement, "day" | "percent" | "method"> | undefined
  > {
    try {
      const rows = await db
        .delete(bodyfat_estimates)
        .where(eq(bodyfat_estimates.id, id))
        .returning({
          day: measurement.day,
          percent: measurement.percent,
          method: measurement.method,
        });
      return rows[0];
    } catch (error) {
      throw classifyDatabaseFailure(error);
    }
  }

  return { findByDayMethod, save, list, latest, remove };
}

export type BodyfatRepository = ReturnType<typeof bodyfatRepository>;
