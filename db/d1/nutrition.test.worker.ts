import type { Database } from "../../api/shared/d1.ts";
import { ApiError } from "../../api/shared/errors.ts";
import { foodStore } from "../../api/nutrition/foods.ts";
import { mealStore } from "../../api/nutrition/meals.ts";
import { intakeStore } from "../../api/nutrition/intake.ts";
import { targetStore } from "../../api/nutrition/targets.ts";
import { eventStore } from "../../api/nutrition/events.ts";
import { nutritionReadStore } from "../../api/nutrition/read.ts";
import { nutritionResolver } from "../../api/nutrition/resolve.ts";

export default {
  async fetch(request: Request, env: { DB: Database }): Promise<Response> {
    try {
      const input = (await request.json()) as {
        store: string;
        method: string;
        args: unknown[];
        now?: string;
      };
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
      const store = stores[
        input.store as keyof typeof stores
      ] as unknown as Record<string, (...args: unknown[]) => unknown>;
      if (!store || !Object.hasOwn(store, input.method)) {
        return new Response("Unknown method", { status: 404 });
      }
      return Response.json(await store[input.method](...input.args));
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : String(error) },
        { status: error instanceof ApiError ? error.status : 500 },
      );
    }
  },
};
