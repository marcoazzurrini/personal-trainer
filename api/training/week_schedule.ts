import type { ScheduleRepository } from "../../db/repositories/training/schedule.ts";
import {
  date,
  instant,
  romeDate,
  systemClock,
  wireInstant,
} from "../shared/values.ts";
import type { Clock } from "../shared/values.ts";
import type { WriteWeekScheduleInput } from "./week_schedule.types.ts";

export function scheduleStore(
  repository: ScheduleRepository,
  clock: Clock = systemClock
) {
  async function writeWeekSchedule(b: WriteWeekScheduleInput) {
    const now = instant(clock().toISOString());
    const today = romeDate(now);
    const day = new Date(`${today}T00:00:00Z`);
    const dow = day.getUTCDay() || 7;
    day.setUTCDate(day.getUTCDate() - dow + 1);
    const monday = day.toISOString().slice(0, 10);
    const weekStart =
      b.week_start === null || b.week_start === undefined
        ? monday
        : date(b.week_start);
    const [stored] = await repository.save(weekStart, b.schedule, now);
    let note: string | null = null;
    if ((b.week_start === null || b.week_start === undefined) && dow >= 6) {
      day.setUTCDate(day.getUTCDate() + 7);
      note = `week_start defaulted to ${stored.week_start} — the Monday of the week now ending, not next week. If this schedule was meant for the coming week, resend it with "week_start": "${day
        .toISOString()
        .slice(0, 10)}".`;
    }
    return {
      row: { ...stored, written_at: wireInstant(stored.written_at) },
      note,
    };
  }
  return { writeWeekSchedule };
}
