import type { D1Database } from "@cloudflare/workers-types";
import { z } from "@hono/zod-openapi";

import type { Bindings, Invocation } from "../environment.ts";
// Test-only entrypoint. Production bundles api/worker.ts, never this module.
import worker from "../worker.ts";

type TestBindings = Omit<Bindings, "DB"> & {
  DB: D1Database;
  TEST_SECRET: string;
  TEST_RUN: string;
};
const statementRequest = z.object({
  run: z.string(),
  sql: z.string(),
  params: z.array(z.union([z.string(), z.number(), z.null()])),
  method: z.enum(["raw", "run", "first"]),
  columnNames: z.boolean().optional(),
  column: z.string().optional(),
});
export default {
  async fetch(
    req: Request,
    env: TestBindings,
    ctx: Invocation
  ): Promise<Response> {
    const path = new URL(req.url).pathname;
    if (path === "/api/__test_identity" || path === "/api/__test_d1") {
      if (req.headers.get("authorization") !== `Bearer ${env.TEST_SECRET}`) {
        return Response.json(
          { error: "Test capability required." },
          {
            status: 403,
          }
        );
      }
      const result = await env.DB.prepare(
        "SELECT run FROM __test_identity"
      ).all<{ run: string }>();
      const run = result.results[0]?.run;
      if (path === "/api/__test_identity") {
        return Response.json({ kind: "personal-trainer-worker-d1-v1", run });
      }
      if (req.method !== "POST") {
        return Response.json(
          { error: "Unknown test operation." },
          { status: 404 }
        );
      }
      try {
        const text = await req.text();
        if (new TextEncoder().encode(text).byteLength > 4 * 1024 * 1024) {
          throw new Error("Fixture exceeds management body limit.");
        }
        const input = statementRequest.parse(JSON.parse(text));
        if (input.run !== env.TEST_RUN || input.run !== run) {
          return Response.json(
            { error: "Test identity mismatch." },
            { status: 403 }
          );
        }
        const statement = env.DB.prepare(input.sql).bind(...input.params);
        if (input.method === "raw") {
          return Response.json(
            input.columnNames
              ? await statement.raw({ columnNames: true })
              : await statement.raw()
          );
        }
        if (input.method === "first") {
          return Response.json(
            input.column === undefined
              ? await statement.first()
              : await statement.first(input.column)
          );
        }
        return Response.json(await statement.run());
      } catch (error) {
        return Response.json(
          {
            error:
              error instanceof Error
                ? error.message
                : "Invalid test operation.",
          },
          { status: 400 }
        );
      }
    }
    return worker.fetch(req, env, ctx);
  },
};
