import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { Effect } from "effect";
import { Hono } from "hono";

import { Invalid, Upstream } from "../shared/refusals.ts";
import { background } from "../shared/runtime.ts";
import { query } from "../shared/schema.ts";
import { run } from "../shared/services.ts";
import type { AppEnv } from "../shared/services.ts";
import type { WithingsStore } from "./withings.ts";

// The routes Withings itself calls. Mounted ahead of the bearer-token
// middleware, because Withings has no way to send our token and a notification
// that 401s is a notification that vanishes without a trace.
//
// What stands in for authentication: nothing in the request body is believed.
// The payload carries no weight value, and the handler reads it only as a hint
// about which window to ask Withings about. A forged notification can make the
// server ask a question it already knows the answer to, and nothing else.
export type WithingsRouteDeps = Pick<
  WithingsStore,
  "catchUp" | "configuredUserId" | "syncNotifiedWindow"
>;

/** Mount webhook before authentication, admin after it. Background work belongs to the request's invocation. */
export function createWithingsRoutes(deps: WithingsRouteDeps) {
  const { catchUp, configuredUserId, syncNotifiedWindow } = deps;
  const withingsWebhook = new Hono<AppEnv>();

  // Registered with Withings as the OAuth redirect URL and therefore required to
  // exist, but vestigial: the authorization happened once, by hand, and the
  // refresh token that came out of it is seeded directly. There is no
  // authorization flow in this codebase and there does not need to be one.
  withingsWebhook.get("/callback", (c) => c.json({ status: "ok" }));

  // Withings probes the callback URL when a subscription is created, and a probe
  // that fails takes the subscribe call down with it.
  withingsWebhook.on(["GET", "HEAD"], "/notify", (c) =>
    c.json({ status: "ok" })
  );

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
    const start = form.get("startdate");
    const end = form.get("enddate");
    const startdate = start?.trim() ? Number(start) : Number.NaN;
    const enddate = end?.trim() ? Number(end) : Number.NaN;

    await run(
      c,
      Effect.gen(function* () {
        if (appli !== APPLI_WEIGHT) {
          yield* Effect.logInfo(
            "withings: ignoring notification for another measurement type"
          );
          return;
        }

        // Checked against the seeded row rather than an env var, so there is
        // one answer to "whose scale is this" and it sits beside the
        // credentials used to read it.
        const expected = yield* configuredUserId();
        if (expected === null) {
          yield* Effect.logError(
            "withings: notification arrived but withings_auth is empty"
          );
          return;
        }
        if (userid !== expected) {
          yield* Effect.logInfo(
            "withings: ignoring notification for another account"
          );
          return;
        }

        // The request's execution context owns the provider work after the
        // 200. No isolate-global promise or shutdown/drain protocol survives
        // in Workers.
        yield* background(
          (Number.isSafeInteger(startdate) &&
          startdate >= 0 &&
          Number.isSafeInteger(enddate) &&
          enddate >= startdate
            ? syncNotifiedWindow(startdate, enddate, expected)
            : catchUp(undefined, expected)
          ).pipe(
            Effect.flatMap((summary) =>
              Effect.logInfo(
                `withings: notification fetched ${summary.fetched}, written ${summary.written}, refused ${summary.refused}`
              )
            ),
            // Answer 200 regardless. A retry from Withings would help, but a
            // callback that returns errors is a callback Withings eventually
            // unsubscribes, and losing the subscription costs more than losing
            // one notification — the catch-up pass exists to collect exactly
            // what is lost here.
            Effect.catchCause(() =>
              Effect.logError(
                "withings: notification sync failed; provider/error details withheld"
              )
            )
          )
        );
      })
    );
    return c.json({ status: "ok" });
  });

  // Mounted on the same /withings prefix but *after* the bearer middleware, so
  // this one is behind the token like every other endpoint. The split is the
  // point: only the two routes Withings calls are exposed, and the trigger that
  // can be aimed at Withings on demand is not.
  const withingsAdmin = new OpenAPIHono<AppEnv>();

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
      const summary = await run(
        c,
        Effect.gen(function* () {
          let since: number | undefined;
          if (raw !== undefined) {
            since = Number(raw);
            if (
              !raw.trim() ||
              !Number.isSafeInteger(since) ||
              since < 0 ||
              !Number.isFinite(new Date(since * 1000).getTime())
            ) {
              return yield* new Invalid({
                message: `"since" must be a whole number of seconds since the epoch, or 0 to re-import everything. Got "${raw}".`,
              });
            }
          }
          return yield* catchUp(since).pipe(
            Effect.catchTag("WithingsError", (error) =>
              Effect.fail(new Upstream({ message: error.message }))
            )
          );
        })
      );
      return c.json({ withings: summary });
    }
  );
  return { withingsWebhook, withingsAdmin };
}
