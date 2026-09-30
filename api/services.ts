import type { D1Database } from "@cloudflare/workers-types";

import { createClient } from "../db/client.ts";
import { accessRepository } from "../db/repositories/access.ts";
import { aliasRepository } from "../db/repositories/aliases.ts";
import { bodyfatRepository } from "../db/repositories/bodyfat.ts";
import { bodyweightRepository } from "../db/repositories/bodyweight.ts";
import { nutritionRepositories } from "../db/repositories/nutrition/index.ts";
import { readinessRepository } from "../db/repositories/readiness.ts";
import { trainingRepositories } from "../db/repositories/training/index.ts";
import { withingsRepository } from "../db/repositories/withings.ts";
import { tokenStore } from "./access/tokens.ts";
import { bodyfatStore } from "./body/bodyfat.ts";
import { bodyweightStore } from "./body/bodyweight.ts";
import { withingsStore } from "./body/withings.ts";
import type { WithingsStoreConfig } from "./body/withings.ts";
import { eventStore } from "./nutrition/events.ts";
import { foodStore } from "./nutrition/foods.ts";
import { intakeStore } from "./nutrition/intake.ts";
import { mealStore } from "./nutrition/meals.ts";
import { nutritionResolver } from "./nutrition/resolve.ts";
import { nutritionStateStore } from "./nutrition/state.ts";
import { targetStore } from "./nutrition/targets.ts";
import { nutritionWeeklyStore } from "./nutrition/weekly.ts";
import { aliasStore } from "./shared/aliases.ts";
import { instant, romeDate, systemClock } from "./shared/values.ts";
import type { Clock } from "./shared/values.ts";
import { blockStore } from "./training/blocks.ts";
import { exerciseStore } from "./training/exercises.ts";
import { mesocycleStore } from "./training/mesocycles.ts";
import { trainingResolver } from "./training/resolve.ts";
import { sessionStore } from "./training/sessions.ts";
import { trainingStateStore } from "./training/state.ts";
import { contextStore } from "./training/user_context.ts";
import { volumeStore } from "./training/volume.ts";
import { scheduleStore } from "./training/week_schedule.ts";

/** Each invocation receives services with named persistence operations and its own clock. */
export function createServices(db: D1Database, clock: Clock = systemClock) {
  const client = createClient(db);
  const training = trainingRepositories(client);
  const nutrition = nutritionRepositories(client);
  const trainingReferences = trainingResolver(training.resolution);
  const nutritionReferences = nutritionResolver(nutrition.resolve);
  const bodyweight = bodyweightStore(bodyweightRepository(client), clock);
  const bodyfat = bodyfatStore(bodyfatRepository(client), clock);
  const context = contextStore(training.context, clock);
  const aliases = {
    exercise: aliasStore(aliasRepository(client, "exercise")),
    food: aliasStore(aliasRepository(client, "food")),
    meal: aliasStore(aliasRepository(client, "meal")),
  };
  return {
    checkReadiness: readinessRepository(client).check,
    clock,
    today: () => romeDate(instant(clock().toISOString())),
    sessions: sessionStore(training.sessions, trainingReferences, clock),
    bodyweight,
    bodyfat,
    tokens: tokenStore(accessRepository(client), clock),
    blocks: blockStore(training.blocks),
    context,
    schedule: scheduleStore(training.schedule, clock),
    plans: mesocycleStore(training.mesocycles, trainingReferences, clock),
    exercises: exerciseStore(
      training.exercises,
      trainingReferences,
      aliases.exercise,
      clock
    ),
    trainingState: trainingStateStore(training.state, context, clock),
    volume: volumeStore(training.volume, trainingReferences, clock),
    foods: foodStore(nutrition.foods, nutritionReferences, clock),
    meals: mealStore(nutrition.meals, nutritionReferences, clock),
    intake: intakeStore(nutrition.intake, nutritionReferences, clock),
    targets: targetStore(nutrition.targets, bodyweight, bodyfat, clock),
    events: eventStore(nutrition.events, clock),
    nutritionState: nutritionStateStore(
      nutrition.state,
      bodyweight,
      bodyfat,
      clock
    ),
    nutritionWeekly: nutritionWeeklyStore(
      nutrition.weekly,
      bodyweight,
      bodyfat,
      clock
    ),
    trainingResolver: trainingReferences,
    nutritionResolver: nutritionReferences,
    aliases,
  };
}

export type Services = ReturnType<typeof createServices>;

/** Scheduled and HTTP synchronization use identical account-guarded persistence. */
export function createWithingsService(
  binding: D1Database,
  config: WithingsStoreConfig,
  clock: Clock = systemClock
) {
  const client = createClient(binding);
  return withingsStore(
    withingsRepository(client),
    (accountId) =>
      bodyweightStore(bodyweightRepository(client, accountId), clock),
    config,
    clock
  );
}
