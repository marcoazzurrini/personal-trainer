import type { D1Database } from "@cloudflare/workers-types";

import { bodyfatStore } from "../../api/body/bodyfat.ts";
import { bodyweightStore } from "../../api/body/bodyweight.ts";
import { eventStore } from "../../api/nutrition/events.ts";
import { foodStore } from "../../api/nutrition/foods.ts";
import { intakeStore } from "../../api/nutrition/intake.ts";
import { mealStore } from "../../api/nutrition/meals.ts";
import { nutritionReadStore } from "../../api/nutrition/read.ts";
import { nutritionResolver } from "../../api/nutrition/resolve.ts";
import { targetStore } from "../../api/nutrition/targets.ts";
import { ApiError } from "../../api/shared/errors.ts";
import { createClient } from "../client.ts";
import { bodyfatRepository } from "../repositories/bodyfat.ts";
import { bodyweightRepository } from "../repositories/bodyweight.ts";
import { nutritionRepositories } from "../repositories/nutrition/index.ts";
import { operationInput } from "./test-input.ts";

export default {
  async fetch(request: Request, env: { DB: D1Database }): Promise<Response> {
    try {
      const input = operationInput.parse(await request.json());
      const clock = () => new Date(input.now ?? "2026-08-24T10:00:00Z");
      const client = createClient(env.DB);
      const repositories = nutritionRepositories(client);
      const resolver = nutritionResolver(repositories.resolve);
      const bodyweight = bodyweightStore(bodyweightRepository(client), clock);
      const bodyfat = bodyfatStore(bodyfatRepository(client), clock);
      const stores = {
        foods: foodStore(repositories.foods, resolver, clock),
        meals: mealStore(repositories.meals, resolver, clock),
        intake: intakeStore(repositories.intake, resolver, clock),
        targets: targetStore(repositories.targets, bodyweight, bodyfat, clock),
        events: eventStore(repositories.events, clock),
        read: nutritionReadStore(repositories.read, bodyfat, clock),
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
      return Response.json(await Reflect.apply(operation, store, input.args));
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : String(error) },
        { status: error instanceof ApiError ? error.status : 500 }
      );
    }
  },
};
