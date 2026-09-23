import {
  type Clock,
  type Database,
  instant as canonicalInstant,
  romeDate,
  rows,
  systemClock,
  wireInstant,
} from "../shared/d1.ts";
import { addDays, daysBetween, mondayOf } from "../shared/dates.ts";
import { deliveredInDoseUnit, DOCUMENTED_TRACKS, type Track } from "./rules.ts";
import { contextStore } from "./user_context.ts";
import type {
  ActiveMesocycle,
  PlanExercise,
  RecentDecision,
  RecentSession,
  RecentWeek,
  SessionExercise,
  TrainingState,
  WeekScheduleEntry,
} from "./state.types.ts";

const performed =
  "(t.reps IS NOT NULL OR t.distance_m IS NOT NULL OR t.duration_s IS NOT NULL)";
interface Plan {
  id: number;
  name: string;
  track: Track;
  intent: string;
  planned_weeks: number;
  sessions_per_week: number;
  started_on: string;
}

export function trainingStateStore(db: Database, clock: Clock = systemClock) {
  async function trainingState(): Promise<TrainingState> {
    const instant = clock();
    const today = romeDate(canonicalInstant(instant.toISOString()));
    const weekStart = mondayOf(today);
    const now = {
      date: today,
      time: new Intl.DateTimeFormat("en-GB", {
        timeZone: "Europe/Rome",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      }).format(instant),
      weekday: new Intl.DateTimeFormat("en-US", {
        timeZone: "Europe/Rome",
        weekday: "long",
      }).format(instant),
      tz: "Europe/Rome",
    };
    const userContext = await contextStore(db).currentContext();
    const [schedule] = await rows<WeekScheduleEntry>(
      db,
      "SELECT week_start, schedule, written_at FROM week_schedules WHERE week_start = ?",
      weekStart,
    );
    const weekSchedule = schedule
      ? { ...schedule, written_at: wireInstant(schedule.written_at)! }
      : null;
    const active = await rows<Plan>(
      db,
      "SELECT id, name, track, intent, planned_weeks, sessions_per_week, started_on FROM mesocycles WHERE ended_on IS NULL ORDER BY track",
    );
    if (!active.length) {
      return {
        now,
        mesocycles: [],
        week_schedule: weekSchedule,
        user_context: userContext,
        note: userContext.length === 0
          ? "No active mesocycle and no user context: this is a first conversation. Start with the onboarding document, `tasks/onboarding` — do not program anything yet."
          : "No active mesocycle. Read the `tasks/programming` document, then create one with POST /mesocycles (blocks via POST /blocks).",
      };
    }
    const mesocycles: ActiveMesocycle[] = [];
    for (const m of active) {
      // Match PostgreSQL integer division, including the partial pre-start
      // week, and the plan-detail reader's null rule.
      const numberedWeek = Math.trunc(daysBetween(m.started_on, today) / 7) + 1;
      const week = numberedWeek < 1 ? null : numberedWeek;
      const exercises = await rows<Omit<PlanExercise, "delivered_this_week">>(
        db,
        `SELECT e.name AS exercise, e.measure, me.role, me.priority, me.notes,
          dose.weekly_dose / 100.0 AS dose, dose.weekly_dose_unit AS dose_unit,
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
        today > m.started_on ? today : m.started_on,
        m.id,
        weekStart,
        m.id,
      );
      const [{ sessions_done }] = await rows<{ sessions_done: number }>(
        db,
        `SELECT count(DISTINCT s.id) AS sessions_done FROM sessions s JOIN sets t ON t.session_id = s.id
         WHERE t.mesocycle_id = ? AND s.date >= ? AND ${performed}`,
        m.id,
        weekStart,
      );
      const recentWeeks: RecentWeek[] = [];
      if (week !== null) {
        for (let w = Math.max(1, week - 3); w < week; w++) {
          const [done] = await rows<Omit<RecentWeek, "week">>(
            db,
            `SELECT (SELECT count(*) FROM sets t JOIN sessions s ON s.id = t.session_id
               WHERE t.mesocycle_id = ? AND t.kind = 'working' AND ${performed} AND s.date < ?
               AND CAST(julianday(s.date) - julianday(?) AS INTEGER) / 7 + 1 = ?) AS working_sets_done,
             (SELECT count(DISTINCT s.id) FROM sessions s JOIN sets t ON t.session_id = s.id
               WHERE t.mesocycle_id = ? AND s.date >= ? AND s.date < ? AND ${performed}) AS sessions_done`,
            m.id,
            weekStart,
            m.started_on,
            w,
            m.id,
            addDays(m.started_on, (w - 1) * 7),
            addDays(m.started_on, w * 7),
          );
          recentWeeks.push({ week: w, ...done });
        }
      }
      const decisions = await rows<RecentDecision>(
        db,
        "SELECT id, made_at, what_changed, why FROM mesocycle_decisions WHERE mesocycle_id = ? ORDER BY made_at DESC, id DESC LIMIT 5",
        m.id,
      );
      const hasMethod = DOCUMENTED_TRACKS.includes(m.track);
      mesocycles.push({
        id: m.id,
        name: m.name,
        track: m.track,
        intent: m.intent,
        week,
        planned_weeks: m.planned_weeks,
        started_on: m.started_on,
        method_doc: hasMethod ? `method/${m.track}` : null,
        method_note: hasMethod
          ? null
          : `There is no method document for the ${m.track} track yet, so this plan is coached from general knowledge. Say so plainly rather than implying an authority the documents do not give you.`,
        exercises: exercises.map((e) => ({
          ...e,
          delivered_this_week: deliveredInDoseUnit(
            e.dose_unit,
            e.sets_done,
            e.distance_m,
            e.duration_s,
          ),
        })),
        this_week: { sessions_done, sessions_per_week: m.sessions_per_week },
        recent_weeks: recentWeeks,
        recent_decisions: decisions.map((d) => ({
          ...d,
          made_at: wireInstant(d.made_at)!,
        })),
      });
    }
    const recentSessions = await rows<Omit<RecentSession, "exercises">>(
      db,
      "SELECT id, date, rationale, notes, overall_feel FROM sessions ORDER BY date DESC, id DESC LIMIT 5",
    );
    const sessions: RecentSession[] = [];
    for (const s of recentSessions) {
      const exercises = await rows<SessionExercise>(
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
        s.id,
      );
      sessions.push({ ...s, exercises });
    }
    return {
      now,
      week_schedule: weekSchedule,
      mesocycles,
      recent_sessions: sessions,
      user_context: userContext,
    };
  }
  return { trainingState };
}
