import type { D1Database } from "@cloudflare/workers-types";

import { bodyweightStore } from "../../api/body/bodyweight.ts";
import { createWithingsRoutes } from "../../api/body/withings.routes.ts";
import { withingsStore } from "../../api/body/withings.ts";
import { createClient } from "../client.ts";
import { bodyweightRepository } from "../repositories/bodyweight.ts";
import { withingsRepository } from "../repositories/withings.ts";
// Local-only harness. outboundService supplies all provider responses.
import { operationInput } from "./test-input.ts";

export default {
  async fetch(
    request: Request,
    env: { DB: D1Database },
    ctx: { waitUntil: (promise: Promise<unknown>) => void }
  ) {
    const client = createClient(env.DB);
    const clock = () =>
      new Date(request.headers.get("x-clock") ?? "2026-08-30T12:00:00Z");
    const store = withingsStore(
      withingsRepository(client),
      (accountId) =>
        bodyweightStore(bodyweightRepository(client, accountId), clock),
      {
        apiBase: "https://withings.invalid",
        clientId: "fake-client",
        clientSecret: "fake-secret",
      },
      clock
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
        // oxlint-disable-next-line anti-slop/no-reflect-apply -- Negative provider tests intentionally bypass route schemas while dispatching only own store methods.
        return Response.json(await Reflect.apply(operation, store, args));
      } catch (error) {
        return Response.json({ error: String(error) }, { status: 500 });
      }
    }
    if (new URL(request.url).pathname === "/schedule") {
      store.startCatchUp((promise) => ctx.waitUntil(promise));
      return Response.json({ scheduled: true });
    }
    const routes = createWithingsRoutes(store, (promise) =>
      ctx.waitUntil(promise)
    );
    const url = new URL(request.url);
    url.pathname = url.pathname.replace(/^\/api\/withings/u, "");
    const router =
      url.pathname === "/sync" ? routes.withingsAdmin : routes.withingsWebhook;
    return await router.fetch(new Request(url, request));
  },
};
