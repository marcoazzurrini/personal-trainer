import { sql } from "drizzle-orm";

import type { Client } from "../../client.ts";
import type { WeekScheduleRow } from "../../contracts/training.ts";
import { classifyDatabaseFailure } from "../../errors.ts";
import { week_schedules } from "../../schema/index.ts";

export function scheduleRepository(db: Client) {
  async function save(
    weekStart: string,
    schedule: string,
    writtenAt: string
  ): Promise<WeekScheduleRow[]> {
    try {
      return await db
        .insert(week_schedules)
        .values({ week_start: weekStart, schedule, written_at: writtenAt })
        .onConflictDoUpdate({
          target: week_schedules.week_start,
          set: { schedule, written_at: writtenAt },
        })
        .returning({
          week_start: week_schedules.week_start,
          week_end: sql<string>`date(week_start, '+6 days')`,
          schedule: week_schedules.schedule,
          written_at: week_schedules.written_at,
        });
    } catch (error) {
      throw classifyDatabaseFailure(error);
    }
  }
  return { save };
}
export type ScheduleRepository = ReturnType<typeof scheduleRepository>;
