import { Hono } from "@hono/hono";
import { sql } from "../db.ts";
import { ApiError } from "../lib/errors.ts";
import { resolveMesocycle } from "../lib/resolve.ts";
import { deliveredInDoseUnit } from "../lib/training.ts";

// Both endpoints read the views, which already enforce the rules: working
// sets only, performed only, finished weeks only — plus, on weekly_volume
// alone, strength stimulus only.

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

// Rows of week × exercise: what the plan asked for each week beside what was
// delivered. Both come back in the dose's own unit, so adherence is one
// subtraction rather than a unit conversion the caller has to get right —
// and the raw sets, metres and seconds come too, because a dose in km says
// nothing about how many efforts it took to cover.
//
// The dose is the plan's current dose, not the dose in force during an
// earlier week: mesocycle_exercises holds one flat number, and a dose that
// changed mid-mesocycle changed by revision, so the decision log is where
// the earlier one is recorded.
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
      '"all" works on GET /weekly-volume but not here. These weeks are numbered from a mesocycle\'s start, so week 3 of two different plans are different weeks against different doses — combining them would compare numbers that share no meaning. Pass a mesocycle id, "current", or "current:<track>".',
    );
  }
  const m = await resolveMesocycle(param);
  const rows = await sql`
    select v.week, e.name as exercise, v.exercise_id, e.measure,
      v.sets_done, v.distance_m, v.duration_s,
      me.weekly_dose::float8 as dose, me.weekly_dose_unit as dose_unit
    from weekly_exercise_sets_done v
    join exercises e on e.id = v.exercise_id
    -- Left, not inner: an exercise revised out of the plan keeps the work it
    -- delivered while it was in it. Its dose is gone, which is the truth.
    left join mesocycle_exercises me
      on me.mesocycle_id = v.mesocycle_id and me.exercise_id = v.exercise_id
    where v.mesocycle_id = ${m.id}
    order by v.week, e.name`;

  return c.json({
    mesocycle_id: m.id,
    track: m.track,
    weekly_exercise_sets: rows.map((r) => ({
      ...r,
      delivered: r.dose_unit === null ? null : deliveredInDoseUnit(
        r.dose_unit,
        r.sets_done,
        r.distance_m,
        r.duration_s,
      ),
    })),
  });
});
