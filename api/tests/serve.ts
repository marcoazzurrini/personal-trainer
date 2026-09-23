// Test-only entrypoint. Production bundles api/worker.ts, never this module.
import worker from "../worker.ts";
import type { Bindings, Invocation } from "../environment.ts";

type TestBindings = Bindings & { TEST_SECRET: string; TEST_RUN: string };
export default {
  async fetch(
    req: Request,
    env: TestBindings,
    ctx: Invocation,
  ): Promise<Response> {
    if (new URL(req.url).pathname === "/api/__test_identity") {
      if (req.headers.get("authorization") !== `Bearer ${env.TEST_SECRET}`) {
        return Response.json({ error: "Test capability required." }, {
          status: 403,
        });
      }
      const result = await env.DB.prepare("SELECT run FROM __test_identity")
        .all<{ run: string }>();
      return Response.json({
        kind: "personal-trainer-worker-d1-v1",
        run: result.results[0]?.run,
      });
    }
    return worker.fetch(req, env, ctx);
  },
};
