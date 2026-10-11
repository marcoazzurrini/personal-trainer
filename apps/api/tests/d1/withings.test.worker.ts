import type { D1Database } from "@cloudflare/workers-types";
import { createClient } from "@trainer/db/client.ts";
import { bodyweightRepository } from "@trainer/db/repositories/bodyweight.ts";
import { withingsRepository } from "@trainer/db/repositories/withings.ts";
import { Hono } from "hono";

import { bodyweightStore } from "../../src/body/bodyweight.ts";
import { createWithingsRoutes } from "../../src/body/withings.routes.ts";
import { withingsStore } from "../../src/body/withings.ts";
import type { Invocation } from "../../src/environment.ts";
import { invocationContext, run } from "../../src/shared/runtime.ts";
import type { AppEnv } from "../../src/shared/services.ts";
import { fixedClock } from "../../src/shared/values.ts";
// Local-only harness. outboundService supplies all provider responses.
import { operationInput } from "./test-input.ts";

export default {
  async fetch(request: Request, env: { DB: D1Database }, ctx: Invocation) {
    const client = createClient(env.DB);
    // The provider settings reach the store as this invocation's bindings,
    // and its wall clock is the one the test names.
    const context = invocationContext({
      env: {
        DB: env.DB,
        WITHINGS_API_BASE: "https://withings.invalid",
        WITHINGS_CLIENT_ID: "fake-client",
        WITHINGS_CLIENT_SECRET: "fake-secret",
      },
      invocation: ctx,
      diagnostic: { id: crypto.randomUUID(), route: "test" },
      clock: fixedClock(
        request.headers.get("x-clock") ?? "2026-08-30T12:00:00Z"
      ),
    });
    const store = withingsStore(withingsRepository(client), (accountId) =>
      bodyweightStore(bodyweightRepository(client, accountId))
    );
    if (new URL(request.url).pathname === "/store") {
      const { method, args } = operationInput.parse(await request.json());
      try {
        const operation = Object.entries(store).find(
          ([name]) => name === method
        )?.[1];
        if (!operation || method === "startCatchUp") {
          return new Response("Unknown operation", { status: 400 });
        }
        return Response.json(
          // oxlint-disable-next-line anti-slop/no-reflect-apply -- Negative provider tests intentionally bypass route schemas while dispatching only own store methods.
          await run(context, Reflect.apply(operation, store, args))
        );
      } catch (error) {
        return Response.json({ error: String(error) }, { status: 500 });
      }
    }
    if (new URL(request.url).pathname === "/schedule") {
      await run(context, store.startCatchUp());
      return Response.json({ scheduled: true });
    }
    const routes = createWithingsRoutes(store);
    const url = new URL(request.url);
    url.pathname = url.pathname.replace(/^\/api\/withings/u, "");
    const router =
      url.pathname === "/sync" ? routes.withingsAdmin : routes.withingsWebhook;
    // What index.ts gives every request before the routes see it.
    const app = new Hono<AppEnv>();
    app.use((c, next) => {
      c.set("context", context);
      return next();
    });
    app.route("/", router);
    return await app.fetch(new Request(url, request));
  },
};
