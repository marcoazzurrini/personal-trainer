import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { trainingState as readState } from "./state.ts";
import { Entry as ContextEntry } from "./user_context.routes.ts";
import { clock, query } from "../shared/schema.ts";

// The declaration only; state.ts holds what it answers with.

export const trainingState = new OpenAPIHono();

const WeekSchedule = z.object({
  week_start: z.string(),
  schedule: z.string(),
  written_at: z.string(),
});

const PlanExercise = z.object({
  exercise: z.string(),
  measure: z.string(),
  role: z.string(),
  priority: z.int(),
  notes: z.string().nullable(),
  // Not nullable here, unlike in the weekly-volume read: this dose comes
  // straight off the plan, where both columns are required. There it is a
  // left join against the dose history, which an exercise revised out of the
  // plan can legitimately miss.
  dose: z.number(),
  dose_unit: z.string(),
  sets_done: z.int(),
  distance_m: z.number().nullable(),
  duration_s: z.number().nullable(),
  // How long since this lift was last performed — a fact about the lift and
  // the body, not about which plan asked for it, so it is not scoped to one.
  days_since_trained: z.int().nullable(),
  // In the dose's own unit, so adherence is a subtraction rather than a
  // conversion the caller has to get right.
  delivered_this_week: z.number(),
});

const RecentWeek = z.object({
  week: z.int(),
  working_sets_done: z.int(),
  sessions_done: z.int(),
});

const RecentDecision = z.object({
  id: z.int(),
  made_at: z.string(),
  what_changed: z.string(),
  why: z.string(),
});

const ActiveMesocycle = z.object({
  id: z.int(),
  name: z.string(),
  track: z.string(),
  // The plan's judgment, in prose. Never arithmetic.
  intent: z.string(),
  // Null before the plan's first Monday.
  week: z.int().nullable(),
  planned_weeks: z.int(),
  started_on: z.string(),
  // Where the method for this track is written, or null with a note saying
  // the plan is coached from general knowledge — stated by the API rather
  // than left for the coach to discover.
  method_doc: z.string().nullable(),
  method_note: z.string().nullable(),
  exercises: z.array(PlanExercise),
  this_week: z.object({
    sessions_done: z.int(),
    sessions_per_week: z.int(),
  }),
  recent_weeks: z.array(RecentWeek),
  recent_decisions: z.array(RecentDecision),
});

const SessionExercise = z.object({
  exercise: z.string(),
  mesocycle_id: z.int().nullable(),
  working_sets: z.int(),
  top_weight_kg: z.number().nullable(),
  top_reps: z.int().nullable(),
  top_distance_m: z.number().nullable(),
  top_duration_s: z.number().nullable(),
  top_effort: z.string().nullable(),
});

const RecentSession = z.object({
  id: z.int(),
  date: z.string(),
  rationale: z.string().nullable(),
  notes: z.string().nullable(),
  overall_feel: z.string().nullable(),
  exercises: z.array(SessionExercise),
});

// Two shapes in one schema. With no active mesocycle the answer is a `note`
// routing to onboarding or to programming, and `recent_sessions` is not
// fetched at all — there is nothing to read them against yet.
const TrainingState = z.object({
  now: clock(),
  week_schedule: WeekSchedule.nullable(),
  mesocycles: z.array(ActiveMesocycle),
  note: z.string().optional(),
  recent_sessions: z.array(RecentSession).optional(),
  user_context: z.array(ContextEntry),
});

trainingState.openapi(
  createRoute({
    method: "get",
    path: "/",
    tags: ["Training"],
    summary: "Everything true about the training, as of now",
    description:
      "The read that opens a training conversation. Plans are plural — hypertrophy and speed run side by side, each with its own week number, its own dose and its own method document. What they share is the week: one schedule, one list of recent sessions, one person. With no active plan the answer carries a `note` routing to onboarding or programming instead.",
    request: { query: query({}) },
    responses: {
      200: {
        description: "The complete current training picture.",
        content: { "application/json": { schema: TrainingState } },
      },
    },
  }),
  async (c) => c.json(await readState()),
);
