import type { Bindings, Invocation } from "./environment.ts";
import { handleRequest } from "./index.ts";
import { createWithingsService } from "./services.ts";

export default {
  fetch(request: Request, env: Bindings, ctx: Invocation): Promise<Response> {
    return handleRequest(request, env, ctx);
  },

  scheduled(
    _event: { scheduledTime: number; cron: string },
    env: Bindings,
    ctx: Invocation
  ): void {
    const withings = createWithingsService(env.DB, {
      clientId: env.WITHINGS_CLIENT_ID,
      clientSecret: env.WITHINGS_CLIENT_SECRET,
      apiBase: env.WITHINGS_API_BASE,
    });
    ctx.waitUntil(withings.catchUpIfDue());
  },
};
