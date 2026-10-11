import { asc, desc, eq, isNull } from "drizzle-orm";

import type { Client } from "../../client.ts";
import type {
  WeekScheduleEntry,
  Plan,
  PlanExercise,
  RecentWeek,
  RecentDecision,
  RecentSession,
  SessionExercise,
} from "../../contracts/training.ts";
import { classifyDatabaseFailure } from "../../errors.ts";
import { rows } from "../../native.ts";
import {
  week_schedules,
  mesocycles,
  mesocycle_decisions,
  sessions,
} from "../../schema/index.ts";

const performed =
  "(t.reps IS NOT NULL OR t.distance_m IS NOT NULL OR t.duration_s IS NOT NULL)";
export function stateRepository(db: Client) {
  async function schedule(weekStart: string): Promise<WeekScheduleEntry[]> {
    try {
      return await db
        .select({
          week_start: week_schedules.week_start,
          schedule: week_schedules.schedule,
          written_at: week_schedules.written_at,
        })
        .from(week_schedules)
        .where(eq(week_schedules.week_start, weekStart));
    } catch (error) {
      throw classifyDatabaseFailure(error);
    }
  }
  async function activePlans(): Promise<Plan[]> {
    try {
      const found = await db
        .select({
          id: mesocycles.id,
          name: mesocycles.name,
          track: mesocycles.track,
          intent: mesocycles.intent,
          planned_weeks: mesocycles.planned_weeks,
          sessions_per_week: mesocycles.sessions_per_week,
          started_on: mesocycles.started_on,
        })
        .from(mesocycles)
        .where(isNull(mesocycles.ended_on))
        .orderBy(asc(mesocycles.track));
      // SAFETY: mesocycles_track_check restricts every stored track to the Plan union.
      return found as Plan[];
    } catch (error) {
      throw classifyDatabaseFailure(error);
    }
  }
  async function planExercises(
    id: number,
    today: string,
    doseDate: string,
    weekStart: string
  ) {
    return await rows<PlanExercise>(
      db,
      `SELECT e.name AS exercise, e.measure, me.role, me.priority, me.notes,
          dose.weekly_dose / 10.0 AS dose, dose.weekly_dose_unit AS dose_unit,
          coalesce(d.sets_done, 0) AS sets_done, d.distance_m, d.duration_s,
          CAST(julianday(?) - julianday((SELECT max(s.date) FROM sets t JOIN sessions s ON s.id = t.session_id
            WHERE t.exercise_id = me.exercise_id AND ${performed})) AS INTEGER) AS days_since_trained
         FROM mesocycle_exercises me JOIN exercises e ON e.id = me.exercise_id
         JOIN mesocycle_exercise_doses dose ON dose.id = (
           SELECT h.id FROM mesocycle_exercise_doses h WHERE h.mesocycle_id = me.mesocycle_id
           AND h.exercise_id = me.exercise_id AND h.effective_from <= ? ORDER BY h.effective_from DESC, h.id DESC LIMIT 1)
         LEFT JOIN (SELECT t.exercise_id, count(*) AS sets_done, sum(t.distance_m) / 10.0 AS distance_m,
           sum(t.duration_s) / 100.0 AS duration_s FROM sets t JOIN sessions s ON s.id = t.session_id
           WHERE t.mesocycle_id = ? AND t.kind = 'working' AND ${performed} AND s.date >= ? GROUP BY t.exercise_id) d
           ON d.exercise_id = me.exercise_id
         WHERE me.mesocycle_id = ? ORDER BY me.priority, e.name`,
      today,
      doseDate,
      id,
      weekStart,
      id
    );
  }
  async function sessionsDone(id: number, weekStart: string) {
    return await rows<{ sessions_done: number }>(
      db,
      `SELECT count(DISTINCT s.id) AS sessions_done FROM sessions s JOIN sets t ON t.session_id = s.id
         WHERE t.mesocycle_id = ? AND s.date >= ? AND ${performed}`,
      id,
      weekStart
    );
  }
  async function recentWeek(
    id: number,
    weekStart: string,
    startedOn: string,
    week: number,
    from: string,
    to: string
  ) {
    return await rows<RecentWeek>(
      db,
      `SELECT (SELECT count(*) FROM sets t JOIN sessions s ON s.id = t.session_id
               WHERE t.mesocycle_id = ? AND t.kind = 'working' AND ${performed} AND s.date < ?
               AND CAST(julianday(s.date) - julianday(?) AS INTEGER) / 7 + 1 = ?) AS working_sets_done,
             (SELECT count(DISTINCT s.id) FROM sessions s JOIN sets t ON t.session_id = s.id
               WHERE t.mesocycle_id = ? AND s.date >= ? AND s.date < ? AND ${performed}) AS sessions_done`,
      id,
      weekStart,
      startedOn,
      week,
      id,
      from,
      to
    );
  }
  async function recentDecisions(id: number): Promise<RecentDecision[]> {
    try {
      return await db
        .select({
          id: mesocycle_decisions.id,
          made_at: mesocycle_decisions.made_at,
          what_changed: mesocycle_decisions.what_changed,
          why: mesocycle_decisions.why,
        })
        .from(mesocycle_decisions)
        .where(eq(mesocycle_decisions.mesocycle_id, id))
        .orderBy(
          desc(mesocycle_decisions.made_at),
          desc(mesocycle_decisions.id)
        )
        .limit(5);
    } catch (error) {
      throw classifyDatabaseFailure(error);
    }
  }
  async function recentSessions(): Promise<RecentSession[]> {
    try {
      return await db
        .select({
          id: sessions.id,
          date: sessions.date,
          rationale: sessions.rationale,
          notes: sessions.notes,
          overall_feel: sessions.overall_feel,
        })
        .from(sessions)
        .orderBy(desc(sessions.date), desc(sessions.id))
        .limit(5);
    } catch (error) {
      throw classifyDatabaseFailure(error);
    }
  }
  async function sessionExercises(id: number) {
    return await rows<SessionExercise>(
      db,
      `SELECT exercise, mesocycle_id, working_sets, top_weight_kg, top_reps, top_distance_m, top_duration_s, top_effort FROM (
          SELECT e.name AS exercise, t.mesocycle_id,
            count(*) OVER (PARTITION BY t.exercise_id) AS working_sets,
            t.weight_kg / 100.0 AS top_weight_kg, t.reps AS top_reps,
            t.distance_m / 10.0 AS top_distance_m, t.duration_s / 100.0 AS top_duration_s, t.effort AS top_effort,
            row_number() OVER (PARTITION BY t.exercise_id ORDER BY t.weight_kg DESC NULLS LAST,
              t.reps DESC NULLS LAST, t.distance_m DESC NULLS LAST) AS rank
          FROM sets t JOIN exercises e ON e.id = t.exercise_id WHERE t.session_id = ? AND t.kind = 'working' AND ${performed}
        ) WHERE rank = 1 ORDER BY exercise`,
      id
    );
  }
  return {
    schedule,
    activePlans,
    planExercises,
    sessionsDone,
    recentWeek,
    recentDecisions,
    recentSessions,
    sessionExercises,
  };
}
export type StateRepository = ReturnType<typeof stateRepository>;
