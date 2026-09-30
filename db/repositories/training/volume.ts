import type { Client } from "../../client.ts";
import type { VolumeRow, ExerciseWeek } from "../../contracts/training.ts";
import { rows } from "../../native.ts";

export function volumeRepository(db: Client) {
  async function allMuscles(cutoff: string) {
    return await rows<VolumeRow>(
      db,
      `SELECT week_start, muscle, sum(working_sets) AS working_sets FROM weekly_volume
       WHERE week_start < ? GROUP BY week_start, muscle ORDER BY week_start, muscle`,
      cutoff
    );
  }
  async function muscles(id: number, cutoff: string) {
    return await rows<VolumeRow>(
      db,
      `SELECT week_start, muscle, working_sets FROM weekly_volume WHERE mesocycle_id = ? AND week_start < ? ORDER BY week_start, muscle`,
      id,
      cutoff
    );
  }
  async function dose(id: number, cutoff: string) {
    return await rows<ExerciseWeek>(
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
        d.weekly_dose / 10.0 AS dose, d.weekly_dose_unit AS dose_unit
       FROM finished v JOIN exercises e ON e.id = v.exercise_id
       JOIN mesocycles mc ON mc.id = v.mesocycle_id
       LEFT JOIN mesocycle_exercise_doses d ON d.id = (
         SELECT dose.id FROM mesocycle_exercise_doses dose WHERE dose.mesocycle_id = v.mesocycle_id
         AND dose.exercise_id = v.exercise_id AND dose.effective_from <= date(mc.started_on, (v.week * 7 - 1) || ' days')
         ORDER BY dose.effective_from DESC, dose.id DESC LIMIT 1)
       ORDER BY v.week, e.name`,
      cutoff,
      id
    );
  }
  return { allMuscles, muscles, dose };
}
export type VolumeRepository = ReturnType<typeof volumeRepository>;
