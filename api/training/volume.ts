import type { VolumeRepository } from "../../db/repositories/training/volume.ts";
import { mondayOf } from "../shared/dates.ts";
import { ApiError } from "../shared/errors.ts";
import { instant, romeDate, systemClock } from "../shared/values.ts";
import type { Clock } from "../shared/values.ts";
import type { trainingResolver } from "./resolve.ts";
import { deliveredInDoseUnit } from "./rules.ts";
import type { ExerciseWeek, VolumeRow } from "./volume.types.ts";

/** The D1 views retain all weeks. Only readers apply the Rome cutoff. */
export function volumeStore(
  repository: VolumeRepository,
  resolver: ReturnType<typeof trainingResolver>,
  clock: Clock = systemClock
) {
  async function volumePerMuscle(
    param: string
  ): Promise<{ mesocycle_id?: number; weekly_volume: VolumeRow[] }> {
    const cutoff = mondayOf(romeDate(instant(clock().toISOString())));
    if (param === "all") {
      return {
        weekly_volume: await repository.allMuscles(cutoff),
      };
    }
    const m = await resolver.resolveMesocycle(param);
    return {
      mesocycle_id: m.id,
      weekly_volume: await repository.muscles(m.id, cutoff),
    };
  }
  async function dosePerExercise(param: string): Promise<{
    mesocycle_id: number;
    track: string;
    weekly_exercise_sets: ExerciseWeek[];
  }> {
    if (param === "all") {
      throw new ApiError(
        422,
        '"all" works on GET /weekly-volume but not here. These weeks are numbered from a mesocycle\'s start, so week 3 of two different plans are different weeks against different doses — combining them would compare numbers that share no meaning. Pass a mesocycle id, "current", or "current:<track>".'
      );
    }
    const m = await resolver.resolveMesocycle(param);
    const found = await repository.dose(
      m.id,
      mondayOf(romeDate(instant(clock().toISOString())))
    );
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
  }
  return { volumePerMuscle, dosePerExercise };
}
