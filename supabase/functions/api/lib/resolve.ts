import { sql } from "../db.ts";
import { ApiError } from "./errors.ts";

// Exercises resolve by id, name, or alias, case-insensitively, server-side.
export async function resolveExerciseId(ref: unknown): Promise<number> {
  if (typeof ref === "number" && Number.isInteger(ref)) {
    const [row] = await sql`select id from exercises where id = ${ref}`;
    if (row) return row.id;
    throw new ApiError(
      422,
      `No exercise with id ${ref}. GET /api/exercises lists the catalogue.`,
    );
  }
  if (typeof ref === "string" && ref.trim() !== "") {
    const name = ref.trim();
    const [row] = await sql`
      select e.id from exercises e where lower(e.name) = lower(${name})
      union all
      select a.exercise_id from exercise_aliases a
      where lower(a.alias) = lower(${name})
      limit 1`;
    if (row) return row.id;
    if (/^\d+$/.test(name)) return resolveExerciseId(Number(name));
    throw new ApiError(
      422,
      `Unknown exercise "${name}". Use the id, canonical name, or an alias — GET /api/exercises lists them. A genuinely new exercise is added with POST /api/exercises.`,
    );
  }
  throw new ApiError(
    422,
    '"exercise" is required: an exercise id, canonical name, or alias.',
  );
}

// deno-lint-ignore no-explicit-any
export async function resolveMesocycle(idParam: string): Promise<any> {
  if (idParam === "current") {
    const [row] = await sql`
      select * from mesocycles where ended_on is null`;
    if (!row) {
      throw new ApiError(
        404,
        "No active mesocycle. Create one with POST /api/mesocycles, or pass an explicit id.",
      );
    }
    return row;
  }
  if (!/^\d+$/.test(idParam)) {
    throw new ApiError(
      422,
      `"${idParam}" is not a mesocycle reference. Use a numeric id or "current".`,
    );
  }
  const [row] = await sql`
    select * from mesocycles where id = ${Number(idParam)}`;
  if (!row) throw new ApiError(404, `No mesocycle with id ${idParam}.`);
  return row;
}
