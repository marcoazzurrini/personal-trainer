import {
  batch,
  type Clock,
  type Database,
  databaseError,
  date,
  decimal,
  instant,
  requestId,
  romeDate,
  rows,
  statement,
  systemClock,
} from "../shared/d1.ts";
import { ApiError, requireRow } from "../shared/errors.ts";
import { bodyweightStore } from "../body/bodyweight.ts";
import { bodyfatStore } from "../body/bodyfat.ts";
import {
  decodeTarget,
  nutritionReadStore,
  type StoredTarget,
  targetColumns,
} from "./read.ts";
import type {
  Computation,
  SetTargetInput,
  TargetRow,
  TargetWritten,
} from "./targets.types.ts";
import {
  energyDensity,
  fatMassKg,
  MAX_LOSS_RATE_PCT_BW_WEEK,
  MAX_RECOMP_DEFICIT_KCAL,
  PROTEIN_G_PER_KG_BW_RANGE,
  PROTEIN_G_PER_KG_FFM_RANGE,
  type ProteinBasis,
  proteinFromMultiplier,
  targetFromRate,
} from "./expenditure.ts";

export function targetStore(db: Database, clock: Clock = systemClock) {
  const { loadTrend } = bodyweightStore(db, clock);
  const { latestBodyfat } = bodyfatStore(db, clock);
  const { currentExpenditure } = nutritionReadStore(db, clock);
  async function listTargets(): Promise<TargetRow[]> {
    return (
      await rows<StoredTarget>(
        db,
        `SELECT ${targetColumns} FROM nutrition_targets ORDER BY effective_from DESC, id DESC`,
      )
    ).map(decodeTarget);
  }
  async function activeTarget(asOf: string): Promise<TargetRow | null> {
    const [row] = await rows<StoredTarget>(
      db,
      `SELECT ${targetColumns} FROM nutrition_targets WHERE effective_from <= ? ORDER BY effective_from DESC, id DESC LIMIT 1`,
      date(asOf),
    );
    return row ? decodeTarget(row) : null;
  }
  async function setTarget(b: SetTargetInput): Promise<TargetWritten> {
    const uuid = requestId(b.request_id);
    const seen = async () => {
      const [row] = await rows<StoredTarget>(
        db,
        `SELECT ${targetColumns} FROM nutrition_targets WHERE request_id = ?`,
        uuid,
      );
      return row ? decodeTarget(row) : undefined;
    };
    const replay = await seen();
    if (replay) return { created: false, body: { target: replay } };
    try {
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
      )
        .filter(([, v]) => v !== undefined && v !== null)
        .map(([k]) => k);
      if (proteinInputs.length !== 1) {
        throw new ApiError(
          422,
          proteinInputs.length === 0
            ? `Send exactly one protein input: "protein_g_per_kg_ffm" (the deficit basis — ${
              PROTEIN_G_PER_KG_FFM_RANGE.join(
                " to ",
              )
            }; muscle retention scales with the mass being retained, not the fat being lost), "protein_g_per_kg_bw" (maintenance or surplus — ${
              PROTEIN_G_PER_KG_BW_RANGE.join(
                " to ",
              )
            }), or "protein_g_target" as a finished number when neither basis fits.`
            : `Send exactly one protein input — got ${
              proteinInputs.join(
                " and ",
              )
            }.`,
        );
      }
      const decision = b.decision;
      const effectiveFrom = date(
        b.effective_from ?? romeDate(instant(clock().toISOString())),
      );
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
        goal === "recomp" &&
        (rate > 0.15 || rate < -MAX_LOSS_RATE_PCT_BW_WEEK)
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
      const bodyfat = (await latestBodyfat())?.percent ?? null;

      // Protein first: it is the one target that does not depend on the
      // expenditure estimate. This computes protein, not a separate persisted
      // target: the calorie branch below must also succeed before either is saved.
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
        const multiplier = (
          basis === "ffm" ? b.protein_g_per_kg_ffm : b.protein_g_per_kg_bw
        )!;
        if (multiplier <= 0 || multiplier > 5) {
          throw new ApiError(
            422,
            `A protein multiplier of ${multiplier} g/kg is outside anything defensible. Deficit: ${
              PROTEIN_G_PER_KG_FFM_RANGE.join(
                "–",
              )
            } g/kg fat-free mass. Maintenance or surplus: ${
              PROTEIN_G_PER_KG_BW_RANGE.join(
                "–",
              )
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
      let computation: Computation | null = null;

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

      // Insert, row readback and effective-history flag share one D1 transaction.
      const result = await batch(db, [
        statement(
          db,
          `INSERT INTO nutrition_targets (effective_from, goal, rate_pct_bw_week, kcal_target, protein_g_target, decision,
          tdee_at_creation, clipped, clipped_reasons, request_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (request_id) DO NOTHING RETURNING id`,
          effectiveFrom,
          goal,
          decimal(rate, 4, 2),
          kcalTarget,
          proteinTarget,
          decision,
          tdeeAtCreation,
          Number(clipped),
          JSON.stringify(clippedReasons),
          uuid,
          instant(clock().toISOString()),
        ),
        statement(
          db,
          `SELECT ${targetColumns} FROM nutrition_targets WHERE request_id = ?`,
          uuid,
        ),
        statement(
          db,
          `SELECT EXISTS (SELECT 1 FROM nutrition_goal_switches WHERE id = -(SELECT id FROM nutrition_targets WHERE request_id = ?)) AS present`,
          uuid,
        ),
      ]);
      const target = decodeTarget(
        requireRow(
          result[1].results as unknown as StoredTarget[],
          "The nutrition target could not be read after saving.",
        ),
      );
      if (!result[0].results.length) {
        return { created: false, body: { target } };
      }
      return {
        created: true,
        body: {
          target,
          computation,
          protein_computation: proteinComputation,
          phase_switch_registered: Boolean(result[2].results[0].present),
        },
      };
    } catch (error) {
      const replay = await seen();
      if (replay) return { created: false, body: { target: replay } };
      throw databaseError(error);
    }
  }
  return { listTargets, activeTarget, setTarget };
}
