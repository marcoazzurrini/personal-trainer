// The composite: everything true about the training as of now. A view over
// things that each have their own address — nothing here is only obtainable
// through this bundle.
//
// Plans are plural. Hypertrophy and speed run side by side, each with its own
// start Monday and so its own week number, its own dose to be judged against,
// and its own method document. What they share is the week: one schedule, one
// list of recent sessions, one person.

import { sql } from "../db.ts";
import { docExists } from "../surfaces/docs.ts";
import { romeClock, romeDate, romeWeekStart } from "../shared/calendar.ts";
import { deliveredInDoseUnit } from "./rules.ts";
import { planWeekOrNull, planWeekSince } from "./mesocycles.ts";
import { type ContextEntry, currentContext } from "./user_context.ts";

export interface WeekScheduleEntry {
  week_start: string;
  schedule: string;
  written_at: string;
}

export interface PlanExercise {
  exercise: string;
  measure: string;
  role: string;
  priority: number;
  notes: string | null;
  dose: number;
  dose_unit: string;
  sets_done: number;
  distance_m: number | null;
  duration_s: number | null;
  days_since_trained: number | null;
  delivered_this_week: number;
}

export interface RecentWeek {
  week: number;
  working_sets_done: number;
  sessions_done: number;
}

export interface RecentDecision {
  id: number;
  made_at: string;
  what_changed: string;
  why: string;
}

export interface ActiveMesocycle {
  id: number;
  name: string;
  track: string;
  intent: string;
  week: number | null;
  planned_weeks: number;
  started_on: string;
  method_doc: string | null;
  method_note: string | null;
  exercises: PlanExercise[];
  this_week: { sessions_done: number; sessions_per_week: number };
  recent_weeks: RecentWeek[];
  recent_decisions: RecentDecision[];
}

export interface SessionExercise {
  exercise: string;
  mesocycle_id: number | null;
  working_sets: number;
  top_weight_kg: number | null;
  top_reps: number | null;
  top_distance_m: number | null;
  top_duration_s: number | null;
  top_effort: string | null;
}

export interface RecentSession {
  id: number;
  date: string;
  rationale: string | null;
  notes: string | null;
  overall_feel: string | null;
  exercises: SessionExercise[];
}

// Two shapes. With no active mesocycle the answer is a `note` routing to
// onboarding or to programming, and `recent_sessions` is not fetched at all —
// there is nothing to read them against yet.
export interface TrainingState {
  now: { date: string; time: string; weekday: string; tz: string };
  week_schedule: WeekScheduleEntry | null;
  mesocycles: ActiveMesocycle[];
  note?: string;
  recent_sessions?: RecentSession[];
  user_context: ContextEntry[];
}

export async function trainingState(): Promise<TrainingState> {
  const now = await romeClock();
  const [{ week_start: weekStart }] = await sql`
  select ${romeWeekStart()} as week_start`;

  const userContext = await currentContext();

  const [weekSchedule] = await sql<WeekScheduleEntry[]>`
  select week_start, schedule, written_at from week_schedules
  where week_start = ${weekStart}`;

  const active = await sql`
  select id, name, track, intent, planned_weeks, sessions_per_week,
    started_on,
    ${planWeekSince()} as week
  from mesocycles where ended_on is null
  order by track`;

  if (active.length === 0) {
    // The cold start routes to onboarding; a known person routes to planning.
    const note = userContext.length === 0
      ? "No active mesocycle and no user context: this is a first conversation. Start with GET /docs/tasks/onboarding — do not program anything yet."
      : "No active mesocycle. Fetch GET /docs/tasks/programming, then create one with POST /mesocycles (blocks via POST /blocks).";
    return {
      now,
      mesocycles: [],
      note,
      week_schedule: weekSchedule ?? null,
      user_context: userContext,
    };
  }

  const mesocycles: ActiveMesocycle[] = [];
  for (const meso of active) {
    const week = planWeekOrNull(meso.week);

    // The plan's exercises with, per exercise: the dose, what this week has
    // delivered against it in the dose's own unit, and staleness.
    //
    // Delivery is scoped to this plan — the same work cannot count twice for
    // two plans — while staleness is not: how long since the last squat is a
    // fact about the lift and the body, not about which plan asked for it.
    const exercises = await sql<
      Array<Omit<PlanExercise, "delivered_this_week">>
    >`
    select e.name as exercise, e.measure, me.role, me.priority, me.notes,
      me.weekly_dose::float8 as dose, me.weekly_dose_unit as dose_unit,
      coalesce(d.sets_done, 0)::int as sets_done,
      d.distance_m, d.duration_s,
      ((${romeDate()}) -
       (select max(s.date) from sets t
        join sessions s on s.id = t.session_id
        where t.exercise_id = me.exercise_id
          and set_performed(t.reps, t.distance_m, t.duration_s))
      ) as days_since_trained
    from mesocycle_exercises me
    join exercises e on e.id = me.exercise_id
    left join lateral (
      select count(*)::int as sets_done,
        sum(t.distance_m)::float8 as distance_m,
        sum(t.duration_s)::float8 as duration_s
      from sets t
      join sessions s on s.id = t.session_id
      where t.exercise_id = me.exercise_id
        and t.mesocycle_id = me.mesocycle_id
        and t.kind = 'working'
        and set_performed(t.reps, t.distance_m, t.duration_s)
        and s.date >= ${weekStart}
    ) d on true
    where me.mesocycle_id = ${meso.id}
    order by me.priority, e.name`;

    const [thisWeek] = await sql`
    select count(distinct s.id)::int as sessions_done
    from sessions s
    join sets t on t.session_id = s.id
    where t.mesocycle_id = ${meso.id} and s.date >= ${weekStart}
      and set_performed(t.reps, t.distance_m, t.duration_s)`;

    // The last few finished weeks: what was delivered. Judging it against the
    // doses (and the decision log's adjustments) is the coach's job.
    const recentWeeks = week === null ? [] : await sql<
      RecentWeek[]
    >`
    select g.w as week,
      coalesce((select sum(v.sets_done)::int
        from weekly_exercise_sets_done v
        where v.mesocycle_id = ${meso.id} and v.week = g.w), 0) as working_sets_done,
      (select count(distinct s.id)::int from sessions s
       join sets t on t.session_id = s.id
       where t.mesocycle_id = ${meso.id}
         and s.date >= ${meso.started_on}::date + (g.w - 1) * 7
         and s.date < ${meso.started_on}::date + g.w * 7
         and set_performed(t.reps, t.distance_m, t.duration_s)) as sessions_done
    from generate_series(greatest(1, ${week} - 3), ${week} - 1) g(w)
    order by g.w`;

    // Session generation reads these: a backed-off lift or a declared light
    // week changes what today's session should ask for.
    const recentDecisions = await sql<RecentDecision[]>`
    select id, made_at, what_changed, why
    from mesocycle_decisions
    where mesocycle_id = ${meso.id}
    order by made_at desc, id desc
    limit 5`;

    // Stated by the API rather than left for the coach to discover: a plan on
    // a track with no method document is coached from general knowledge, and
    // saying so is the difference between honest and authoritative.
    const methodDoc = `method/${meso.track}`;
    const hasMethodDoc = await docExists(methodDoc);

    mesocycles.push({
      id: meso.id,
      name: meso.name,
      track: meso.track,
      intent: meso.intent,
      week,
      planned_weeks: meso.planned_weeks,
      started_on: meso.started_on,
      method_doc: hasMethodDoc ? `GET /docs/${methodDoc}` : null,
      method_note: hasMethodDoc
        ? null
        : `There is no method document for the ${meso.track} track yet, so this plan is coached from general knowledge. Say so plainly rather than implying an authority the documents do not give you.`,
      exercises: exercises.map((e) => ({
        ...e,
        delivered_this_week: deliveredInDoseUnit(
          e.dose_unit,
          e.sets_done,
          e.distance_m,
          e.duration_s,
        ),
      })),
      this_week: {
        sessions_done: thisWeek.sessions_done,
        sessions_per_week: meso.sessions_per_week,
      },
      recent_weeks: recentWeeks,
      recent_decisions: recentDecisions,
    });
  }

  // Shared across plans, because the week is shared. A session that sprinted
  // and then squatted appears once, with the work it held.
  const recentSessions = await sql<RecentSession[]>`
  select s.id, s.date, s.rationale, s.notes, s.overall_feel,
    coalesce((select json_agg(x order by x.exercise)
      from (
        select distinct on (t.exercise_id) e.name as exercise,
          t.mesocycle_id,
          count(*) over (partition by t.exercise_id)::int as working_sets,
          t.weight_kg::float8 as top_weight_kg, t.reps as top_reps,
          t.distance_m::float8 as top_distance_m,
          t.duration_s::float8 as top_duration_s,
          t.effort as top_effort
        from sets t join exercises e on e.id = t.exercise_id
        where t.session_id = s.id and t.kind = 'working'
          and set_performed(t.reps, t.distance_m, t.duration_s)
        order by t.exercise_id, t.weight_kg desc nulls last,
          t.reps desc nulls last, t.distance_m desc nulls last
      ) x), '[]') as exercises
  from sessions s
  order by s.date desc, s.id desc
  limit 5`;

  return {
    now,
    week_schedule: weekSchedule ?? null,
    mesocycles,
    recent_sessions: recentSessions,
    user_context: userContext,
  };
}
