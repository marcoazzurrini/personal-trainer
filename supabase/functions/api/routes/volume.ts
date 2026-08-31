import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { sql } from "../db.ts";
import { ApiError } from "../http/errors.ts";
import { resolveMesocycle } from "../record/resolve.ts";
import { deliveredInDoseUnit } from "../rules/training.ts";

// Both endpoints read the views, which already enforce the rules: working
// sets only, performed only, finished weeks only — plus, on weekly_volume
// alone, strength stimulus only.

export const weeklyVolume = new OpenAPIHono();

const MesocycleSelector = z.string().optional().meta({
  description:
    'A mesocycle id, "current", or "current:<track>". Defaults to "current".',
  example: "current:hypertrophy",
});

const VolumeRow = z.object({
  week_start: z.string(),
  muscle: z.string(),
  working_sets: z.number(),
});

type VolumeRowT = z.infer<typeof VolumeRow>;

// Rows of week × muscle. One row per muscle, never a total. Defaults to the
// current mesocycle's own sets; ?mesocycle=all for everything ever lifted.
weeklyVolume.openapi(
  createRoute({
    method: "get",
    path: "/",
    tags: ["Training"],
    summary: "Working sets per muscle per week",
    request: {
      query: z.object({
        mesocycle: MesocycleSelector.meta({
          description:
            'A mesocycle id, "current", or "current:<track>". "all" re-sums across every plan, off-plan work included. Defaults to "current".',
        }),
      }),
    },
    responses: {
      200: {
        description:
          "One row per muscle per week, never a total. `mesocycle_id` is absent under `?mesocycle=all`, which is not attributed to any plan.",
        content: {
          "application/json": {
            schema: z.object({
              mesocycle_id: z.int().optional(),
              weekly_volume: z.array(VolumeRow),
            }),
          },
        },
      },
    },
  }),
  async (c) => {
    const param = c.req.query("mesocycle") ?? "current";
    if (param === "all") {
      // Re-summed across plans, off-plan work included: a muscle does not care
      // which plan loaded it, and the long view is about the muscle.
      const rows = await sql<VolumeRowT[]>`
      select week_start, muscle, sum(working_sets)::float8 as working_sets
      from weekly_volume
      group by week_start, muscle
      order by week_start, muscle`;
      return c.json({ weekly_volume: rows });
    }
    // Attribution, not calendar. A date-range filter here once swept another
    // overlapping plan's sets — and any off-plan lifting — into this plan's
    // numbers, while the response echoed a mesocycle_id it wasn't honouring.
    const m = await resolveMesocycle(param);
    const rows = await sql<VolumeRowT[]>`
    select week_start, muscle, working_sets from weekly_volume
    where mesocycle_id = ${m.id}
    order by week_start, muscle`;
    return c.json({ mesocycle_id: m.id, weekly_volume: rows });
  },
);

export const weeklyExerciseSets = new OpenAPIHono();

const ExerciseWeek = z.object({
  week: z.int(),
  exercise: z.string(),
  exercise_id: z.int(),
  measure: z.string(),
  sets_done: z.number(),
  distance_m: z.number().nullable(),
  duration_s: z.number().nullable(),
  dose: z.number().nullable(),
  dose_unit: z.string().nullable(),
  // The dose's own unit, so adherence is a subtraction rather than a
  // conversion. Null when no dose was in force that week.
  delivered: z.number().nullable(),
});

// Rows of week × exercise: what the plan asked for each week beside what was
// delivered. Both come back in the dose's own unit, so adherence is one
// subtraction rather than a unit conversion the caller has to get right —
// and the raw sets, metres and seconds come too, because a dose in km says
// nothing about how many efforts it took to cover.
//
// The dose is the dose that was in force during that week, from the history
// table — not the plan's current dose. Before the history existed a redose
// silently rewrote what every past week was judged against, and the only
// recovery was reading prose out of the decision log.
weeklyExerciseSets.openapi(
  createRoute({
    method: "get",
    path: "/",
    tags: ["Training"],
    summary: "Dose against delivery, per exercise per week",
    request: { query: z.object({ mesocycle: MesocycleSelector }) },
    responses: {
      200: {
        description:
          "One row per exercise per week of the mesocycle, each carrying the dose that was in force at that week's end rather than the plan's current dose.",
        content: {
          "application/json": {
            schema: z.object({
              mesocycle_id: z.int(),
              track: z.string(),
              weekly_exercise_sets: z.array(ExerciseWeek),
            }),
          },
        },
      },
      422: {
        description:
          '"all" is refused here: these weeks are numbered from a mesocycle\'s start, so week 3 of two plans share no meaning.',
      },
    },
  }),
  async (c) => {
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
    const rows = await sql<
      Array<Omit<z.infer<typeof ExerciseWeek>, "delivered">>
    >`
    select v.week, e.name as exercise, v.exercise_id, e.measure,
      v.sets_done, v.distance_m, v.duration_s,
      d.weekly_dose::float8 as dose, d.weekly_dose_unit as dose_unit
    from weekly_exercise_sets_done v
    join exercises e on e.id = v.exercise_id
    -- The dose in force at the week's end: a redose decided mid-week is what
    -- that week's delivery was steered at, so the week's Sunday is the
    -- honest as-of point. Left, not inner: an exercise revised out of the
    -- plan keeps the work it delivered while it was in it, judged against
    -- the dose it was actually asked for at the time.
    left join lateral (
      select weekly_dose, weekly_dose_unit
      from mesocycle_exercise_doses d
      where d.mesocycle_id = v.mesocycle_id
        and d.exercise_id = v.exercise_id
        and d.effective_from <= ${m.started_on}::date + v.week * 7 - 1
      order by d.effective_from desc, d.id desc
      limit 1
    ) d on true
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
  },
);
