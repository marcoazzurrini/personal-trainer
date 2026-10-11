import { z } from "@hono/zod-openapi";

// Validate only the harness envelope. Operation arguments deliberately bypass
// API schemas so persistence tests can exercise invalid and conflicting writes.
export const operationInput = z.object({
  store: z.string().optional(),
  method: z.string(),
  args: z.array(z.unknown()).default([]),
  now: z.string().optional(),
  beforeWrite: z
    .object({
      sql: z.string(),
      values: z.array(z.union([z.string(), z.number(), z.null()])).optional(),
      repeat: z.boolean().optional(),
    })
    .optional(),
  failReadback: z.boolean().optional(),
  maxQueries: z.number().optional(),
});

export const summaryInput = z.object({
  method: z.enum(["nutritionState", "finishedWeeks"]),
  now: z.string(),
  weeks: z.number().optional(),
  nextNow: z.string().optional(),
});
