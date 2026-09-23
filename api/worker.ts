import { handleRequest } from "./index.ts";
import { withingsStore } from "./body/withings.ts";
import type { Bindings, Invocation } from "./environment.ts";

export default {
  fetch(request: Request, env: Bindings, ctx: Invocation): Promise<Response> {
    return handleRequest(request, env, ctx);
  },

  scheduled(
    _event: { scheduledTime: number; cron: string },
    env: Bindings,
    ctx: Invocation,
  ): void {
    const withings = withingsStore(env.DB, {
      clientId: env.WITHINGS_CLIENT_ID,
      clientSecret: env.WITHINGS_CLIENT_SECRET,
      apiBase: env.WITHINGS_API_BASE,
    });
    ctx.waitUntil(withings.catchUpIfDue());
  },
};
