import { Hono } from "@hono/hono";
import { sql } from "../db.ts";
import { resolveMesocycle } from "../lib/resolve.ts";

// Both endpoints read the views, which already enforce the rules: working
// sets only, performed only, strength stimulus only, finished weeks only.

export const weeklyVolume = new Hono();

// Rows of week × muscle. One row per muscle, never a total. Defaults to the
// current mesocycle's date range; ?mesocycle=all for everything.
weeklyVolume.get("/", async (c) => {
  const param = c.req.query("mesocycle") ?? "current";
  if (param === "all") {
    const rows = await sql`
      select week_start, muscle, working_sets from weekly_volume
      order by week_start, muscle`;
    return c.json({ weekly_volume: rows });
  }
  const m = await resolveMesocycle(param);
  const rows = await sql`
    select week_start, muscle, working_sets from weekly_volume
    where week_start >= ${m.started_on}
      and week_start <= coalesce(${m.ended_on}, (now() at time zone 'Europe/Rome')::date)
    order by week_start, muscle`;
  return c.json({ mesocycle_id: m.id, weekly_volume: rows });
});

export const weeklyExerciseSets = new Hono();

// Rows of week × exercise: the direct comparison partner of the planned
// weekly sets in GET /mesocycles/:id. Reviewing = the two side by side.
weeklyExerciseSets.get("/", async (c) => {
  const m = await resolveMesocycle(c.req.query("mesocycle") ?? "current");
  const rows = await sql`
    select v.week, e.name as exercise, v.exercise_id, v.sets_done
    from weekly_exercise_sets_done v
    join exercises e on e.id = v.exercise_id
    where v.mesocycle_id = ${m.id}
    order by v.week, e.name`;
  return c.json({ mesocycle_id: m.id, weekly_exercise_sets: rows });
});
