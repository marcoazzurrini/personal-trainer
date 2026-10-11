// The progress card's data, selected from two API reads. Selection only: every
// number is the API's own, and a read that failed is reported, never filled in.
import * as v from "valibot";

import type { ApiReply } from "./api-call.ts";

export const CARD_DAYS = 60;

const TrainingState = v.object({
  mesocycles: v.array(
    v.object({
      name: v.string(),
      track: v.string(),
      week: v.nullable(v.number()),
      planned_weeks: v.number(),
      this_week: v.object({
        sessions_done: v.number(),
        sessions_per_week: v.number(),
      }),
    })
  ),
});

const Bodyweight = v.object({
  bodyweight: v.array(
    v.object({
      id: v.number(),
      value_kg: v.number(),
      measured_at: v.string(),
      source: v.string(),
    })
  ),
  trend: v.array(
    v.object({
      day: v.string(),
      weight_kg: v.number(),
      interpolated: v.boolean(),
      trend_kg: v.number(),
    })
  ),
});

type Weight = v.InferOutput<typeof Bodyweight>;

// oxlint-disable-next-line typescript/consistent-type-definitions -- Tool output must be assignable to Flue's JSON value type, and an interface is not.
export type ProgressCard = {
  blocks: {
    name: string;
    track: string;
    week: number | null;
    planned_weeks: number;
    sessions_done: number;
    sessions_per_week: number;
  }[];
  bodyweight: Weight | null;
  unavailable: string[];
};

function read<T extends v.GenericSchema>(
  schema: T,
  reply: ApiReply
): v.InferOutput<T> | null {
  if (reply.status !== 200) {
    return null;
  }
  const parsed = v.safeParse(schema, reply.body);
  return parsed.success ? parsed.output : null;
}

// The window ends at the latest recorded day, not today, so an old record
// still shows; the card states its dates.
function recent({ bodyweight, trend }: Weight): Weight {
  const last = [
    ...trend.map((row) => row.day),
    ...bodyweight.map((row) => row.measured_at.slice(0, 10)),
  ]
    .toSorted()
    .at(-1);
  if (last === undefined) {
    return { bodyweight: [], trend: [] };
  }
  const cutoff = new Date(Date.parse(last) - (CARD_DAYS - 1) * 86_400_000)
    .toISOString()
    .slice(0, 10);
  return {
    bodyweight: bodyweight.filter(
      (row) => row.measured_at.slice(0, 10) >= cutoff
    ),
    trend: trend.filter((row) => row.day >= cutoff),
  };
}

export function progressCard(
  training: ApiReply,
  bodyweight: ApiReply
): ProgressCard {
  const state = read(TrainingState, training);
  const weight = read(Bodyweight, bodyweight);
  const unavailable: string[] = [];
  if (state === null) {
    unavailable.push(`training-state answered ${training.status}`);
  }
  if (weight === null) {
    unavailable.push(`bodyweight answered ${bodyweight.status}`);
  }
  return {
    blocks: (state?.mesocycles ?? []).map((plan) => ({
      name: plan.name,
      track: plan.track,
      week: plan.week,
      planned_weeks: plan.planned_weeks,
      sessions_done: plan.this_week.sessions_done,
      sessions_per_week: plan.this_week.sessions_per_week,
    })),
    bodyweight: weight === null ? null : recent(weight),
    unavailable,
  };
}
