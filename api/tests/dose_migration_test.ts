import { assert, assertEquals, assertRejects } from "@std/assert";
import postgres from "postgres";
import { listMigrations, migrate } from "../../db/migrate.ts";
import { verifiedDatabase, verifyDatabase } from "./disposable.ts";

const LEGACY = "20260809240000_dose_history";
const AUTHORITATIVE = "20260908140000_dose_history_is_authoritative";

// Build the actual historical schema in a new owned scratch database. Never
// rewind the shared API's database or edit immutable migration files.
async function historicalDatabase(before: string) {
  const disposable = await verifiedDatabase();
  const database = `pt_dose_${crypto.randomUUID().replaceAll("-", "")}`;
  const admin = postgres(disposable.databaseUrl, {
    max: 1,
    onnotice: () => {},
  });
  try {
    await admin.unsafe(`create database ${database}`);
  } finally {
    await admin.end();
  }
  const url = new URL(disposable.databaseUrl);
  url.pathname = `/${database}`;
  await verifyDatabase({ ...disposable, database }, url.toString());
  const db = postgres(url.toString(), { max: 1, onnotice: () => {} });
  try {
    const all = await listMigrations();
    const cutoff = all.findIndex((m) => m.version === before);
    assert(cutoff > 0, `Missing migration boundary ${before}`);
    await migrate(url.toString(), "status");
    for (const migration of all.slice(0, cutoff)) {
      const text = await Deno.readTextFile(
        new URL(`../../db/migrations/${migration.file}`, import.meta.url),
      );
      await db.begin(async (tx) => {
        await tx.unsafe(text);
        await tx`insert into schema_migrations (version) values (${migration.version})`;
      });
    }
    return { db, url: url.toString() };
  } catch (error) {
    await db.end();
    throw error;
  }
}

async function seedLegacy(db: ReturnType<typeof postgres>) {
  const [block] = await db`insert into blocks (name, goal, started_on)
    values ('Dose migration', 'Verification', '2026-08-03') returning id`;
  const [meso] = await db`insert into mesocycles
    (block_id, name, track, intent, planned_weeks, sessions_per_week, started_on)
    values (${block.id}, 'Historical plan', 'hypertrophy', 'Recorded plan.', 4, 3, '2026-08-03')
    returning id`;
  const [exercise] =
    await db`insert into exercises (name) values ('Historical squat') returning id`;
  await db`insert into mesocycle_exercises
    (mesocycle_id, exercise_id, role, priority, notes, weekly_dose, weekly_dose_unit)
    values (${meso.id}, ${exercise.id}, 'main', 1, 'Original membership.', 9, 'sets')`;
  return { mesocycleId: meso.id, exerciseId: exercise.id };
}

Deno.test("dose migration preserves the legacy backfill and a 9-to-12 history", async () => {
  const { db, url } = await historicalDatabase(LEGACY);
  try {
    const { mesocycleId, exerciseId } = await seedLegacy(db);
    // Exercise the original backfill, not an imitation in a fixture.
    const legacySql = await Deno.readTextFile(
      new URL(`../../db/migrations/${LEGACY}.sql`, import.meta.url),
    );
    await db.begin(async (tx) => {
      await tx.unsafe(legacySql);
      await tx`insert into schema_migrations (version) values (${LEGACY})`;
    });
    const baseline = [
      ...await db`select * from mesocycle_exercise_doses order by id`,
    ];
    assertEquals(baseline.length, 1);
    assertEquals(Number(baseline[0].weekly_dose), 9);
    assertEquals(
      (await db`select effective_from::text from mesocycle_exercise_doses`)[0]
        .effective_from,
      "2026-08-03",
    );
    await db.begin(async (tx) => {
      await tx`update mesocycle_exercises set weekly_dose = 12
        where mesocycle_id = ${mesocycleId} and exercise_id = ${exerciseId}`;
      await tx`insert into mesocycle_exercise_doses
        (mesocycle_id, exercise_id, weekly_dose, weekly_dose_unit, effective_from)
        values (${mesocycleId}, ${exerciseId}, 12, 'sets', '2026-08-10')`;
      await tx`insert into mesocycle_decisions (mesocycle_id, what_changed, why)
        values (${mesocycleId}, 'Squat 9 to 12 sets.', 'Recovering well.')`;
    });
    // Retained doses are not membership: include a removed exercise.
    const [removed] =
      await db`insert into exercises (name) values ('Removed exercise') returning id`;
    await db`insert into mesocycle_exercise_doses
      (mesocycle_id, exercise_id, weekly_dose, weekly_dose_unit, effective_from)
      values (${mesocycleId}, ${removed.id}, 6, 'sets', '2026-08-03')`;
    const history = [
      ...await db`select * from mesocycle_exercise_doses order by id`,
    ];
    const members = [
      ...await db`select id, mesocycle_id, exercise_id, role, priority, notes
      from mesocycle_exercises order by id`,
    ];
    const decisions = [
      ...await db`select * from mesocycle_decisions order by id`,
    ];
    const report = await migrate(url);
    assert(report.ran.includes(AUTHORITATIVE));
    assertEquals([
      ...await db`select * from mesocycle_exercise_doses order by id`,
    ], history);
    assertEquals(
      [...await db`select * from mesocycle_exercises order by id`],
      members,
    );
    assertEquals(
      [...await db`select * from mesocycle_decisions order by id`],
      decisions,
    );
    assertEquals(
      (await db`select column_name from information_schema.columns
      where table_schema = 'public' and table_name = 'mesocycle_exercises'
        and column_name in ('weekly_dose', 'weekly_dose_unit')`).length,
      0,
    );
    for (
      const [day, expected] of [["2026-08-09", 9], ["2026-08-16", 12]] as const
    ) {
      const [row] =
        await db`select weekly_dose::float8 as dose from mesocycle_exercise_doses
        where mesocycle_id = ${mesocycleId} and exercise_id = ${exerciseId}
          and effective_from <= ${day}::date
        order by effective_from desc, id desc limit 1`;
      assertEquals(row.dose, expected);
    }
    const constraints = await db`select conname from pg_constraint
      where conrelid = 'mesocycle_exercise_doses'::regclass`;
    for (
      const name of [
        "mesocycle_exercises_weekly_dose_positive",
        "mesocycle_exercises_weekly_dose_unit_check",
      ]
    ) {
      assert(constraints.some((r) => r.conname === name));
    }
    for (const [dose, unit] of [[0, "sets"], [9, "reps"]] as const) {
      await assertRejects(
        () =>
          db`insert into mesocycle_exercise_doses
        (mesocycle_id, exercise_id, weekly_dose, weekly_dose_unit, effective_from)
        values (${mesocycleId}, ${exerciseId}, ${dose}, ${unit}, '2026-08-17')`,
        Error,
        "violates check constraint",
      );
    }
    assertEquals((await migrate(url)).ran, []);
    assertEquals([
      ...await db`select * from mesocycle_exercise_doses order by id`,
    ], history);
  } finally {
    await db.end();
  }
});

Deno.test("dose migration refuses missing, conflicting or invalid history without inventing a backfill", async (t) => {
  const { db, url } = await historicalDatabase(AUTHORITATIVE);
  try {
    const { mesocycleId, exerciseId } = await seedLegacy(db);
    const members = [
      ...await db`select * from mesocycle_exercises order by id`,
    ];
    const assertRefused = async (message: string) => {
      const before = [
        ...await db`select * from mesocycle_exercise_doses order by id`,
      ];
      await assertRejects(() => migrate(url), Error, message);
      assertEquals([
        ...await db`select * from mesocycle_exercise_doses order by id`,
      ], before);
      assertEquals(
        [...await db`select * from mesocycle_exercises order by id`],
        members,
      );
      assert(!(await migrate(url, "status")).applied.includes(AUTHORITATIVE));
    };
    await t.step(
      "missing history does not become an invented start-date dose",
      async () => {
        await assertRefused("Dose history is missing or disagrees");
      },
    );
    await t.step(
      "a conflicting historical dose is not overwritten by the current copy",
      async () => {
        await db`insert into mesocycle_exercise_doses
        (mesocycle_id, exercise_id, weekly_dose, weekly_dose_unit, effective_from)
        values (${mesocycleId}, ${exerciseId}, 6, 'sets', '2026-08-03')`;
        await assertRefused("Dose history is missing or disagrees");
      },
    );
    // Fixture repair supplies known evidence, not code in the migration.
    await db`update mesocycle_exercise_doses set weekly_dose = 9`;
    await t.step(
      "invalid history for a removed exercise is still validated",
      async () => {
        const [removed] =
          await db`insert into exercises (name) values ('Invalid removed dose') returning id`;
        const [invalid] = await db`insert into mesocycle_exercise_doses
        (mesocycle_id, exercise_id, weekly_dose, weekly_dose_unit, effective_from)
        values (${mesocycleId}, ${removed.id}, 0, 'sets', '2026-08-03') returning id`;
        await assertRefused("mesocycle_exercises_weekly_dose_positive");
        await db`delete from mesocycle_exercise_doses where id = ${invalid.id}`;
      },
    );
    assert((await migrate(url)).ran.includes(AUTHORITATIVE));
    assertEquals((await db`select * from mesocycle_exercise_doses`).length, 1);
  } finally {
    await db.end();
  }
});
