import type { ScheduleRepository } from "@trainer/db/repositories/training/schedule.ts";
import { Effect } from "effect";

import { effectful } from "../shared/database.ts";
import type { DatabaseFailure, Invalid } from "../shared/refusals.ts";
import { date, now, romeDate, wireInstant } from "../shared/values.ts";
import type {
  WeekScheduleRow,
  WriteWeekScheduleInput,
} from "./week_schedule.types.ts";

export function scheduleStore(rows: ScheduleRepository) {
  const repository = effectful(rows);

  const writeWeekSchedule = Effect.fn("weekSchedule.writeWeekSchedule")(
    function* (
      b: WriteWeekScheduleInput
    ): Effect.fn.Return<
      { row: WeekScheduleRow; note: string | null },
      Invalid | DatabaseFailure
    > {
      const at = yield* now;
      const today = yield* romeDate(at);
      const day = new Date(`${today}T00:00:00Z`);
      const dow = day.getUTCDay() || 7;
      day.setUTCDate(day.getUTCDate() - dow + 1);
      const monday = day.toISOString().slice(0, 10);
      const weekStart =
        b.week_start === null || b.week_start === undefined
          ? monday
          : yield* date(b.week_start);
      const [stored] = yield* repository.save(weekStart, b.schedule, at);
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
  );
  return { writeWeekSchedule };
}
