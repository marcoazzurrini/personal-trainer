import type { D1Database } from "@cloudflare/workers-types";
import { createClient } from "@trainer/db/client.ts";
import { bodyfatRepository } from "@trainer/db/repositories/bodyfat.ts";
import { bodyweightRepository } from "@trainer/db/repositories/bodyweight.ts";
import { nutritionRepositories } from "@trainer/db/repositories/nutrition/index.ts";
import { Effect } from "effect";

import { bodyfatStore } from "../../src/body/bodyfat.ts";
import { bodyweightStore } from "../../src/body/bodyweight.ts";
import { eventStore } from "../../src/nutrition/events.ts";
import { foodStore } from "../../src/nutrition/foods.ts";
import { intakeStore } from "../../src/nutrition/intake.ts";
import { mealStore } from "../../src/nutrition/meals.ts";
import { nutritionReadStore } from "../../src/nutrition/read.ts";
import { nutritionResolver } from "../../src/nutrition/resolve.ts";
import { targetStore } from "../../src/nutrition/targets.ts";
import { refusalOf } from "../../src/shared/errors.ts";
import { invocationContext, run } from "../../src/shared/runtime.ts";
import type { Invocation } from "../../src/shared/runtime.ts";
import { fixedClock } from "../../src/shared/values.ts";
import { operationInput } from "./test-input.ts";

export default {
  async fetch(request: Request, env: { DB: D1Database }): Promise<Response> {
    try {
      const input = operationInput.parse(await request.json());
      const context = invocationContext({
        env: { DB: env.DB },
        invocation: {
          waitUntil() {
            // The harness answers only after each operation settles.
          },
          passThroughOnException() {
            // No upstream service exists in this harness.
          },
        },
        diagnostic: { id: crypto.randomUUID(), route: "test" },
        clock: fixedClock(input.now ?? "2026-08-24T10:00:00Z"),
      });
      const client = createClient(env.DB);
      const repositories = nutritionRepositories(client);
      const resolver = nutritionResolver(repositories.resolve);
      const bodyweight = bodyweightStore(bodyweightRepository(client));
      const bodyfat = bodyfatStore(bodyfatRepository(client));
      const stores = {
        foods: foodStore(repositories.foods, resolver),
        meals: mealStore(repositories.meals, resolver),
        intake: intakeStore(repositories.intake, resolver),
        targets: targetStore(repositories.targets, bodyweight, bodyfat),
        events: eventStore(repositories.events),
        read: nutritionReadStore(repositories.read, bodyfat),
        resolve: resolver,
      };
      const store = Object.entries(stores).find(
        ([name]) => name === input.store
      )?.[1];
      const operation =
        store &&
        Object.entries(store).find(([name]) => name === input.method)?.[1];
      if (!operation) {
        return new Response("Unknown method", { status: 404 });
      }
      // oxlint-disable-next-line anti-slop/no-reflect-apply -- Negative persistence tests intentionally pass unvalidated arguments to an own store method.
      const outcome = Reflect.apply(operation, store, input.args);
      return Response.json(
        Effect.isEffect(outcome)
          ? // SAFETY: store operations require nothing beyond the invocation context.
            await run(
              context,
              outcome as Effect.Effect<unknown, unknown, Invocation>
            )
          : await outcome
      );
    } catch (error) {
      // Match the production HTTP boundary when calling stores directly.
      const refusal = refusalOf(error);
      return Response.json(
        {
          error:
            refusal?.message ??
            (error instanceof Error ? error.message : String(error)),
        },
        { status: refusal?.status ?? 500 }
      );
    }
  },
};
