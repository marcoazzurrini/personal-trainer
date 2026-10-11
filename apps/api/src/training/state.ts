import type { StateRepository } from "@trainer/db/repositories/training/state.ts";
import { Effect } from "effect";

import { effectful } from "../shared/database.ts";
import { addDays, daysBetween, mondayOf } from "../shared/dates.ts";
import type { DatabaseFailure } from "../shared/refusals.ts";
import {
  atOneInstant,
  currentTime,
  today as romeToday,
  wireInstant,
} from "../shared/values.ts";
import { deliveredInDoseUnit, DOCUMENTED_TRACKS } from "./rules.ts";
import type {
  ActiveMesocycle,
  RecentSession,
  RecentWeek,
  TrainingState,
} from "./state.types.ts";
import type { contextStore } from "./user_context.ts";

export function trainingStateStore(
  rows: StateRepository,
  context: ReturnType<typeof contextStore>
) {
  const repository = effectful(rows);

  const trainingState = Effect.fn("trainingState.trainingState")(
    function* (): Effect.fn.Return<TrainingState, DatabaseFailure> {
      // Run at one instant (atOneInstant, below): the date, the time and the
      // weekday come from a single reading of the clock.
      const instant = yield* currentTime;
      const today = yield* romeToday;
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
      // Reads that need no other's answer wait on D1 together, so the state
      // costs its slowest read per step rather than the sum of every query.
      // The query count is unchanged: what was not read before is still not.
      const [userContext, [schedule], active] = yield* Effect.all(
        [
          context.currentContext(),
          repository.schedule(weekStart),
          repository.activePlans(),
        ],
        { concurrency: "unbounded" }
      );
      const weekSchedule = schedule
        ? { ...schedule, written_at: wireInstant(schedule.written_at) }
        : null;
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
      const plan = Effect.fnUntraced(function* (
        m: (typeof active)[number]
      ): Effect.fn.Return<ActiveMesocycle, DatabaseFailure> {
        // Match PostgreSQL integer division, including the partial pre-start
        // week, and the plan-detail reader's null rule.
        const numberedWeek =
          Math.trunc(daysBetween(m.started_on, today) / 7) + 1;
        const week = numberedWeek < 1 ? null : numberedWeek;
        const earlierWeeks: number[] = [];
        if (week !== null) {
          for (let w = Math.max(1, week - 3); w < week; w++) {
            earlierWeeks.push(w);
          }
        }
        const [exercises, [{ sessions_done }], recentWeeks, decisions] =
          yield* Effect.all(
            [
              repository.planExercises(
                m.id,
                today,
                today > m.started_on ? today : m.started_on,
                weekStart
              ),
              repository.sessionsDone(m.id, weekStart),
              Effect.forEach(
                earlierWeeks,
                (w) =>
                  repository
                    .recentWeek(
                      m.id,
                      weekStart,
                      m.started_on,
                      w,
                      addDays(m.started_on, (w - 1) * 7),
                      addDays(m.started_on, w * 7)
                    )
                    .pipe(
                      Effect.map(([done]): RecentWeek => ({ week: w, ...done }))
                    ),
                { concurrency: "unbounded" }
              ),
              repository.recentDecisions(m.id),
            ],
            { concurrency: "unbounded" }
          );
        const hasMethod = DOCUMENTED_TRACKS.includes(m.track);
        return {
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
        };
      });
      const recent = repository.recentSessions().pipe(
        Effect.flatMap((recentSessions) =>
          Effect.forEach(
            recentSessions,
            (s) =>
              repository.sessionExercises(s.id).pipe(
                Effect.map((exercises): RecentSession => ({
                  ...s,
                  exercises,
                }))
              ),
            { concurrency: "unbounded" }
          )
        )
      );
      const [mesocycles, sessions] = yield* Effect.all(
        [Effect.forEach(active, plan, { concurrency: "unbounded" }), recent],
        { concurrency: "unbounded" }
      );
      return {
        now,
        week_schedule: weekSchedule,
        mesocycles,
        recent_sessions: sessions,
        user_context: userContext,
      };
    },
    atOneInstant
  );
  return { trainingState };
}
