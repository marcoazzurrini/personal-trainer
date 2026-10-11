import { and, asc, desc, gte, lte, sql } from "drizzle-orm";

import type { Client } from "../../client.ts";
import { classifyDatabaseFailure } from "../../errors.ts";
import {
  daily_intake,
  nutrition_effective_events,
} from "../../schema/index.ts";

export type TransientKind =
  | "creatine_start"
  | "phase_switch"
  | "program_change"
  | "logging_change"
  | "other";

export interface IntakeDay {
  day: string;
  kcal: number | null;
  incomplete: number;
}

export interface TransientRecord {
  id: number;
  day: string;
  kind: TransientKind;
  note: string | null;
}

export function expenditureRepository(db: Client) {
  async function intakeDays(from: string, to: string): Promise<IntakeDay[]> {
    try {
      return await db
        .select({
          day: daily_intake.day,
          kcal: daily_intake.kcal,
          incomplete: daily_intake.incomplete,
        })
        .from(daily_intake)
        .where(and(gte(daily_intake.day, from), lte(daily_intake.day, to)))
        .orderBy(asc(daily_intake.day));
    } catch (error) {
      throw classifyDatabaseFailure(error);
    }
  }

  async function transients(
    from: string,
    to: string
  ): Promise<TransientRecord[]> {
    try {
      return await db
        .select({
          id: nutrition_effective_events.id,
          day: nutrition_effective_events.day,
          // The SQL-managed view only combines checked event kinds and phase switches.
          kind: sql<TransientKind>`${nutrition_effective_events.kind}`,
          note: nutrition_effective_events.note,
        })
        .from(nutrition_effective_events)
        .where(
          and(
            gte(nutrition_effective_events.day, from),
            lte(nutrition_effective_events.day, to)
          )
        )
        .orderBy(
          desc(nutrition_effective_events.day),
          desc(nutrition_effective_events.id)
        );
    } catch (error) {
      throw classifyDatabaseFailure(error);
    }
  }

  return { intakeDays, transients };
}

export type ExpenditureRepository = ReturnType<typeof expenditureRepository>;
