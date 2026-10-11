import type { D1Database } from "@cloudflare/workers-types";

import { createClient } from "../../../db/client.ts";
import { bodyfatRepository } from "../../../db/repositories/bodyfat.ts";
import { bodyweightRepository } from "../../../db/repositories/bodyweight.ts";
import { nutritionRepositories } from "../../../db/repositories/nutrition/index.ts";
import { bodyfatStore } from "../../body/bodyfat.ts";
import { bodyweightStore } from "../../body/bodyweight.ts";
import { eventStore } from "../../nutrition/events.ts";
import { foodStore } from "../../nutrition/foods.ts";
import { intakeStore } from "../../nutrition/intake.ts";
import { mealStore } from "../../nutrition/meals.ts";
import { nutritionReadStore } from "../../nutrition/read.ts";
import { nutritionResolver } from "../../nutrition/resolve.ts";
import { targetStore } from "../../nutrition/targets.ts";
import { ApiError } from "../../shared/errors.ts";
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
