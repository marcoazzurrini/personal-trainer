import {
  type Clock,
  type Database,
  date,
  instant,
  romeDate,
  rows,
  systemClock,
  wireInstant,
} from "../shared/d1.ts";
import type {
  WeekScheduleRow,
  WriteWeekScheduleInput,
} from "./week_schedule.types.ts";

export function scheduleStore(db: Database, clock: Clock = systemClock) {
  async function writeWeekSchedule(
    b: WriteWeekScheduleInput,
  ) {
    const now = instant(clock().toISOString());
    const today = romeDate(now);
    const day = new Date(`${today}T00:00:00Z`);
    const dow = day.getUTCDay() || 7;
    day.setUTCDate(day.getUTCDate() - dow + 1);
    const monday = day.toISOString().slice(0, 10);
    const weekStart = b.week_start == null ? monday : date(b.week_start);
    const [stored] = await rows<WeekScheduleRow>(
      db,
      `INSERT INTO week_schedules (week_start, schedule, written_at) VALUES (?, ?, ?)
       ON CONFLICT(week_start) DO UPDATE SET schedule = excluded.schedule, written_at = excluded.written_at
       RETURNING week_start, date(week_start, '+6 days') AS week_end, schedule, written_at`,
      weekStart,
      b.schedule,
      now,
    );
    let note: string | null = null;
    if (b.week_start == null && dow >= 6) {
      day.setUTCDate(day.getUTCDate() + 7);
      note =
        `week_start defaulted to ${stored.week_start} — the Monday of the week now ending, not next week. If this schedule was meant for the coming week, resend it with "week_start": "${
          day.toISOString().slice(0, 10)
        }".`;
    }
    return {
      row: { ...stored, written_at: wireInstant(stored.written_at)! },
      note,
    };
  }
  return { writeWeekSchedule };
}
