import { z } from "@hono/zod-openapi";
import { EFFORTS } from "./rules.ts";
import {
  oneOf,
  optionalInt,
  optionalNumber,
  optionalText,
  optionalTimestamp,
} from "../shared/schema.ts";

// Both correction surfaces accept the same fields and give the same refusal
// for targets. Keep request parsing here, separate from the pure merge rule.
const immutableTarget = () =>
  z.unknown().optional().meta({
    description:
      "Refused. Targets are the record of what was asked that day and never change after the session exists.",
  });

export function setCorrectionShape() {
  return {
    weight_kg: optionalNumber({ min: 0 }),
    reps: optionalInt({ min: 1 }),
    distance_m: optionalNumber({ min: 0 }),
    duration_s: optionalNumber({ min: 0 }),
    effort: oneOf(EFFORTS).nullish(),
    performed_at: optionalTimestamp(),
    notes: optionalText(),
    target_weight_kg: immutableTarget(),
    target_reps: immutableTarget(),
    target_distance_m: immutableTarget(),
    target_duration_s: immutableTarget(),
  };
}
