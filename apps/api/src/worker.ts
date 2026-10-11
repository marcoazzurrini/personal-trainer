import type { Bindings, Invocation } from "./environment.ts";
import { handleRequest } from "./index.ts";
import { createWithingsService } from "./services.ts";
import { invocationContext, run } from "./shared/runtime.ts";

export default {
  fetch(request: Request, env: Bindings, ctx: Invocation): Promise<Response> {
    return handleRequest(request, env, ctx);
  },

  scheduled(
    _event: { scheduledTime: number; cron: string },
    env: Bindings,
    ctx: Invocation
  ): void {
    // A scheduled run is an invocation like a request: its own bindings, the
    // system clock, and a diagnostic of its own on every log line.
    const context = invocationContext({
      env,
      invocation: ctx,
      diagnostic: { id: crypto.randomUUID(), route: "scheduled" },
    });
    const withings = createWithingsService(env.DB);
    // catchUpIfDue answers every failure itself, so this never rejects.
    ctx.waitUntil(run(context, withings.catchUpIfDue()));
  },
};
