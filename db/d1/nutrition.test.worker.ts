import { eventStore } from "../../api/nutrition/events.ts";
import { foodStore } from "../../api/nutrition/foods.ts";
import { intakeStore } from "../../api/nutrition/intake.ts";
import { mealStore } from "../../api/nutrition/meals.ts";
import { nutritionReadStore } from "../../api/nutrition/read.ts";
import { nutritionResolver } from "../../api/nutrition/resolve.ts";
import { targetStore } from "../../api/nutrition/targets.ts";
import type { Database } from "../../api/shared/d1.ts";
import { ApiError } from "../../api/shared/errors.ts";
import { operationInput } from "./test-input.ts";

export default {
  async fetch(request: Request, env: { DB: Database }): Promise<Response> {
    try {
      const input = operationInput.parse(await request.json());
      const clock = () => new Date(input.now ?? "2026-08-24T10:00:00Z");
      const stores = {
        foods: foodStore(env.DB, clock),
        meals: mealStore(env.DB, clock),
        intake: intakeStore(env.DB, clock),
        targets: targetStore(env.DB, clock),
        events: eventStore(env.DB, clock),
        read: nutritionReadStore(env.DB, clock),
        resolve: nutritionResolver(env.DB, clock),
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
      return Response.json(await Reflect.apply(operation, store, input.args));
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : String(error) },
        { status: error instanceof ApiError ? error.status : 500 }
      );
    }
  },
};
