import type { Client } from "../../client.ts";
import { eventsRepository } from "./events.ts";
import { expenditureRepository } from "./expenditure.ts";
import { foodsRepository } from "./foods.ts";
import { intakeRepository } from "./intake.ts";
import { mealsRepository } from "./meals.ts";
import { readRepository } from "./read.ts";
import { resolveRepository } from "./resolve.ts";
import { stateRepository } from "./state.ts";
import { targetsRepository } from "./targets.ts";
import { weeklyRepository } from "./weekly.ts";

export function nutritionRepositories(client: Client) {
  return {
    foods: foodsRepository(client),
    meals: mealsRepository(client),
    intake: intakeRepository(client),
    resolve: resolveRepository(client),
    events: eventsRepository(client),
    expenditure: expenditureRepository(client),
    read: readRepository(client),
    state: stateRepository(client),
    targets: targetsRepository(client),
    weekly: weeklyRepository(client),
  };
}
export type NutritionRepositories = ReturnType<typeof nutritionRepositories>;
