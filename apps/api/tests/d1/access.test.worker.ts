// Local-only harness. Every key, token and database is synthetic.
import type { D1Database } from "@cloudflare/workers-types";
import { createClient } from "@trainer/db/client.ts";
import { accessRepository } from "@trainer/db/repositories/access.ts";
import { Config } from "effect";
import { Hono } from "hono";
import type { ErrorHandler } from "hono";

import { timingSafeEqual } from "../../src/access/jwt.ts";
import { createMcpRoutes } from "../../src/access/mcp.routes.ts";
import type { McpConfig } from "../../src/access/mcp.routes.ts";
import { tokenStore } from "../../src/access/tokens.ts";
import { createWebAuthorizer } from "../../src/access/web.ts";
import type { WebAuthConfig } from "../../src/access/web.ts";
import type { Invocation } from "../../src/environment.ts";
import { isRefusal } from "../../src/shared/refusals.ts";
import { invocationContext, run } from "../../src/shared/runtime.ts";
import type { AppEnv } from "../../src/shared/services.ts";
import { fixedClock } from "../../src/shared/values.ts";

const handleError: ErrorHandler<AppEnv> = (error, c) =>
  c.json({ error: error.message }, isRefusal(error) ? error.status : 500);

export default {
  async fetch(
    request: Request,
    env: { DB: D1Database; MCP: McpConfig; WEB: WebAuthConfig },
    ctx: Invocation
  ) {
    // Every route runs its Effects in this request's context, on the wall
    // clock the test names.
    const context = invocationContext({
      env: { DB: env.DB },
      invocation: ctx,
      diagnostic: { id: crypto.randomUUID(), route: "test" },
      clock: fixedClock(
        request.headers.get("x-clock") ?? "2026-08-30T12:00:00Z"
      ),
    });
    const app = new Hono<AppEnv>();
    app.onError(handleError);
    app.use((c, next) => {
      c.set("context", context);
      return next();
    });
    const store = tokenStore(accessRepository(createClient(env.DB)));
    app.route("/api/mcp", createMcpRoutes(Config.succeed(env.MCP), store));
    app.post("/tokens/:method", async (c) => {
      const { value } = await c.req.json();
      return c.json(
        c.req.param("method") === "mint"
          ? await run(context, store.issueToken(value))
          : await run(context, store.verifyToken(value))
      );
    });
    app.post("/compare", async (c) => {
      const { left, right } = await c.req.json();
      return c.json(await timingSafeEqual(left, right));
    });
    app.all("/api/*", async (c) => {
      await run(
        context,
        createWebAuthorizer(env.WEB)(
          c.req.header("authorization")?.slice(7) ?? "",
          c.req.method,
          c.req.path
        )
      );
      return c.json({ ok: true });
    });
    return await app.fetch(request);
  },
};
