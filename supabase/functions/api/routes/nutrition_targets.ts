import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { sql } from "../db.ts";
import { ApiError } from "../http/errors.ts";
import {
  energyDensity,
  fatMassKg,
  GOALS,
  MAX_LOSS_RATE_PCT_BW_WEEK,
  MAX_RECOMP_DEFICIT_KCAL,
  PROTEIN_G_PER_KG_BW_RANGE,
  PROTEIN_G_PER_KG_FFM_RANGE,
  type ProteinBasis,
  proteinFromMultiplier,
  targetFromRate,
} from "../rules/expenditure.ts";
import {
  activeTarget,
  currentExpenditure,
  latestBodyfat,
  loadTrend,
  romeToday,
} from "../record/nutrition_read.ts";
import {
  body,
  number,
  oneOf,
  optionalDate,
  optionalInt,
  optionalNumber,
  requestId,
  text,
} from "../http/schema.ts";

// The goal, expressed as a rate of bodyweight change. Append-only: the latest
// effective_from is active and the history is the record of the phase
// structure. A target is never edited — a changed mind is a new row saying why.

export const nutritionTargets = new OpenAPIHono();

const CLIP_REASONS = ["rate", "deficit", "recomp_deficit", "surplus"] as const;

const Target = z.object({
  id: z.int(),
  effective_from: z.string(),
  goal: z.enum(GOALS),
  rate_pct_bw_week: z.number(),
  kcal_target: z.int(),
  protein_g_target: z.int(),
  decision: z.string(),
  clipped: z.boolean(),
  clipped_reasons: z.array(z.enum(CLIP_REASONS)),
  tdee_at_creation: z.int().nullable(),
  created_at: z.string(),
});

type TargetRow = z.infer<typeof Target>;

// The arithmetic, returned so the coach can quote it rather than redo it.
// Null when kcal_target was sent explicitly: nothing was computed, and an
// object of zeroes would read as though something had been.
const Computation = z.object({
  tdee_kcal: z.int(),
  band_kcal: z.int().nullable(),
  expenditure_status: z.enum(["ok", "damped", "stale", "insufficient_data"]),
  trend_weight_kg: z.number(),
  energy_density_kcal_per_kg: z.int(),
  rate_requested: z.number(),
  rate_used: z.number(),
  desired_slope_kg_per_day: z.number(),
  implied_deficit_kcal: z.number(),
  clipped: z.boolean(),
  clipped_reasons: z.array(z.enum(CLIP_REASONS)),
}).nullable();

const ProteinComputationSchema = z.object({
  protein_g_target: z.int(),
  basis: z.enum(["ffm", "bodyweight"]),
  multiplier_g_per_kg: z.number(),
  basis_mass_kg: z.number(),
}).nullable();

const SELECT_TARGET = sql`
  select id, effective_from, goal, rate_pct_bw_week::float8, kcal_target,
    protein_g_target, decision, clipped, clipped_reasons, tdee_at_creation,
    created_at
  from nutrition_targets`;

nutritionTargets.openapi(
  createRoute({
    method: "get",
    path: "/",
    tags: ["Nutrition"],
    summary: "Every target ever set, and the one in force",
    responses: {
      200: {
        description:
          "The full history under `targets`, newest first, and the one governing today under `active`.",
        content: {
          "application/json": {
            schema: z.object({
              targets: z.array(Target),
              active: Target.nullable(),
            }),
          },
        },
      },
    },
  }),
  async (c) => {
    const rows = await sql<TargetRow[]>`
    ${SELECT_TARGET} order by effective_from desc, id desc`;
    return c.json({
      targets: rows,
      active: await activeTarget(await romeToday()) as TargetRow | null,
    });
  },
);

nutritionTargets.openapi(
  createRoute({
    method: "post",
    path: "/",
    tags: ["Nutrition"],
    summary: "Set a target",
    description:
      "Exactly one protein input is required: `protein_g_per_kg_ffm` on a deficit, `protein_g_per_kg_bw` at maintenance or in a surplus, or `protein_g_target` as a finished number when neither basis fits. kcal is computed from `rate_pct_bw_week` unless `kcal_target` is sent explicitly.",
    request: {
      body: {
        content: {
          "application/json": {
            schema: body({
              goal: oneOf(GOALS),
              effective_from: optionalDate(),
              kcal_target: optionalInt({ min: 1 }),
              protein_g_target: optionalInt({ min: 1 }),
              protein_g_per_kg_ffm: optionalNumber(),
              protein_g_per_kg_bw: optionalNumber(),
              rate_pct_bw_week: number(),
              decision: text(),
              request_id: requestId(),
            }),
          },
        },
      },
    },
    responses: {
      201: {
        description:
          "The target that was set, the arithmetic behind it, and whether the change of goal registered a phase switch.",
        content: {
          "application/json": {
            schema: z.object({
              target: Target,
              computation: Computation,
              protein_computation: ProteinComputationSchema,
              phase_switch_registered: z.boolean(),
            }),
          },
        },
      },
      200: {
        description:
          "The target this request_id already set. A retry, answered with the original row alone.",
        content: {
          "application/json": { schema: z.object({ target: Target }) },
        },
      },
      422: {
        description:
          "The rate contradicts the goal, the protein inputs are not exactly one, or there is not enough history to compute a target.",
      },
    },
  }),
  async (c) => {
    const b = c.req.valid("json");

    const [seen] = await sql`
      select id from nutrition_targets where request_id = ${b.request_id}`;
    if (seen) {
      const [row] = await sql<TargetRow[]>`
        ${SELECT_TARGET} where id = ${seen.id}`;
      return c.json({ target: row }, 200);
    }

    const goal = b.goal;
    const rate = b.rate_pct_bw_week;

    // Protein is computed from a multiplier, like kcal is computed from a rate.
    // The multiplier is the coach's judgment; multiplying it by fat-free mass is
    // arithmetic, and arithmetic does not happen in the model's head. An
    // explicit gram figure stays available for cases the multipliers don't fit.
    //
    // "Exactly one of three" is a relationship between fields rather than a
    // fact about any one of them, so it stays here rather than becoming a
    // schema refinement: the message has to name which ones actually arrived.
    const proteinInputs = (
      [
        ["protein_g_per_kg_ffm", b.protein_g_per_kg_ffm],
        ["protein_g_per_kg_bw", b.protein_g_per_kg_bw],
        ["protein_g_target", b.protein_g_target],
      ] as const
    ).filter(([, v]) => v !== undefined && v !== null).map(([k]) => k);
    if (proteinInputs.length !== 1) {
      throw new ApiError(
        422,
        proteinInputs.length === 0
          ? `Send exactly one protein input: "protein_g_per_kg_ffm" (the deficit basis — ${
            PROTEIN_G_PER_KG_FFM_RANGE.join(" to ")
          }; muscle retention scales with the mass being retained, not the fat being lost), "protein_g_per_kg_bw" (maintenance or surplus — ${
            PROTEIN_G_PER_KG_BW_RANGE.join(" to ")
          }), or "protein_g_target" as a finished number when neither basis fits.`
          : `Send exactly one protein input — got ${
            proteinInputs.join(" and ")
          }.`,
      );
    }
    const decision = b.decision;
    const effectiveFrom = b.effective_from ?? await romeToday();
    const explicitKcal = b.kcal_target ?? null;

    // The direction must match the goal. Catching this here rather than letting
    // a sign slip through is the difference between a cut and an accidental
    // bulk — the rate is the one number the whole loop steers on.
    if (goal === "cut" && rate >= 0) {
      throw new ApiError(
        422,
        `A cut needs a negative rate_pct_bw_week (got ${rate}). Default -0.5, never past -0.7: faster costs lean mass in trained people.`,
      );
    }
    if (goal === "gain" && rate <= 0) {
      throw new ApiError(
        422,
        `A gain needs a positive rate_pct_bw_week (got ${rate}). +0.25 to +0.5 for a trained lifter; past that is mostly fat.`,
      );
    }
    if (goal === "maintain" && Math.abs(rate) > 0.15) {
      throw new ApiError(
        422,
        `A ${goal} target holds bodyweight roughly flat — rate_pct_bw_week should be near 0 (got ${rate}). If a real rate of change is intended, the goal is a cut or a gain.`,
      );
    }
    // Recomp's real bound is in kcal — maintenance to a 200 kcal/day deficit —
    // and the rate a deficit implies moves with bodyweight, so the rate gate
    // here is only a sanity check against absurdity. A ±0.15 band once lived
    // here; it capped recomp at roughly half the doctrine's floor and told
    // doctrine-compliant requests to relabel themselves as cuts, which then
    // registered a phase switch that never happened.
    if (
      goal === "recomp" && (rate > 0.15 || rate < -MAX_LOSS_RATE_PCT_BW_WEEK)
    ) {
      throw new ApiError(
        422,
        `A recomp holds bodyweight or drops it slowly — rate_pct_bw_week between -${MAX_LOSS_RATE_PCT_BW_WEEK} and +0.15 (got ${rate}). The kcal target is clipped to a ${MAX_RECOMP_DEFICIT_KCAL} kcal/day deficit whatever the rate implies, so a doctrine recomp needs no relabelling as a cut.`,
      );
    }

    const trend = await loadTrend();
    if (trend.length === 0) {
      throw new ApiError(
        422,
        "No bodyweight history, so neither a calorie target nor a protein target can be computed. Log a weigh-in first.",
      );
    }
    const trendNow = trend[trend.length - 1].trend_kg;
    const bodyfat = await latestBodyfat();

    // Protein first: it is the one target that does not depend on the
    // expenditure estimate, so it still resolves when the estimate does not.
    let proteinTarget: number;
    let proteinComputation = null;
    const explicitProtein = b.protein_g_target ?? null;
    if (explicitProtein !== null) {
      proteinTarget = explicitProtein;
    } else {
      const basis: ProteinBasis = b.protein_g_per_kg_ffm !== undefined &&
          b.protein_g_per_kg_ffm !== null
        ? "ffm"
        : "bodyweight";
      const multiplier =
        (basis === "ffm" ? b.protein_g_per_kg_ffm : b.protein_g_per_kg_bw)!;
      if (multiplier <= 0 || multiplier > 5) {
        throw new ApiError(
          422,
          `A protein multiplier of ${multiplier} g/kg is outside anything defensible. Deficit: ${
            PROTEIN_G_PER_KG_FFM_RANGE.join("–")
          } g/kg fat-free mass. Maintenance or surplus: ${
            PROTEIN_G_PER_KG_BW_RANGE.join("–")
          } g/kg bodyweight.`,
        );
      }
      if (basis === "ffm" && bodyfat === null) {
        throw new ApiError(
          422,
          'Fat-free mass needs a body-fat estimate and there is none on record. POST /bodyfat with a rough figure (BIA, DXA, or an honest visual guess), or send "protein_g_per_kg_bw" to use bodyweight as the basis instead.',
        );
      }
      proteinComputation = proteinFromMultiplier(
        basis,
        multiplier,
        trendNow,
        bodyfat,
      );
      proteinTarget = proteinComputation.protein_g_target;
    }

    let tdeeAtCreation: number | null = null;
    let clipped = false;
    let clippedReasons: string[] = [];
    let kcalTarget: number;
    let computation = null;

    if (explicitKcal !== null) {
      kcalTarget = explicitKcal;
    } else {
      // The normal path: rate in, kcal out, arithmetic on the server.
      const expenditure = await currentExpenditure(trend);
      if (expenditure.tdee_kcal === null) {
        throw new ApiError(
          422,
          `A target cannot be computed yet: ${expenditure.reason} Send an explicit "kcal_target" only if you have a defensible reason for the number and say so in the decision — a formula-derived guess presented as this system's answer is an invention.`,
        );
      }
      const density = energyDensity(fatMassKg(trendNow, bodyfat!));
      const computed = targetFromRate(
        expenditure.tdee_kcal,
        rate,
        trendNow,
        density,
        goal,
      );
      kcalTarget = computed.kcal_target;
      clipped = computed.clipped;
      clippedReasons = computed.clipped_reasons;
      tdeeAtCreation = expenditure.tdee_kcal;
      computation = {
        tdee_kcal: expenditure.tdee_kcal,
        band_kcal: expenditure.band_kcal,
        expenditure_status: expenditure.status,
        trend_weight_kg: trendNow,
        energy_density_kcal_per_kg: Math.round(density),
        rate_requested: computed.rate_requested,
        rate_used: computed.rate_used,
        desired_slope_kg_per_day: computed.desired_slope_kg_per_day,
        implied_deficit_kcal: computed.implied_deficit_kcal,
        clipped: computed.clipped,
        clipped_reasons: computed.clipped_reasons,
      };
    }

    const previous = await activeTarget(effectiveFrom);

    const [row] = await sql<TargetRow[]>`
    insert into nutrition_targets
      (effective_from, goal, rate_pct_bw_week, kcal_target, protein_g_target,
       decision, tdee_at_creation, clipped, clipped_reasons, request_id)
    values
      (${effectiveFrom}, ${goal}, ${rate}, ${kcalTarget}, ${proteinTarget},
       ${decision}, ${tdeeAtCreation}, ${clipped}, ${sql.array(clippedReasons)},
       ${b.request_id})
    returning id, effective_from, goal, rate_pct_bw_week::float8, kcal_target,
      protein_g_target, decision, clipped, clipped_reasons, tdee_at_creation,
      created_at`;

    // A change of goal is a phase switch, and a phase switch moves 1–2 kg of
    // water within days. Registered automatically so the expenditure estimate
    // damps through it — the coach should not have to remember to do this, and
    // forgetting would make the next check-in read the water as metabolism.
    if (previous && previous.goal !== goal) {
      await sql`
      insert into nutrition_events (day, kind, note)
      values (${effectiveFrom}, 'phase_switch',
        ${`${previous.goal} -> ${goal}`})`;
    }

    return c.json({
      target: row,
      computation: computation as z.infer<typeof Computation>,
      protein_computation: proteinComputation,
      phase_switch_registered: Boolean(previous && previous.goal !== goal),
    }, 201);
  },
);
