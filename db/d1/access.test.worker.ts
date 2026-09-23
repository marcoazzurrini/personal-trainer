// Local-only harness. Every key, token and database is synthetic.
import { Hono } from "@hono/hono";
import { tokenStore } from "../../api/access/tokens.ts";
import {
  createMcpRoutes,
  type McpConfig,
} from "../../api/access/mcp.routes.ts";
import {
  createWebAuthorizer,
  type WebAuthConfig,
} from "../../api/access/web.ts";
import { timingSafeEqual } from "../../api/access/jwt.ts";
import { ApiError } from "../../api/shared/errors.ts";
import type { Database } from "../../api/shared/d1.ts";

export default {
  async fetch(
    request: Request,
    env: { DB: Database; MCP: McpConfig; WEB: WebAuthConfig },
  ) {
    const app = new Hono();
    app.onError((error, c) =>
      c.json(
        { error: error.message },
        error instanceof ApiError ? error.status : 500,
      )
    );
    const store = tokenStore(
      env.DB,
      () => new Date(request.headers.get("x-clock") ?? "2026-08-30T12:00:00Z"),
    );
    app.route("/api/mcp", createMcpRoutes(env.MCP, store));
    app.post("/tokens/:method", async (c) => {
      const { value } = await c.req.json();
      return c.json(
        c.req.param("method") === "mint"
          ? await store.issueToken(value)
          : await store.verifyToken(value),
      );
    });
    app.post("/compare", async (c) => {
      const { left, right } = await c.req.json();
      return c.json(await timingSafeEqual(left, right));
    });
    app.all("/api/*", async (c) => {
      await createWebAuthorizer(env.WEB)(
        c.req.header("authorization")?.slice(7) ?? "",
        c.req.method,
        c.req.path,
      );
      return c.json({ ok: true });
    });
    return await app.fetch(request);
  },
};
