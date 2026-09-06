import { OpenAPIHono } from "@hono/zod-openapi";
import { sql } from "./db.ts";
import {
  ApiError,
  type Diagnostic,
  errorResponse,
  internalError,
  validationHook,
} from "./shared/errors.ts";
import { boundedBody } from "./shared/body.ts";
import {
  bodyfat,
  bodyweight,
  withingsAdmin,
  withingsWebhook,
} from "./body/index.ts";
import { startCatchUp, stopCatchUp } from "./body/withings.ts";
import { issues } from "./surfaces/index.ts";
import { verifyToken } from "./access/tokens.ts";
import { mcp } from "./access/index.ts";
import {
  days,
  foods,
  intake,
  meals,
  nutritionEvents,
  nutritionState,
  nutritionTargets,
  nutritionWeekly,
} from "./nutrition/index.ts";
import {
  blocks,
  exercises,
  mesocycles,
  muscles,
  sessions,
  sets,
  trainingState,
  userContext,
  weeklyExerciseSets,
  weeklyVolume,
  weekSchedule,
} from "./training/index.ts";

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
const app = new OpenAPIHono<{
  Bindings: { diagnostic: Diagnostic };
  Variables: { diagnostic: Diagnostic };
}>({
  defaultHook: validationHook,
}).basePath("/api");

app.use(async (c, next) => {
  const diagnostic = c.env.diagnostic;
  c.set("diagnostic", diagnostic);
  await next();
  // routePath is the registered template, never the caller's raw URL. An
  // unmatched request ends at middleware (*), not at a sensitive path value.
  const route = c.req.routePath;
  diagnostic.route = !route || route.endsWith("*") ? "unmatched" : route;
});

// Public readiness probe: check the database within one second, then trigger
// (but never await) the topic-owned, throttled Withings catch-up.
app.get("/health", async (c) => {
  const query = sql`select 1`.execute();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      query,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          query.cancel();
          reject(
            new ApiError(
              503,
              "Database readiness check timed out. Try the health read again later.",
            ),
          );
        }, 1000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
  startCatchUp();
  return c.json({ status: "ok" });
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
// in the coaching documents the plugin carries, which this does not replace
// and cannot express.
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
      "Marco's training and nutrition record. The coaching documents ship in the plugin's skill; this describes request and response shape only.",
  },
  security: [{ bearer: [] }],
  // Relative, so the page works against whichever origin served it — the
  // hosted API and the local one without a build step between them. Paths
  // carry the /api the router mounts on, so the server is the origin itself.
  servers: [{ url: "/" }],
});

// Scalar from a CDN script rather than its Hono middleware, which is npm-only
// and pulls a dependency chain this runtime resolves badly. The middleware
// only ever emitted this page anyway. Pin and SHA-384 cover the exact standalone
// bytes from the npm tarball, compared with jsDelivr; update both after review.
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
    <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference@1.67.0/dist/browser/standalone.js"
      integrity="sha384-6c7Vmx+i0yi8gBbltn0x1cavD+zsMGw2xmXXVyacPJLIGBxwaVimW5TW0WiW17Ir"
      crossorigin="anonymous"></script>
    <script>
      Scalar.createApiReference('#app', { url: 'openapi.json' })
    </script>
  </body>
</html>`));

// The connector: the one endpoint the plugin talks MCP to, whose one tool
// mints the coach's token. Above the middleware because it carries its own
// credential, the sign-in token, checked inside on every call; its discovery
// document is the one route that answers with none, so a client can learn
// where to sign in. The auth matrix names it beside the Withings webhook.
app.route("/mcp", mcp);

// Two ways in, for as long as the move from one to the other runs. The static
// bearer is the path being retired: one secret pasted into a generated skill
// file, two during a rotation (API_TOKEN and API_TOKEN_PREVIOUS), because
// conversations hold it for as long as they live. The minted token is the path replacing it:
// issued by the plugin's connector after a sign-in and checked against its
// hash in api_tokens (access/tokens.ts). Until the static branch goes, the
// coach keeps working on the old token while the new one is proven. A server
// with no API_TOKEN configured is no longer a misconfiguration, only a server
// that accepts minted tokens alone.
app.use(async (c, next) => {
  const refusal = {
    error:
      "Missing or wrong bearer token. Send an Authorization: Bearer <token> header.",
  };
  const sent = c.req.header("authorization") ?? "";
  const bearer = sent.startsWith("Bearer ") ? sent.slice("Bearer ".length) : "";
  if (bearer === "") return c.json(refusal, 401);
  const isStatic = [
    Deno.env.get("API_TOKEN"),
    Deno.env.get("API_TOKEN_PREVIOUS"),
  ].some((known) => known !== undefined && known !== "" && bearer === known);
  if (!isStatic && (await verifyToken(bearer)) === null) {
    return c.json(refusal, 401);
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
    const raw = await c.req.text();
    if (raw.trim() !== "") {
      let parsed: unknown;
      try {
        parsed = await c.req.json();
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
// router's mount prefix. A caller that read an /api-prefixed path somewhere and
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

// The test server uses this same handler, with a verified disposable database.
export async function handleRequest(req: Request): Promise<Response> {
  const started = performance.now();
  const diagnostic: Diagnostic = {
    id: crypto.randomUUID(),
    route: "unmatched",
  };
  const method =
    ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"].includes(
        req.method,
      )
      ? req.method
      : "OTHER";
  let response: Response;
  try {
    try {
      req = await boundedBody(req);
    } catch (err) {
      if (err instanceof ApiError) throw err;
      throw new ApiError(
        400,
        "Request body could not be read. Send a complete request body.",
      );
    }
    const url = new URL(req.url);
    const collapsed = url.pathname.replace(/^(\/api)+(?=\/|$)/, "/api");
    if (collapsed !== url.pathname) {
      url.pathname = collapsed;
      req = new Request(url, req);
    }
    response = await app.fetch(await normalized(req), { diagnostic });
  } catch (err) {
    response = Response.json({
      error: err instanceof ApiError
        ? err.message
        : internalError(diagnostic, method),
    }, { status: err instanceof ApiError ? err.status : 500 });
  }
  response.headers.set("X-Request-ID", diagnostic.id);
  console.log(JSON.stringify({
    diagnostic_id: diagnostic.id,
    method,
    route: diagnostic.route,
    status: response.status,
    duration_ms: Math.round(performance.now() - started),
    ...(diagnostic.error ? { error: diagnostic.error } : {}),
  }));
  return response;
}

// Shorter than Docker's default ten-second stop grace. A forced exit does not
// establish rollback; completed database statements and external writes persist.
export const SHUTDOWN_MS = 8_000;

export function startServer(
  options: Deno.ServeTcpOptions,
  handler: Deno.ServeHandler = handleRequest,
): Deno.HttpServer<Deno.NetAddr> {
  const server = Deno.serve(options, handler);
  let stopping = false;
  function shutdown() {
    if (stopping) return;
    stopping = true;
    console.log("shutdown: draining HTTP and tracked catch-up");
    const timer = setTimeout(() => {
      console.error(
        "shutdown: drain deadline exceeded; unfinished writes may have committed",
      );
      Deno.exit(1);
    }, SHUTDOWN_MS);
    void Promise.all([server.shutdown(), stopCatchUp()])
      .then(() => sql.end({ timeout: 1 }))
      .then(() => {
        clearTimeout(timer);
        Deno.removeSignalListener("SIGTERM", shutdown);
        Deno.removeSignalListener("SIGINT", shutdown);
        console.log("shutdown: drained; database pool closed");
      }).catch(() => {
        console.error(
          "shutdown: failed; error details withheld, write outcomes uncertain",
        );
        Deno.exit(1);
      });
  }
  Deno.addSignalListener("SIGTERM", shutdown);
  Deno.addSignalListener("SIGINT", shutdown);
  return server;
}

// The port is the container's business, not the app's.
if (import.meta.main) {
  try {
    startServer({
      port: Number(Deno.env.get("PORT") ?? 8000),
      hostname: "0.0.0.0",
    });
  } catch {
    console.error(
      "startup: HTTP server failed; configuration details withheld",
    );
    Deno.exit(1);
  }
}
