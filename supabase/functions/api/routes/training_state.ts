import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { sql } from "../db.ts";
import { docExists } from "../doc_names.ts";
import { romeDate, romeWeekStart } from "../record/calendar.ts";
import { deliveredInDoseUnit } from "../rules/training.ts";

// The composite: everything true about the training as of now. A view over
// things that each have their own address — nothing here is only obtainable
// through this bundle.
//
// Plans are plural. Hypertrophy and speed run side by side, each with its own
// start Monday and so its own week number, its own dose to be judged against,
// and its own method document. What they share is the week: one schedule, one
// list of recent sessions, one person.
export const trainingState = new OpenAPIHono();

const ContextEntry = z.object({
  topic: z.string(),
  content: z.string(),
  written_at: z.string(),
});

const WeekSchedule = z.object({
  week_start: z.string(),
  schedule: z.string(),
  written_at: z.string(),
});

const PlanExercise = z.object({
  exercise: z.string(),
  measure: z.string(),
  role: z.string(),
  priority: z.int(),
  notes: z.string().nullable(),
  // Not nullable here, unlike in the weekly-volume read: this dose comes
  // straight off the plan, where both columns are required. There it is a
  // left join against the dose history, which an exercise revised out of the
  // plan can legitimately miss.
  dose: z.number(),
  dose_unit: z.string(),
  sets_done: z.int(),
  distance_m: z.number().nullable(),
  duration_s: z.number().nullable(),
  // How long since this lift was last performed — a fact about the lift and
  // the body, not about which plan asked for it, so it is not scoped to one.
  days_since_trained: z.int().nullable(),
  // In the dose's own unit, so adherence is a subtraction rather than a
  // conversion the caller has to get right.
  delivered_this_week: z.number(),
});

const RecentWeek = z.object({
  week: z.int(),
  working_sets_done: z.int(),
  sessions_done: z.int(),
});

const RecentDecision = z.object({
  id: z.int(),
  made_at: z.string(),
  what_changed: z.string(),
  why: z.string(),
});

const ActiveMesocycle = z.object({
  id: z.int(),
  name: z.string(),
  track: z.string(),
  // The plan's judgment, in prose. Never arithmetic.
  intent: z.string(),
  // Null before the plan's first Monday.
  week: z.int().nullable(),
  planned_weeks: z.int(),
  started_on: z.string(),
  // Where the method for this track is written, or null with a note saying
  // the plan is coached from general knowledge — stated by the API rather
  // than left for the coach to discover.
  method_doc: z.string().nullable(),
  method_note: z.string().nullable(),
  exercises: z.array(PlanExercise),
  this_week: z.object({
    sessions_done: z.int(),
    sessions_per_week: z.int(),
  }),
  recent_weeks: z.array(RecentWeek),
  recent_decisions: z.array(RecentDecision),
});

const SessionExercise = z.object({
  exercise: z.string(),
  mesocycle_id: z.int().nullable(),
  working_sets: z.int(),
  top_weight_kg: z.number().nullable(),
  top_reps: z.int().nullable(),
  top_distance_m: z.number().nullable(),
  top_duration_s: z.number().nullable(),
  top_effort: z.string().nullable(),
});

const RecentSession = z.object({
  id: z.int(),
  date: z.string(),
  rationale: z.string().nullable(),
  notes: z.string().nullable(),
  overall_feel: z.string().nullable(),
  exercises: z.array(SessionExercise),
});

// Two shapes in one schema. With no active mesocycle the answer is a `note`
// routing to onboarding or to programming, and `recent_sessions` is not
// fetched at all — there is nothing to read them against yet.
const TrainingState = z.object({
  today: z.string(),
  week_schedule: WeekSchedule.nullable(),
  mesocycles: z.array(ActiveMesocycle),
  note: z.string().optional(),
  recent_sessions: z.array(RecentSession).optional(),
  user_context: z.array(ContextEntry),
});

trainingState.openapi(
  createRoute({
    method: "get",
    path: "/",
    tags: ["Training"],
    summary: "Everything true about the training, as of now",
    description:
      "The read that opens a training conversation. Plans are plural — hypertrophy and speed run side by side, each with its own week number, its own dose and its own method document. What they share is the week: one schedule, one list of recent sessions, one person. With no active plan the answer carries a `note` routing to onboarding or programming instead.",
    responses: {
      200: {
        description: "The complete current training picture.",
        content: { "application/json": { schema: TrainingState } },
      },
    },
  }),
  async (c) => {
    const [clock] = await sql`
    select ${romeDate()} as today,
      ${romeWeekStart()} as week_start`;

    const userContext = await sql<z.infer<typeof ContextEntry>[]>`
    select distinct on (topic) topic, content, written_at
    from user_context
    order by topic, written_at desc, id desc`;

    const [weekSchedule] = await sql<z.infer<typeof WeekSchedule>[]>`
    select week_start, schedule, written_at from week_schedules
    where week_start = ${clock.week_start}`;

    const active = await sql`
    select id, name, track, intent, planned_weeks, sessions_per_week,
      started_on,
      ((((${romeDate()}) - started_on) / 7) + 1)::int as week
    from mesocycles where ended_on is null
    order by track`;

    if (active.length === 0) {
      // The cold start routes to onboarding; a known person routes to planning.
      const note = userContext.length === 0
        ? "No active mesocycle and no user context: this is a first conversation. Start with GET /docs/tasks/onboarding — do not program anything yet."
        : "No active mesocycle. Fetch GET /docs/tasks/programming, then create one with POST /mesocycles (blocks via POST /blocks).";
      return c.json({
        today: clock.today as string,
        mesocycles: [],
        note,
        week_schedule: weekSchedule ?? null,
        user_context: userContext,
      });
    }

    const mesocycles: z.infer<typeof ActiveMesocycle>[] = [];
    for (const meso of active) {
      const week = meso.week < 1 ? null : meso.week;

      // The plan's exercises with, per exercise: the dose, what this week has
      // delivered against it in the dose's own unit, and staleness.
      //
      // Delivery is scoped to this plan — the same work cannot count twice for
      // two plans — while staleness is not: how long since the last squat is a
      // fact about the lift and the body, not about which plan asked for it.
      const exercises = await sql<
        Array<Omit<z.infer<typeof PlanExercise>, "delivered_this_week">>
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
          and s.date >= ${clock.week_start}
      ) d on true
      where me.mesocycle_id = ${meso.id}
      order by me.priority, e.name`;

      const [thisWeek] = await sql`
      select count(distinct s.id)::int as sessions_done
      from sessions s
      join sets t on t.session_id = s.id
      where t.mesocycle_id = ${meso.id} and s.date >= ${clock.week_start}
        and set_performed(t.reps, t.distance_m, t.duration_s)`;

      // The last few finished weeks: what was delivered. Judging it against the
      // doses (and the decision log's adjustments) is the coach's job.
      const recentWeeks = week === null ? [] : await sql<
        z.infer<typeof RecentWeek>[]
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
      const recentDecisions = await sql<z.infer<typeof RecentDecision>[]>`
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
    const recentSessions = await sql<z.infer<typeof RecentSession>[]>`
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

    return c.json({
      today: clock.today as string,
      week_schedule: weekSchedule ?? null,
      mesocycles,
      recent_sessions: recentSessions,
      user_context: userContext,
    });
  },
);
