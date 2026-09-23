import {
  type Clock,
  type Database,
  instant,
  romeDate,
  rows,
  systemClock,
} from "../shared/d1.ts";
import { mondayOf } from "../shared/dates.ts";
import { ApiError } from "../shared/errors.ts";
import { trainingResolver } from "./resolve.ts";
import { deliveredInDoseUnit } from "./rules.ts";
import type { ExerciseWeek, VolumeRow } from "./volume.types.ts";

/** The D1 views retain all weeks. Only readers apply the Rome cutoff. */
export function volumeStore(db: Database, clock: Clock = systemClock) {
  const resolver = trainingResolver(db);
  async function volumePerMuscle(
    param: string,
  ): Promise<{ mesocycle_id?: number; weekly_volume: VolumeRow[] }> {
    const cutoff = mondayOf(romeDate(instant(clock().toISOString())));
    if (param === "all") {
      return {
        weekly_volume: await rows<VolumeRow>(
          db,
          `SELECT week_start, muscle, sum(working_sets) AS working_sets FROM weekly_volume
       WHERE week_start < ? GROUP BY week_start, muscle ORDER BY week_start, muscle`,
          cutoff,
        ),
      };
    }
    const m = await resolver.resolveMesocycle(param);
    return {
      mesocycle_id: m.id,
      weekly_volume: await rows<VolumeRow>(
        db,
        `SELECT week_start, muscle, working_sets FROM weekly_volume WHERE mesocycle_id = ? AND week_start < ? ORDER BY week_start, muscle`,
        m.id,
        cutoff,
      ),
    };
  }
  async function dosePerExercise(param: string): Promise<{
    mesocycle_id: number;
    track: string;
    weekly_exercise_sets: ExerciseWeek[];
  }> {
    if (param === "all") {
      throw new ApiError(
        422,
        '"all" works on GET /weekly-volume but not here. These weeks are numbered from a mesocycle\'s start, so week 3 of two different plans are different weeks against different doses — combining them would compare numbers that share no meaning. Pass a mesocycle id, "current", or "current:<track>".',
      );
    }
    const m = await resolver.resolveMesocycle(param);
    const found = await rows<Omit<ExerciseWeek, "delivered">>(
      db,
      // Filter source dates before grouping: pre-start sets can share relative
      // week 1 with the first plan week because integer division truncates.
      `WITH finished AS (
         SELECT t.mesocycle_id, t.exercise_id,
           CAST(julianday(s.date) - julianday(mc.started_on) AS INTEGER) / 7 + 1 AS week,
           count(*) AS sets_done, sum(t.distance_m) / 10.0 AS distance_m, sum(t.duration_s) / 100.0 AS duration_s
         FROM sets t JOIN sessions s ON s.id = t.session_id JOIN mesocycles mc ON mc.id = t.mesocycle_id
         WHERE t.kind = 'working' AND (t.reps IS NOT NULL OR t.distance_m IS NOT NULL OR t.duration_s IS NOT NULL)
           AND s.date < ? AND t.mesocycle_id = ? GROUP BY 1, 2, 3
       ) SELECT v.week, e.name AS exercise, v.exercise_id, e.measure, v.sets_done, v.distance_m, v.duration_s,
        d.weekly_dose / 100.0 AS dose, d.weekly_dose_unit AS dose_unit
       FROM finished v JOIN exercises e ON e.id = v.exercise_id
       JOIN mesocycles mc ON mc.id = v.mesocycle_id
       LEFT JOIN mesocycle_exercise_doses d ON d.id = (
         SELECT dose.id FROM mesocycle_exercise_doses dose WHERE dose.mesocycle_id = v.mesocycle_id
         AND dose.exercise_id = v.exercise_id AND dose.effective_from <= date(mc.started_on, (v.week * 7 - 1) || ' days')
         ORDER BY dose.effective_from DESC, dose.id DESC LIMIT 1)
       ORDER BY v.week, e.name`,
      mondayOf(romeDate(instant(clock().toISOString()))),
      m.id,
    );
    return {
      mesocycle_id: m.id,
      track: m.track,
      weekly_exercise_sets: found.map((r) => ({
        ...r,
        delivered: r.dose_unit === null ? null : deliveredInDoseUnit(
          r.dose_unit,
          r.sets_done,
          r.distance_m,
          r.duration_s,
        ),
      })),
    };
  }
  return { volumePerMuscle, dosePerExercise };
}
