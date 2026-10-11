import type { VolumeRepository } from "@trainer/db/repositories/training/volume.ts";
import { Effect } from "effect";

import { effectful } from "../shared/database.ts";
import { mondayOf } from "../shared/dates.ts";
import { Invalid } from "../shared/refusals.ts";
import type { DatabaseFailure, NotFound } from "../shared/refusals.ts";
import { today } from "../shared/values.ts";
import type { trainingResolver } from "./resolve.ts";
import { deliveredInDoseUnit } from "./rules.ts";
import type { ExerciseWeek, VolumeRow } from "./volume.types.ts";

/** The D1 views retain all weeks. Only readers apply the Rome cutoff. */
export function volumeStore(
  rows: VolumeRepository,
  resolver: ReturnType<typeof trainingResolver>
) {
  const repository = effectful(rows);

  const volumePerMuscle = Effect.fn("volume.volumePerMuscle")(function* (
    param: string
  ): Effect.fn.Return<
    { mesocycle_id?: number; weekly_volume: VolumeRow[] },
    Invalid | NotFound | DatabaseFailure
  > {
    const cutoff = mondayOf(yield* today);
    if (param === "all") {
      return {
        weekly_volume: yield* repository.allMuscles(cutoff),
      };
    }
    const m = yield* resolver.resolveMesocycle(param);
    return {
      mesocycle_id: m.id,
      weekly_volume: yield* repository.muscles(m.id, cutoff),
    };
  });
  const dosePerExercise = Effect.fn("volume.dosePerExercise")(function* (
    param: string
  ): Effect.fn.Return<
    {
      mesocycle_id: number;
      track: string;
      weekly_exercise_sets: ExerciseWeek[];
    },
    Invalid | NotFound | DatabaseFailure
  > {
    if (param === "all") {
      return yield* new Invalid({
        message:
          '"all" works on GET /weekly-volume but not here. These weeks are numbered from a mesocycle\'s start, so week 3 of two different plans are different weeks against different doses — combining them would compare numbers that share no meaning. Pass a mesocycle id, "current", or "current:<track>".',
      });
    }
    const m = yield* resolver.resolveMesocycle(param);
    const found = yield* repository.dose(m.id, mondayOf(yield* today));
    return {
      mesocycle_id: m.id,
      track: m.track,
      weekly_exercise_sets: found.map((r) => ({
        ...r,
        delivered:
          r.dose_unit === null
            ? null
            : deliveredInDoseUnit(
                r.dose_unit,
                r.sets_done,
                r.distance_m,
                r.duration_s
              ),
      })),
    };
  });
  return { volumePerMuscle, dosePerExercise };
}
