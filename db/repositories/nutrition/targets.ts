import { desc, eq, lte, sql } from "drizzle-orm";

import type { Client } from "../../client.ts";
import { classifyDatabaseFailure } from "../../errors.ts";
import {
  nutrition_goal_switches,
  nutrition_targets,
} from "../../schema/index.ts";
import { scaledInteger } from "../../storage.ts";
import { expenditureRepository } from "./expenditure.ts";

export type TargetGoal = "cut" | "maintain" | "gain" | "recomp";
export type TargetClipReason =
  | "rate"
  | "deficit"
  | "recomp_deficit"
  | "surplus";

export interface TargetRecord {
  id: number;
  effective_from: string;
  goal: TargetGoal;
  rate_pct_bw_week: number;
  kcal_target: number;
  protein_g_target: number;
  decision: string;
  clipped: boolean;
  clipped_reasons: TargetClipReason[];
  tdee_at_creation: number | null;
  created_at: string;
}

export interface SaveTargetInput {
  effective_from: string;
  goal: TargetGoal;
  rate_pct_bw_week: number;
  kcal_target: number;
  protein_g_target: number;
  decision: string;
  clipped: boolean;
  clipped_reasons: TargetClipReason[];
  tdee_at_creation: number | null;
  request_id: string;
  created_at: string;
}

const projection = {
  id: nutrition_targets.id,
  effective_from: nutrition_targets.effective_from,
  // The table CHECK restricts the stored goal to these four values.
  goal: sql<TargetGoal>`${nutrition_targets.goal}`,
  rate_pct_bw_week: sql<number>`${nutrition_targets.rate_pct_bw_week} / 100.0`,
  kcal_target: nutrition_targets.kcal_target,
  protein_g_target: nutrition_targets.protein_g_target,
  decision: nutrition_targets.decision,
  clipped: nutrition_targets.clipped,
  clipped_reasons: nutrition_targets.clipped_reasons,
  tdee_at_creation: nutrition_targets.tdee_at_creation,
  created_at: nutrition_targets.created_at,
};

type StoredTarget = Omit<TargetRecord, "clipped" | "clipped_reasons"> & {
  clipped: number;
  clipped_reasons: string;
};

function decodeTarget(row: StoredTarget): TargetRecord {
  return {
    ...row,
    clipped: Boolean(row.clipped),
    clipped_reasons: JSON.parse(row.clipped_reasons),
  };
}

export function targetsRepository(db: Client) {
  async function list(): Promise<TargetRecord[]> {
    try {
      return (
        await db
          .select(projection)
          .from(nutrition_targets)
          .orderBy(
            desc(nutrition_targets.effective_from),
            desc(nutrition_targets.id)
          )
      ).map(decodeTarget);
    } catch (error) {
      throw classifyDatabaseFailure(error);
    }
  }

  async function active(asOf: string): Promise<TargetRecord | null> {
    try {
      const [row] = await db
        .select(projection)
        .from(nutrition_targets)
        .where(lte(nutrition_targets.effective_from, asOf))
        .orderBy(
          desc(nutrition_targets.effective_from),
          desc(nutrition_targets.id)
        )
        .limit(1);
      return row ? decodeTarget(row) : null;
    } catch (error) {
      throw classifyDatabaseFailure(error);
    }
  }

  async function findRequest(
    requestId: string
  ): Promise<TargetRecord | undefined> {
    try {
      const [row] = await db
        .select(projection)
        .from(nutrition_targets)
        .where(eq(nutrition_targets.request_id, requestId));
      return row ? decodeTarget(row) : undefined;
    } catch (error) {
      throw classifyDatabaseFailure(error);
    }
  }

  async function save(input: SaveTargetInput): Promise<{
    created: boolean;
    target: TargetRecord | undefined;
    phaseSwitchPresent: boolean;
  }> {
    try {
      // Insertion, replay readback and effective-history observation share one
      // D1 transaction. A concurrent write cannot change the returned flag.
      const [inserted, selected, switches] = await db.batch([
        db
          .insert(nutrition_targets)
          .values({
            ...input,
            rate_pct_bw_week: scaledInteger(input.rate_pct_bw_week, 4, 2),
            clipped: Number(input.clipped),
            clipped_reasons: JSON.stringify(input.clipped_reasons),
          })
          .onConflictDoNothing({ target: nutrition_targets.request_id })
          .returning({ id: nutrition_targets.id }),
        db
          .select(projection)
          .from(nutrition_targets)
          .where(eq(nutrition_targets.request_id, input.request_id)),
        db
          .select({ id: nutrition_goal_switches.id })
          .from(nutrition_goal_switches)
          .innerJoin(
            nutrition_targets,
            eq(nutrition_goal_switches.id, sql`-${nutrition_targets.id}`)
          )
          .where(eq(nutrition_targets.request_id, input.request_id)),
      ]);
      return {
        created: inserted.length > 0,
        target: selected[0] ? decodeTarget(selected[0]) : undefined,
        phaseSwitchPresent: switches.length > 0,
      };
    } catch (error) {
      throw classifyDatabaseFailure(error);
    }
  }

  return {
    list,
    active,
    findRequest,
    save,
    expenditure: expenditureRepository(db),
  };
}

export type TargetsRepository = ReturnType<typeof targetsRepository>;
