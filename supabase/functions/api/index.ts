// Type definitions for the Supabase Edge Runtime (Deno.serve, env, etc.)
import "@supabase/functions-js/edge-runtime.d.ts";
import { Hono } from "@hono/hono";
import { sql } from "./db.ts";
import { errorResponse } from "./lib/errors.ts";
import { blocks } from "./routes/blocks.ts";
import { bodyfat } from "./routes/bodyfat.ts";
import { bodyweight } from "./routes/bodyweight.ts";
import { docs } from "./routes/docs.ts";
import { exercises, muscles } from "./routes/exercises.ts";
import { foods } from "./routes/foods.ts";
import { days, intake } from "./routes/intake.ts";
import { issues } from "./routes/issues.ts";
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
import { withingsAdmin, withingsWebhook } from "./routes/withings.ts";
import { catchUpIfDue } from "./lib/withings_sync.ts";

const app = new Hono().basePath("/api");

// Registered before the token middleware on purpose: /health is public so the
// uptime monitor can ping it without credentials. The select is the point —
// database activity is what keeps the free project from being paused.
//
// It carries the Withings catch-up as well, because this ping is the only
// scheduled event in the system and a second scheduler would be one more thing
// to configure outside the repository and forget. catchUpIfDue throttles itself
// to one pass every few hours and cannot throw: an unreachable Withings must
// never make the monitor believe the project is down.
app.get("/health", async (c) => {
  await sql`select 1`;
  const withings = await catchUpIfDue();
  return c.json({ status: "ok", ...(withings ? { withings } : {}) });
});

// The log page namespace is tokenless like /health: the unguessable
// public_id is its auth (21 chars of CSPRNG over 62 symbols, ~125 bits), and
// the coach token never reaches a browser. Its writes carry no rate limit —
// the entropy is the defense; revisit only if a session URL ever leaks.
app.route("/s", logPage);

// Withings cannot send our bearer token, so its two routes are registered here,
// ahead of the middleware. They answer without calling next(), which is what
// keeps them public — the same mechanism /health relies on. Everything else
// under /withings is mounted below the middleware and stays behind the token.
app.route("/withings", withingsWebhook);

// One static bearer token on every coach-API endpoint — two during a
// rotation. API_TOKEN is current; API_TOKEN_PREVIOUS, when set, is the one
// being retired. The grace window exists because conversations hold the
// token in context for as long as they live: without it, turning the secret
// 401s every chat mid-sentence. The procedure lives in skill/generate-skill.sh
// next to the script that re-renders SKILL.md with the new value.
app.use(async (c, next) => {
  const expected = Deno.env.get("API_TOKEN");
  if (!expected) {
    return c.json({ error: "API_TOKEN is not configured on the server." }, 500);
  }
  const previous = Deno.env.get("API_TOKEN_PREVIOUS");
  const sent = c.req.header("authorization");
  const accepted = sent === `Bearer ${expected}` ||
    (previous !== undefined && previous !== "" &&
      sent === `Bearer ${previous}`);
  if (!accepted) {
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
app.route("/issues", issues);
// The manual sync trigger, on the same prefix as the webhook above but on this
// side of the middleware.
app.route("/withings", withingsAdmin);

app.notFound((c) => {
  // Backstop for the normalization below: unreachable while the wrapper runs,
  // but a route this function cannot serve must still explain itself if a
  // refactor ever drops the wrapper. Errors are prompts, including this one.
  const doubled = c.req.path.startsWith("/api/api/") ||
    c.req.path === "/api/api";
  const hint = doubled
    ? " The base URL already ends in /api — write paths without it, as the docs do."
    : "";
  return c.json(
    { error: `No route for ${c.req.method} ${c.req.path}.${hint}` },
    404,
  );
});

app.onError((err, c) => errorResponse(err, c));

// The docs write paths relative to BASE, which already ends in /api — the
// function's own name. A caller that read an /api-prefixed path somewhere and
// concatenated it onto BASE arrives at /api/api/…, which no route matches.
// That mistake is one string-concatenation away for every client, so it is
// forgiven here instead of 404ing: collapse any run of leading /api segments
// down to the one the router mounts on.
Deno.serve((req) => {
  const url = new URL(req.url);
  const collapsed = url.pathname.replace(/^(\/api)+(?=\/|$)/, "/api");
  if (collapsed === url.pathname) return app.fetch(req);
  url.pathname = collapsed;
  return app.fetch(new Request(url, req));
});
