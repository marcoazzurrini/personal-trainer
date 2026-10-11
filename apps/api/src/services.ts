import type { D1Database } from "@cloudflare/workers-types";
import { createClient } from "@trainer/db/client.ts";
import { accessRepository } from "@trainer/db/repositories/access.ts";
import { aliasRepository } from "@trainer/db/repositories/aliases.ts";
import { bodyfatRepository } from "@trainer/db/repositories/bodyfat.ts";
import { bodyweightRepository } from "@trainer/db/repositories/bodyweight.ts";
import { nutritionRepositories } from "@trainer/db/repositories/nutrition/index.ts";
import { readinessRepository } from "@trainer/db/repositories/readiness.ts";
import { trainingRepositories } from "@trainer/db/repositories/training/index.ts";
import { withingsRepository } from "@trainer/db/repositories/withings.ts";

import { tokenStore } from "./access/tokens.ts";
import { bodyfatStore } from "./body/bodyfat.ts";
import { bodyweightStore } from "./body/bodyweight.ts";
import { withingsStore } from "./body/withings.ts";
import { eventStore } from "./nutrition/events.ts";
import { foodStore } from "./nutrition/foods.ts";
import { intakeStore } from "./nutrition/intake.ts";
import { mealStore } from "./nutrition/meals.ts";
import { nutritionResolver } from "./nutrition/resolve.ts";
import { nutritionStateStore } from "./nutrition/state.ts";
import { targetStore } from "./nutrition/targets.ts";
import { nutritionWeeklyStore } from "./nutrition/weekly.ts";
import { aliasStore } from "./shared/aliases.ts";
import { blockStore } from "./training/blocks.ts";
import { exerciseStore } from "./training/exercises.ts";
import { mesocycleStore } from "./training/mesocycles.ts";
import { trainingResolver } from "./training/resolve.ts";
import { sessionStore } from "./training/sessions.ts";
import { trainingStateStore } from "./training/state.ts";
import { contextStore } from "./training/user_context.ts";
import { volumeStore } from "./training/volume.ts";
import { scheduleStore } from "./training/week_schedule.ts";

/**
 * Each invocation receives services with named persistence operations. Time
 * is not one of them: the stores read the Clock of the Effect that runs them.
 */
export function createServices(db: D1Database) {
  const client = createClient(db);
  const training = trainingRepositories(client);
  const nutrition = nutritionRepositories(client);
  const trainingReferences = trainingResolver(training.resolution);
  const nutritionReferences = nutritionResolver(nutrition.resolve);
  const bodyweight = bodyweightStore(bodyweightRepository(client));
  const bodyfat = bodyfatStore(bodyfatRepository(client));
  const context = contextStore(training.context);
  const aliases = {
    exercise: aliasStore(aliasRepository(client, "exercise")),
    food: aliasStore(aliasRepository(client, "food")),
    meal: aliasStore(aliasRepository(client, "meal")),
  };
  return {
    checkReadiness: readinessRepository(client).check,
    sessions: sessionStore(training.sessions, trainingReferences),
    bodyweight,
    bodyfat,
    tokens: tokenStore(accessRepository(client)),
    blocks: blockStore(training.blocks),
    context,
    schedule: scheduleStore(training.schedule),
    plans: mesocycleStore(training.mesocycles, trainingReferences),
    exercises: exerciseStore(
      training.exercises,
      trainingReferences,
      aliases.exercise
    ),
    trainingState: trainingStateStore(training.state, context),
    volume: volumeStore(training.volume, trainingReferences),
    foods: foodStore(nutrition.foods, nutritionReferences),
    meals: mealStore(nutrition.meals, nutritionReferences),
    intake: intakeStore(nutrition.intake, nutritionReferences),
    targets: targetStore(nutrition.targets, bodyweight, bodyfat),
    events: eventStore(nutrition.events),
    nutritionState: nutritionStateStore(nutrition.state, bodyweight, bodyfat),
    nutritionWeekly: nutritionWeeklyStore(
      nutrition.weekly,
      bodyweight,
      bodyfat
    ),
    trainingResolver: trainingReferences,
    nutritionResolver: nutritionReferences,
    aliases,
  };
}

export type Services = ReturnType<typeof createServices>;

/** Scheduled and HTTP synchronization use identical account-guarded persistence. */
export function createWithingsService(binding: D1Database) {
  const client = createClient(binding);
  return withingsStore(withingsRepository(client), (accountId) =>
    bodyweightStore(bodyweightRepository(client, accountId))
  );
}
