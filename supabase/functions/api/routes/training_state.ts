import { Hono } from "@hono/hono";
import { sql } from "../db.ts";

// The composite: everything true about the training as of now. A view over
// things that each have their own address — nothing here is only obtainable
// through this bundle.
export const trainingState = new Hono();

trainingState.get("/", async (c) => {
  const [clock] = await sql`
    select (now() at time zone 'Europe/Rome')::date as today,
      date_trunc('week', now() at time zone 'Europe/Rome')::date as week_start`;

  const userContext = await sql`
    select distinct on (topic) topic, content, written_at
    from user_context
    order by topic, written_at desc, id desc`;

  const [meso] = await sql`
    select id, name, intent, planned_weeks, sessions_per_week, started_on,
      ((((now() at time zone 'Europe/Rome')::date - started_on) / 7) + 1)::int as week
    from mesocycles where ended_on is null`;

  if (!meso) {
    // The cold start routes to onboarding; a known person routes to planning.
    const note = userContext.length === 0
      ? "No active mesocycle and no user context: this is a first conversation. Start with GET /api/docs/tasks/onboarding — do not program anything yet."
      : "No active mesocycle. Fetch GET /api/docs/tasks/programming, then create one with POST /api/mesocycles (blocks via POST /api/blocks).";
    return c.json({
      today: clock.today,
      mesocycle: null,
      note,
      user_context: userContext,
    });
  }

  const week = meso.week < 1 ? null : meso.week;

  // The fixed list with, per exercise: this week's plan, this week's delivery
  // so far, and staleness.
  const exercises = await sql`
    select e.name as exercise, me.role, me.priority, me.notes,
      (select ws.sets from mesocycle_weekly_exercise_sets ws
       where ws.mesocycle_exercise_id = me.id and ws.week = ${week}) as planned_sets_this_week,
      (select count(*)::int from sets t
       join sessions s on s.id = t.session_id
       where t.exercise_id = me.exercise_id and t.kind = 'working'
         and t.reps is not null and s.date >= ${clock.week_start}) as sets_done_this_week,
      ((now() at time zone 'Europe/Rome')::date -
       (select max(s.date) from sets t
        join sessions s on s.id = t.session_id
        where t.exercise_id = me.exercise_id and t.reps is not null)) as days_since_trained
    from mesocycle_exercises me
    join exercises e on e.id = me.exercise_id
    where me.mesocycle_id = ${meso.id}
    order by me.priority, e.name`;

  const [thisWeek] = await sql`
    select count(*)::int as sessions_done
    from sessions s
    where s.mesocycle_id = ${meso.id} and s.date >= ${clock.week_start}
      and exists (select 1 from sets t where t.session_id = s.id and t.reps is not null)`;

  // The last few finished weeks: planned against delivered, and sessions.
  const recentWeeks = week === null ? [] : await sql`
    select g.w as week,
      coalesce((select sum(ws.sets)::int
        from mesocycle_weekly_exercise_sets ws
        join mesocycle_exercises me on me.id = ws.mesocycle_exercise_id
        join exercises e on e.id = me.exercise_id
        where me.mesocycle_id = ${meso.id} and ws.week = g.w
          and e.stimulus_type = 'strength'), 0) as working_sets_planned,
      coalesce((select sum(v.sets_done)::int
        from weekly_exercise_sets_done v
        where v.mesocycle_id = ${meso.id} and v.week = g.w), 0) as working_sets_done,
      (select count(*)::int from sessions s
       where s.mesocycle_id = ${meso.id}
         and s.date >= ${meso.started_on}::date + (g.w - 1) * 7
         and s.date < ${meso.started_on}::date + g.w * 7
         and exists (select 1 from sets t where t.session_id = s.id and t.reps is not null)) as sessions_done
    from generate_series(greatest(1, ${week} - 3), ${week} - 1) g(w)
    order by g.w`;

  // Last five sessions: working sets only, top set per exercise.
  const recentSessions = await sql`
    select s.id, s.date, s.rationale, s.notes, s.overall_feel,
      coalesce((select json_agg(x order by x.exercise)
        from (
          select distinct on (t.exercise_id) e.name as exercise,
            count(*) over (partition by t.exercise_id)::int as working_sets,
            t.weight_kg::float8 as top_weight_kg, t.reps as top_reps, t.effort as top_effort
          from sets t join exercises e on e.id = t.exercise_id
          where t.session_id = s.id and t.kind = 'working' and t.reps is not null
          order by t.exercise_id, t.weight_kg desc, t.reps desc
        ) x), '[]') as exercises
    from sessions s
    where s.mesocycle_id = ${meso.id}
    order by s.date desc, s.id desc
    limit 5`;

  return c.json({
    today: clock.today,
    mesocycle: {
      id: meso.id,
      name: meso.name,
      intent: meso.intent,
      week,
      planned_weeks: meso.planned_weeks,
      started_on: meso.started_on,
    },
    exercises,
    this_week: {
      sessions_done: thisWeek.sessions_done,
      sessions_per_week: meso.sessions_per_week,
    },
    recent_weeks: recentWeeks,
    recent_sessions: recentSessions,
    user_context: userContext,
  });
});
