import type { StateRepository } from "../../db/repositories/training/state.ts";
import { addDays, daysBetween, mondayOf } from "../shared/dates.ts";
import {
  instant as canonicalInstant,
  romeDate,
  systemClock,
  wireInstant,
} from "../shared/values.ts";
import type { Clock } from "../shared/values.ts";
import { deliveredInDoseUnit, DOCUMENTED_TRACKS } from "./rules.ts";
import type {
  ActiveMesocycle,
  RecentSession,
  RecentWeek,
  TrainingState,
} from "./state.types.ts";
import type { contextStore } from "./user_context.ts";

export function trainingStateStore(
  repository: StateRepository,
  context: ReturnType<typeof contextStore>,
  clock: Clock = systemClock
) {
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
    const userContext = await context.currentContext();
    const [schedule] = await repository.schedule(weekStart);
    const weekSchedule = schedule
      ? { ...schedule, written_at: wireInstant(schedule.written_at) }
      : null;
    const active = await repository.activePlans();
    if (!active.length) {
      return {
        now,
        mesocycles: [],
        week_schedule: weekSchedule,
        user_context: userContext,
        note:
          userContext.length === 0
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
      const exercises = await repository.planExercises(
        m.id,
        today,
        today > m.started_on ? today : m.started_on,
        weekStart
      );
      const [{ sessions_done }] = await repository.sessionsDone(
        m.id,
        weekStart
      );
      const recentWeeks: RecentWeek[] = [];
      if (week !== null) {
        for (let w = Math.max(1, week - 3); w < week; w++) {
          const [done] = await repository.recentWeek(
            m.id,
            weekStart,
            m.started_on,
            w,
            addDays(m.started_on, (w - 1) * 7),
            addDays(m.started_on, w * 7)
          );
          recentWeeks.push({ week: w, ...done });
        }
      }
      const decisions = await repository.recentDecisions(m.id);
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
            e.duration_s
          ),
        })),
        this_week: { sessions_done, sessions_per_week: m.sessions_per_week },
        recent_weeks: recentWeeks,
        recent_decisions: decisions.map((d) => ({
          ...d,
          made_at: wireInstant(d.made_at),
        })),
      });
    }
    const recentSessions = await repository.recentSessions();
    const sessions: RecentSession[] = [];
    for (const s of recentSessions) {
      const exercises = await repository.sessionExercises(s.id);
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
