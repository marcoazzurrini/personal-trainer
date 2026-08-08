import { Hono } from "@hono/hono";
import { sql } from "../db.ts";
import { ApiError } from "../lib/errors.ts";
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

// Rows of week × exercise: what was actually delivered, to be read against the
// weekly dose the mesocycle's intent states in prose. The plan's numbers left
// the tables when intent became the single source of them, so there is no
// planned-sets row to join here — the comparison happens in the coach's head,
// against GET /mesocycles/:id's intent text.
weeklyExerciseSets.get("/", async (c) => {
  const param = c.req.query("mesocycle") ?? "current";
  // Unlike /weekly-volume, which accepts it. Not an oversight: volume is sets
  // per muscle per calendar week and comparable across years, while week
  // numbers here are relative to a mesocycle's start — week 3 of one plan and
  // week 3 of another are different weeks judged against different doses, and
  // stacking them would put numbers with no shared meaning on one axis.
  if (param === "all") {
    throw new ApiError(
      422,
      '"all" works on GET /api/weekly-volume but not here. These weeks are numbered from a mesocycle\'s start, so week 3 of two different plans are different weeks against different doses — combining them would compare numbers that share no meaning. Pass a mesocycle id, or "current".',
    );
  }
  const m = await resolveMesocycle(param);
  const rows = await sql`
    select v.week, e.name as exercise, v.exercise_id, v.sets_done
    from weekly_exercise_sets_done v
    join exercises e on e.id = v.exercise_id
    where v.mesocycle_id = ${m.id}
    order by v.week, e.name`;
  return c.json({ mesocycle_id: m.id, weekly_exercise_sets: rows });
});
