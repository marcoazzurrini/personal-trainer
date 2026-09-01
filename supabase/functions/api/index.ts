// Type definitions for the Supabase Edge Runtime (Deno.serve, env, etc.)
import "@supabase/functions-js/edge-runtime.d.ts";
import { OpenAPIHono } from "@hono/zod-openapi";
import { sql } from "./db.ts";
import { errorResponse, validationHook } from "./http/errors.ts";
import {
  bodyfat,
  bodyweight,
  withingsAdmin,
  withingsWebhook,
} from "./body/index.ts";
import { catchUpIfDue } from "./body/withings.ts";
import { days, foods, intake, meals } from "./nutrition/index.ts";
import { blocks } from "./routes/blocks.ts";
import { docs } from "./routes/docs.ts";
import { exercises, muscles } from "./routes/exercises.ts";
import { issues } from "./routes/issues.ts";
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

// OpenAPIHono rather than Hono: it is a Hono subclass, so every router
// mounted below stays an ordinary Hono router and keeps working untouched.
// What it adds is a second output from the same source — routes declared with
// app.openapi() validate against a schema *and* describe themselves, so the
// document at /openapi.json is generated from the code that runs rather than
// maintained beside it.
//
// defaultHook is the single place a schema refusal becomes the { "error": … }
// envelope. Passing it here rather than per route is what stops one endpoint
// from answering in a shape the others do not.
const app = new OpenAPIHono({ defaultHook: validationHook }).basePath("/api");

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

// Withings cannot send our bearer token, so its two routes are registered here,
// ahead of the middleware. They answer without calling next(), which is what
// keeps them public — the same mechanism /health relies on. Everything else
// under /withings is mounted below the middleware and stays behind the token.
app.route("/withings", withingsWebhook);

// The document, generated from the schemas the handlers actually validate
// against. Nothing here is hand-written, and nothing is committed: a route
// that changes shape changes this response in the same commit, which is the
// whole reason for preferring it to a second copy of the truth in Markdown.
//
// It describes shape only. Why a food's source may not be dressed up as a
// lookup, what an estimate obliges the coach to disclose — that judgment stays
// in docs/, which this does not replace and cannot express.
//
// Public, and deliberately so — the third exemption after /health and the
// webhook, and the only one that is a convenience rather than a necessity. A
// browser cannot put a bearer token on a page load, so a reference page behind
// the middleware is a reference page nobody opens. What leaks is the shape of
// the surface: endpoint names, field names, which of them are required.
// Nothing that was ever secret, no data, and no way in — every route it
// describes still answers 401 without the token, which is the property
// auth_matrix_test.ts holds down.
//
// The routes are registered above the middleware but the document is built
// per request, so it still describes every route mounted below.
// The bearer every route below the middleware requires. Declared so the
// reference page can offer a box to paste it into: a document that describes
// calls nobody can make from it is half a document.
app.openAPIRegistry.registerComponent("securitySchemes", "bearer", {
  type: "http",
  scheme: "bearer",
  description:
    "The coach token. Every path here except /health and this document itself refuses a request without it.",
});

app.doc("/openapi.json", {
  openapi: "3.0.0",
  info: {
    title: "Coach API",
    version: "1",
    description:
      "Marco's training and nutrition record. Prose documents live at GET /docs/index; this describes request and response shape only.",
  },
  security: [{ bearer: [] }],
  // Relative, so the page works against whichever origin served it — the
  // deployed function and the local stack without a build step between them.
  // Paths carry the /api the router mounts on, so the server stops short of it.
  servers: [{ url: "/functions/v1" }],
});

// Scalar from a CDN script rather than its Hono middleware, which is npm-only
// and pulls a dependency chain this runtime resolves badly. The middleware
// only ever emitted this page anyway.
app.get("/reference", (c) =>
  c.html(`<!doctype html>
<html>
  <head>
    <title>Coach API</title>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
  </head>
  <body>
    <div id="app"></div>
    <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
    <script>
      Scalar.createApiReference('#app', { url: 'openapi.json' })
    </script>
  </body>
</html>`));

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

// readJson used to guarantee two things that the schema validator does not:
// that a body is a JSON object at all, and that it is read whatever the
// Content-Type says. The validator skips silently when the header is not
// application/json — the request reaches the handler with every field
// undefined, which is the same silent-success failure assertKnownFields
// existed to prevent, arriving by a different door.
//
// So the guarantee is restored here, once, ahead of every schema. It sits
// below the token middleware on purpose: the health ping and the Withings
// webhook are registered above it and keep their own handling — the webhook
// in particular is form-encoded and must stay untouched.
//
// A body-less POST passes: /withings/sync is reached from a terminal with no
// body at all, and that is deliberate.
app.use(async (c, next) => {
  const method = c.req.method;
  if (method === "POST" || method === "PATCH" || method === "PUT") {
    const raw = await c.req.raw.clone().text();
    if (raw.trim() !== "") {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = undefined;
      }
      if (
        parsed === null || typeof parsed !== "object" || Array.isArray(parsed)
      ) {
        return c.json({
          error:
            "The request body must be a JSON object. Send Content-Type: application/json.",
        }, 422);
      }
    }
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
//
// The second forgiveness is the Content-Type header. c.req.json() read a body
// whatever the header claimed, and the schema validator does not: it skips on
// anything but application/json, handing the route a body it never checked.
// A caller that sent well-formed JSON and a careless header was answered for
// years and is answered still — the header is corrected rather than the call
// refused. A body that is not a JSON object is left exactly as it arrived,
// which is what keeps the form-encoded Withings webhook working.
const JSON_BODY_METHODS = new Set(["POST", "PATCH", "PUT"]);

async function normalized(req: Request): Promise<Request> {
  if (!JSON_BODY_METHODS.has(req.method)) return req;
  if (req.headers.get("content-type")?.includes("application/json")) return req;

  const raw = await req.clone().text();
  if (raw.trim() === "") return req;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return req;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return req;
  }

  const headers = new Headers(req.headers);
  headers.set("content-type", "application/json");
  return new Request(req.url, { method: req.method, headers, body: raw });
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const collapsed = url.pathname.replace(/^(\/api)+(?=\/|$)/, "/api");
  if (collapsed === url.pathname) return app.fetch(await normalized(req));
  url.pathname = collapsed;
  return app.fetch(await normalized(new Request(url, req)));
});
