// Type definitions for the Supabase Edge Runtime (Deno.serve, env, etc.)
import "@supabase/functions-js/edge-runtime.d.ts";
import { Hono } from "@hono/hono";
import { sql } from "./db.ts";
import { errorResponse } from "./lib/errors.ts";
import { blocks } from "./routes/blocks.ts";
import { bodyfat } from "./routes/bodyfat.ts";
import { bodyweight } from "./routes/bodyweight.ts";
import { docs } from "./routes/docs.ts";
import { docsProposals } from "./routes/docs_proposals.ts";
import { exercises, muscles } from "./routes/exercises.ts";
import { foods } from "./routes/foods.ts";
import { days, intake } from "./routes/intake.ts";
import { logPage } from "./routes/logpage.ts";
import { meals } from "./routes/meals.ts";
import { mesocycles } from "./routes/mesocycles.ts";
import { nutritionEvents } from "./routes/nutrition_events.ts";
import { nutritionState } from "./routes/nutrition_state.ts";
import { nutritionTargets } from "./routes/nutrition_targets.ts";
import { nutritionWeekly } from "./routes/nutrition_weekly.ts";
import { sessions } from "./routes/sessions.ts";
import { sets } from "./routes/sets.ts";
import { trainingState } from "./routes/training_state.ts";
import { userContext } from "./routes/user_context.ts";
import { weekSchedule } from "./routes/week_schedule.ts";
import { weeklyExerciseSets, weeklyVolume } from "./routes/volume.ts";

const app = new Hono().basePath("/api");

// Registered before the token middleware on purpose: /health is public so the
// uptime monitor can ping it without credentials. The select is the point —
// database activity is what keeps the free project from being paused.
app.get("/health", async (c) => {
  await sql`select 1`;
  return c.json({ status: "ok" });
});

// The log page namespace is tokenless like /health: the unguessable
// public_id is its auth, and the coach token never reaches a browser.
app.route("/s", logPage);

// One static bearer token on every coach-API endpoint.
app.use(async (c, next) => {
  const expected = Deno.env.get("API_TOKEN");
  if (!expected) {
    return c.json({ error: "API_TOKEN is not configured on the server." }, 500);
  }
  if (c.req.header("authorization") !== `Bearer ${expected}`) {
    return c.json({
      error:
        "Missing or wrong bearer token. Send an Authorization: Bearer <token> header.",
    }, 401);
  }
  await next();
});

app.route("/exercises", exercises);
app.route("/muscles", muscles);
app.route("/user-context", userContext);
app.route("/bodyweight", bodyweight);
app.route("/bodyfat", bodyfat);
app.route("/blocks", blocks);
app.route("/mesocycles", mesocycles);
app.route("/sessions", sessions);
app.route("/sets", sets);
app.route("/training-state", trainingState);
app.route("/week-schedule", weekSchedule);
app.route("/weekly-volume", weeklyVolume);
app.route("/weekly-exercise-sets", weeklyExerciseSets);
app.route("/foods", foods);
app.route("/meals", meals);
app.route("/intake", intake);
app.route("/days", days);
app.route("/nutrition-state", nutritionState);
app.route("/nutrition-targets", nutritionTargets);
app.route("/nutrition-events", nutritionEvents);
app.route("/nutrition/weekly", nutritionWeekly);
app.route("/docs", docs);
app.route("/docs-proposals", docsProposals);

app.notFound((c) =>
  c.json({ error: `No route for ${c.req.method} ${c.req.path}.` }, 404)
);

app.onError((err, c) => errorResponse(err, c));

Deno.serve(app.fetch);
