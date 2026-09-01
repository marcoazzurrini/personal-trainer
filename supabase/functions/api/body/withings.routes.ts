import { Hono } from "@hono/hono";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { ApiError } from "../http/errors.ts";
import { catchUp, configuredUserId, syncNotifiedWindow } from "./withings.ts";
import { WithingsError } from "./withings_client.ts";
import { query } from "../http/schema.ts";

// The routes Withings itself calls. Mounted ahead of the bearer-token
// middleware, because Withings has no way to send our token and a notification
// that 401s is a notification that vanishes without a trace.
//
// What stands in for authentication: nothing in the request body is believed.
// The payload carries no weight value, and the handler reads it only as a hint
// about which window to ask Withings about. A forged notification can make the
// server ask a question it already knows the answer to, and nothing else.
export const withingsWebhook = new Hono();

// Registered with Withings as the OAuth redirect URL and therefore required to
// exist, but vestigial: the authorization happened once, by hand, and the
// refresh token that came out of it is seeded directly. There is no
// authorization flow in this codebase and there does not need to be one.
withingsWebhook.get("/callback", (c) => c.json({ status: "ok" }));

// Withings probes the callback URL when a subscription is created, and a probe
// that fails takes the subscribe call down with it.
withingsWebhook.on(["GET", "HEAD"], "/notify", (c) => c.json({ status: "ok" }));

// appli 1 is weight. Nothing else is subscribed, but a notification for
// something else is still answered 200 and dropped: Withings retries what it
// reads as a failure, and eventually unsubscribes a callback that keeps
// failing, so 4xx-ing a notification we are choosing to ignore would put the
// whole integration at risk to no purpose.
const APPLI_WEIGHT = "1";

withingsWebhook.post("/notify", async (c) => {
  const form = new URLSearchParams(await c.req.text());
  const appli = form.get("appli");
  const userid = form.get("userid");
  const startdate = Number(form.get("startdate"));
  const enddate = Number(form.get("enddate"));

  if (appli !== APPLI_WEIGHT) {
    console.log(`withings: ignoring notification for appli ${appli}`);
    return c.json({ status: "ok" });
  }

  // Checked against the seeded row rather than an env var, so there is one
  // answer to "whose scale is this" and it sits beside the credentials used to
  // read it.
  const expected = await configuredUserId();
  if (expected === null) {
    console.error("withings: notification arrived but withings_auth is empty");
    return c.json({ status: "ok" });
  }
  if (userid !== expected) {
    console.log(`withings: ignoring notification for user ${userid}`);
    return c.json({ status: "ok" });
  }

  // The work happens before the response. It is two HTTP calls and an insert,
  // and there is no reliable way to finish work after responding on Deno
  // Deploy — a promise left running when the response is sent may simply not
  // be there when the isolate is torn down.
  try {
    const summary = Number.isFinite(startdate) && Number.isFinite(enddate)
      ? await syncNotifiedWindow(startdate, enddate)
      : await catchUp();
    console.log(`withings: ${JSON.stringify(summary)}`);
  } catch (err) {
    // Answer 200 regardless. A retry from Withings would help, but a callback
    // that returns errors is a callback Withings eventually unsubscribes, and
    // losing the subscription costs more than losing one notification — the
    // catch-up pass exists to collect exactly what is lost here.
    console.error(
      `withings: notification for ${startdate}–${enddate} failed — ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  return c.json({ status: "ok" });
});

// Mounted on the same /withings prefix but *after* the bearer middleware, so
// this one is behind the token like every other endpoint. The split is the
// point: only the two routes Withings calls are exposed, and the trigger that
// can be aimed at Withings on demand is not.
export const withingsAdmin = new OpenAPIHono();

// Runs the catch-up now, ignoring the throttle: what to reach for when a
// notification is suspected lost.
//
// ?since=<epoch seconds> overrides the watermark, and ?since=0 re-imports the
// whole history. That exists because the watermark makes the ordinary catch-up
// unable to repair the past: it asks for what changed since it last looked, so
// a row deleted from this database — by hand, or by a restore from an older
// backup — is not something Withings considers changed and is not something the
// catch-up will bring back. Re-importing everything is free, because every write
// is deduped on its instant.
//
// A query parameter rather than a body: this is the endpoint reached for in a
// terminal at an awkward moment, and `curl -X POST` with no body should work.
withingsAdmin.openapi(
  createRoute({
    method: "post",
    path: "/sync",
    tags: ["Tracking"],
    summary: "Run the Withings catch-up now",
    description:
      "Ignores the throttle. Takes no body — `curl -X POST` with nothing in it is the point, because this is the endpoint reached for in a terminal at an awkward moment.",
    request: {
      query: query({
        since: z.string().optional().meta({
          description:
            "Epoch seconds, overriding the watermark. 0 re-imports the whole history, which is free because every write is deduped on its instant.",
        }),
      }),
    },
    responses: {
      200: {
        description: "What the catch-up found and wrote.",
        content: {
          "application/json": {
            schema: z.object({
              withings: z.object({
                range: z.string().meta({
                  description: "The window asked for, as it was logged.",
                }),
                fetched: z.int().meta({
                  description: "Measure groups Withings returned.",
                }),
                written: z.int(),
                duplicate: z.int().meta({
                  description:
                    "Already present and identical — a redelivery, which is free.",
                }),
                ignored: z.int().meta({
                  description:
                    "Not a weight measurement: an objective, or a group without one.",
                }),
                refused: z.int().meta({
                  description:
                    "Rejected by the bodyweight guards. Never fatal.",
                }),
              }),
            }),
          },
        },
      },
      422: { description: "since was not a whole number of seconds." },
      502: { description: "Withings could not be reached, or refused." },
    },
  }),
  async (c) => {
    const raw = c.req.valid("query").since;
    let since: number | undefined;
    if (raw !== undefined) {
      since = Number(raw);
      if (!Number.isInteger(since) || since < 0) {
        throw new ApiError(
          422,
          `"since" must be a whole number of seconds since the epoch, or 0 to re-import everything. Got "${raw}".`,
        );
      }
    }
    try {
      return c.json({ withings: await catchUp(since) });
    } catch (err) {
      if (err instanceof WithingsError) throw new ApiError(502, err.message);
      throw err;
    }
  },
);
