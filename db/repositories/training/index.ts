import type { Client } from "../../client.ts";
import { blocksRepository } from "./blocks.ts";
import { contextRepository } from "./context.ts";
import { exercisesRepository } from "./exercises.ts";
import { mesocyclesRepository } from "./mesocycles.ts";
import { resolutionRepository } from "./resolve.ts";
import { scheduleRepository } from "./schedule.ts";
import { sessionsRepository } from "./sessions.ts";
import { stateRepository } from "./state.ts";
import { volumeRepository } from "./volume.ts";

export function trainingRepositories(client: Client) {
  return {
    blocks: blocksRepository(client),
    context: contextRepository(client),
    exercises: exercisesRepository(client),
    mesocycles: mesocyclesRepository(client),
    resolution: resolutionRepository(client),
    schedule: scheduleRepository(client),
    sessions: sessionsRepository(client),
    state: stateRepository(client),
    volume: volumeRepository(client),
  };
}
export type TrainingRepositories = ReturnType<typeof trainingRepositories>;
