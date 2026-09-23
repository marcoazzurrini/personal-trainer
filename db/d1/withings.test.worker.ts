// Local-only harness. outboundService supplies all provider responses.
import { withingsStore } from "../../api/body/withings.ts";
import { createWithingsRoutes } from "../../api/body/withings.routes.ts";
import type { Database } from "../../api/shared/d1.ts";

export default {
  async fetch(
    request: Request,
    env: { DB: Database },
    ctx: { waitUntil(promise: Promise<unknown>): void },
  ) {
    const store = withingsStore(
      env.DB,
      {
        apiBase: "https://withings.invalid",
        clientId: "fake-client",
        clientSecret: "fake-secret",
      },
      () => new Date(request.headers.get("x-clock") ?? "2026-08-30T12:00:00Z"),
    );
    if (new URL(request.url).pathname === "/store") {
      const { method, args = [] } = (await request.json()) as {
        method: string;
        args: unknown[];
      };
      try {
        const callable = store as unknown as Record<
          string,
          (...args: unknown[]) => unknown
        >;
        if (!Object.hasOwn(callable, method) || method === "startCatchUp") {
          return new Response("Unknown operation", { status: 400 });
        }
        return Response.json(await callable[method](...args));
      } catch (error) {
        return Response.json({ error: String(error) }, { status: 500 });
      }
    }
    if (new URL(request.url).pathname === "/schedule") {
      store.startCatchUp((promise) => ctx.waitUntil(promise));
      return Response.json({ scheduled: true });
    }
    const routes = createWithingsRoutes(
      store,
      (promise) => ctx.waitUntil(promise),
    );
    const url = new URL(request.url);
    url.pathname = url.pathname.replace(/^\/api\/withings/, "");
    const router = url.pathname === "/sync"
      ? routes.withingsAdmin
      : routes.withingsWebhook;
    return await router.fetch(new Request(url, request));
  },
};
