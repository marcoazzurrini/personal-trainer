import type { Context as EffectContext, Effect } from "effect";
import type { Context } from "hono";

import type { Services } from "../services.ts";
import type { Diagnostic } from "./errors.ts";
import * as runtime from "./runtime.ts";
import type { Invocation } from "./runtime.ts";

export interface AppEnv {
  Variables: {
    services: Services;
    diagnostic: Diagnostic;
    context: EffectContext.Context<Invocation>;
  };
}

export function services(c: Context<AppEnv>): Services {
  return c.get("services");
}

/**
 * Run a store's Effect for this request and hand back its value. A refusal
 * reaches the app's error handler as itself and is answered with its sentence.
 */
export function run<A, E>(
  c: { get: (key: "context") => EffectContext.Context<Invocation> },
  effect: Effect.Effect<A, E, Invocation>
): Promise<A> {
  return runtime.run(c.get("context"), effect);
}
