import {
  type Clock,
  type Database,
  instant,
  romeDate,
  systemClock,
} from "./shared/d1.ts";
import { aliasStore } from "./shared/aliases.ts";
import { bodyfatStore } from "./body/bodyfat.ts";
import { bodyweightStore } from "./body/bodyweight.ts";
import { blockStore } from "./training/blocks.ts";
import { exerciseStore } from "./training/exercises.ts";
import { mesocycleStore } from "./training/mesocycles.ts";
import { trainingResolver } from "./training/resolve.ts";
import { sessionStore } from "./training/sessions.ts";
import { trainingStateStore } from "./training/state.ts";
import { contextStore } from "./training/user_context.ts";
import { volumeStore } from "./training/volume.ts";
import { scheduleStore } from "./training/week_schedule.ts";
import { eventStore } from "./nutrition/events.ts";
import { foodStore } from "./nutrition/foods.ts";
import { intakeStore } from "./nutrition/intake.ts";
import { mealStore } from "./nutrition/meals.ts";
import { nutritionResolver } from "./nutrition/resolve.ts";
import { nutritionStateStore } from "./nutrition/state.ts";
import { targetStore } from "./nutrition/targets.ts";
import { nutritionWeeklyStore } from "./nutrition/weekly.ts";

/** Each request gets stores bound to its own database and clock. */
export function createServices(db: Database, clock: Clock = systemClock) {
  return {
    clock,
    today: () => romeDate(instant(clock().toISOString())),
    sessions: sessionStore(db, clock),
    bodyweight: bodyweightStore(db, clock),
    bodyfat: bodyfatStore(db, clock),
    blocks: blockStore(db),
    context: contextStore(db, clock),
    schedule: scheduleStore(db, clock),
    plans: mesocycleStore(db, clock),
    exercises: exerciseStore(db, clock),
    trainingState: trainingStateStore(db, clock),
    volume: volumeStore(db, clock),
    foods: foodStore(db, clock),
    meals: mealStore(db, clock),
    intake: intakeStore(db, clock),
    targets: targetStore(db, clock),
    events: eventStore(db, clock),
    nutritionState: nutritionStateStore(db, clock),
    nutritionWeekly: nutritionWeeklyStore(db, clock),
    trainingResolver: trainingResolver(db),
    nutritionResolver: nutritionResolver(db),
    aliases: {
      exercise: aliasStore(db, "exercise"),
      food: aliasStore(db, "food"),
      meal: aliasStore(db, "meal"),
    },
  };
}

export type Services = ReturnType<typeof createServices>;
