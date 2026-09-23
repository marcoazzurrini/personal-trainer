import assert from "node:assert/strict";
import { before, test } from "node:test";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { build } from "esbuild";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { migrationStatements } from "./local.mjs";
import { scaledInteger } from "./codec.mjs";
import storage from "./storage.json" with { type: "json" };

const doseStorage =
  storage.tables.mesocycle_exercise_doses.decimals.weekly_dose;
const storedDose = (value) =>
  scaledInteger(value, doseStorage.precision, doseStorage.scale);

let script;
let migrations;
before(async () => {
  const compiled = await build({
    entryPoints: [
      fileURLToPath(new URL("./training.test.worker.ts", import.meta.url)),
    ],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2022",
    metafile: true,
  });
  assert.ok(
    !Object.keys(compiled.metafile.inputs).some((name) =>
      /api\/db\.ts$|node_modules\/postgres\//.test(name)
    ),
  );
  script = compiled.outputFiles[0].text;
  const directory = new URL("./migrations/", import.meta.url);
  const files = (await readdir(directory))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  migrations = migrationStatements(
    (
      await Promise.all(
        files.map((name) => readFile(new URL(name, directory), "utf8")),
      )
    ).join("\n"),
  );
});
async function fixture(t) {
  const options = convertV4MiniflareOptions({
    modules: true,
    script,
    compatibilityDate: "2026-08-03",
    d1Databases: { DB: `synthetic-training-${randomUUID()}` },
    outboundService() {
      throw new Error("Test Workers cannot contact external services.");
    },
  });
  assert.equal(options.resourcePersistencePath, undefined);
  const mf = new Miniflare({
    ...options,
    cf: false,
    telemetry: { enabled: false },
  });
  t.after(() => mf.dispose());
  const db = await mf.getD1Database("DB");
  await db.batch(migrations.map((sql) => db.prepare(sql)));
  const sql = (query, ...values) =>
    db
      .prepare(query)
      .bind(...values)
      .all();
  async function call(store, method, args = [], options = {}) {
    const response = await mf.dispatchFetch("http://local.invalid/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ store, method, args, ...options }),
    });
    return { status: response.status, body: await response.json() };
  }
  async function ok(store, method, args = [], options = {}) {
    const r = await call(store, method, args, options);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body;
  }
  const count = async (table) =>
    (await sql(`SELECT count(*) AS n FROM ${table}`)).results[0].n;
  const exercise = (extra = {}) =>
    ok("exercises", "addExercise", [
      {
        name: "Squat",
        measure: "load_reps",
        stimulus_type: "strength",
        systemic_fatigue: "normal",
        ...extra,
      },
    ]);
  return { db, sql, call, ok, count, exercise };
}
async function plans(f) {
  await f.sql(
    "INSERT INTO blocks (id, name, goal, started_on) VALUES (1, 'Synthetic', 'strength', '2026-08-03')",
  );
  await f.sql(
    `INSERT INTO mesocycles (id, block_id, name, intent, planned_weeks, sessions_per_week, started_on, track) VALUES
    (1, 1, 'Lift', 'Synthetic', 4, 3, '2026-08-03', 'hypertrophy'),
    (2, 1, 'Run', 'Synthetic', 4, 2, '2026-08-03', 'speed')`,
  );
}
async function session(f, day, sets) {
  const id = (
    await f.sql(
      "INSERT INTO sessions (date, rationale) VALUES (?, 'Synthetic') RETURNING id",
      day,
    )
  ).results[0].id;
  for (let i = 0; i < sets.length; i++) {
    const s = {
      exercise_id: 1,
      mesocycle_id: null,
      kind: "working",
      weight_kg: null,
      reps: null,
      distance_m: null,
      duration_s: null,
      effort: null,
      notes: null,
      ...sets[i],
    };
    await f.sql(
      `INSERT INTO sets (session_id, position, exercise_id, mesocycle_id, kind, weight_kg, reps, distance_m, duration_s, effort, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      i + 1,
      s.exercise_id,
      s.mesocycle_id,
      s.kind,
      s.weight_kg,
      s.reps,
      s.distance_m,
      s.duration_s,
      s.effort,
      s.notes,
    );
  }
  return id;
}

test("registry normalizes Unicode names, preserves JSON/null and rounded muscle factors", async (t) => {
  const f = await fixture(t);
  await f.ok("exercises", "addMuscle", ["Épaules"]);
  const e = await f.exercise({
    name: "Élévation",
    aliases: ["Álto", "raise"],
    muscles: [{ muscle: "ÉPAULES", volume_factor: 0.54 }],
  });
  assert.deepEqual(e.aliases, ["raise", "Álto"]);
  assert.deepEqual(e.muscles, [{ muscle: "Épaules", volume_factor: 0.5 }]);
  assert.equal(e.notes, null);
  assert.equal(
    (await f.sql("SELECT name_key FROM exercises")).results[0].name_key,
    "élévation",
  );
  assert.equal(
    (await f.call("exercises", "addExercise", [{ ...e, name: "ÉLÉVATION" }]))
      .status,
    409,
  );
  const renamed = await f.ok("exercises", "correctExercise", [
    "ÁLTO",
    { name: "Élévation bis", notes: "Note", equipment: null },
  ]);
  assert.equal(renamed.name, "Élévation bis");
  assert.equal(
    (await f.sql("SELECT name_key FROM exercises")).results[0].name_key,
    "élévation bis",
  );
  assert.equal((await f.ok("exercises", "listExercises")).length, 1);
  assert.equal(
    (await f.call("exercises", "addMuscle", ["Épaules"])).status,
    409,
  );
});

test("registry rejects retired fields, unknown muscles and aliases without partial creation", async (t) => {
  const f = await fixture(t);
  await f.exercise({ aliases: ["Taken"] });
  for (
    const muscles of [
      [{ muscle: "Missing", volume_factor: 1 }],
      [{ muscle: "Any", volume_factor: 1, counts: true }],
      [{ muscle: "Any", volume_factor: 1, fatigue: "high" }],
    ]
  ) {
    assert.equal(
      (
        await f.call("exercises", "addExercise", [
          {
            name: "No",
            measure: "reps",
            stimulus_type: "strength",
            systemic_fatigue: "normal",
            muscles,
          },
        ])
      ).status,
      422,
    );
  }
  const clash = await f.call("exercises", "addExercise", [
    {
      name: "No",
      measure: "reps",
      stimulus_type: "strength",
      systemic_fatigue: "normal",
      aliases: ["Free", "TAKEN"],
    },
  ]);
  assert.equal(clash.status, 409);
  assert.match(
    clash.body.error,
    /"Taken" already belongs to exercise 1 \(Squat\)/,
  );
  assert.equal(await f.count("exercises"), 1);
  assert.equal(await f.count("exercise_aliases"), 1);
  await f.ok("exercises", "addMuscle", ["Leg"]);
  const invalid = await f.call("exercises", "addExercise", [
    {
      name: "No",
      measure: "reps",
      stimulus_type: "strength",
      systemic_fatigue: "normal",
      aliases: ["Free"],
      muscles: [{ muscle: "Leg", volume_factor: 0.2 }],
    },
  ]);
  assert.equal(invalid.status, 422);
  assert.equal(await f.count("exercises"), 1);
  assert.equal(await f.count("exercise_aliases"), 1);
});

test("all alias namespaces preserve atomicity, Unicode release, ownership and FK mapping", async (t) => {
  const f = await fixture(t);
  await f.exercise();
  await f.sql(
    "INSERT INTO foods (id, name, name_key, source, kcal_100g, protein_100g, carbs_100g, fat_100g) VALUES (1, 'Food', 'food', 'label', 10000, 100, 100, 100)",
  );
  await f.sql(
    "INSERT INTO meals (id, name, name_key) VALUES (1, 'Meal', 'meal')",
  );
  for (
    const [store, table] of [
      ["exerciseAliases", "exercise_aliases"],
      ["foodAliases", "food_aliases"],
      ["mealAliases", "meal_aliases"],
    ]
  ) {
    await f.ok(store, "addAliases", [1, ["Été"]]);
    assert.equal(
      (await f.call(store, "addAliases", [1, ["Free", "ÉTÉ"]])).status,
      409,
    );
    assert.equal(await f.count(table), 1);
    assert.equal(
      (await f.call(store, "addAliases", [999, ["Missing"]])).status,
      422,
    );
    const absent = await f.call(store, "releaseAlias", [
      { id: 999, alias: "ÉTÉ", notAnAlias: "Not yours." },
    ]);
    assert.equal(absent.status, 404);
    assert.equal(absent.body.error, "Not yours.");
    await f.ok(store, "releaseAlias", [
      { id: 1, alias: "ÉTÉ", notAnAlias: "Gone." },
    ]);
    assert.equal(await f.count(table), 0);
    await f.ok(store, "addAliases", [999, []]);
  }
});

test("canonical names beat aliases, numeric names beat ids, history requires limit and scales actuals", async (t) => {
  const f = await fixture(t);
  await f.exercise({ aliases: ["Run", "1"] });
  const run = await f.exercise({
    name: "Run",
    measure: "distance_duration",
    stimulus_type: "power",
  });
  const numeric = await f.exercise({ name: "1", measure: "reps" });
  assert.equal(
    (await f.ok("exercises", "exerciseHistory", ["1", "all"])).exercise_id,
    numeric.id,
  );
  await session(f, "2026-08-01", [
    { exercise_id: run.id, distance_m: 1234, duration_s: 987, notes: "First" },
    { exercise_id: run.id },
    { exercise_id: run.id, kind: "warmup", distance_m: 100 },
  ]);
  await session(f, "2026-08-02", [
    { exercise_id: run.id, distance_m: 10, notes: "Second" },
  ]);
  assert.equal(
    (await f.call("exercises", "exerciseHistory", ["RUN"])).status,
    422,
  );
  const full = await f.ok("exercises", "exerciseHistory", ["RUN", "all"]);
  assert.equal(full.total_sets, 2);
  assert.deepEqual(
    full.sets.map((s) => s.distance_m),
    [123.4, 1],
  );
  assert.equal(full.sets[0].duration_s, 9.87);
  assert.equal(full.sets[0].weight_kg, null);
  const recent = await f.ok("exercises", "exerciseHistory", ["RUN", "1"]);
  assert.equal(recent.returned, 1);
  assert.equal(recent.total_sets, 2);
  assert.equal(recent.sets[0].notes, "Second");
});

test("correction freezes identity at any set and deletion retains all referenced history", async (t) => {
  const f = await fixture(t);
  await f.exercise({ aliases: ["Lift"] });
  await f.ok("exercises", "correctExercise", ["Lift", { measure: "reps" }]);
  await session(f, "2026-08-01", [{}]);
  assert.equal(
    (
      await f.call("exercises", "correctExercise", [
        "Lift",
        { measure: "distance", notes: "No" },
      ])
    ).status,
    422,
  );
  assert.equal(
    (await f.call("exercises", "deleteExercise", ["Lift"])).status,
    409,
  );
  for (const b of [{}, { muscles: [] }, { aliases: [] }]) {
    assert.equal(
      (await f.call("exercises", "correctExercise", ["Lift", b])).status,
      422,
    );
  }
  assert.equal(
    (
      await f.ok("exercises", "correctExercise", [
        "Lift",
        { notes: null, systemic_fatigue: "high" },
      ])
    ).systemic_fatigue,
    "high",
  );
  const spare = await f.exercise({ name: "Spare", aliases: ["Unused"] });
  assert.equal(
    await f.ok("exercises", "deleteExercise", [String(spare.id)]),
    "Spare",
  );
  assert.equal(await f.count("exercise_aliases"), 1);
  await plans(f);
  const retained = await f.exercise({ name: "Retained" });
  await f.sql(
    "INSERT INTO mesocycle_exercise_doses (mesocycle_id, exercise_id, weekly_dose, weekly_dose_unit, effective_from) VALUES (1, ?, ?, 'sets', '2026-08-03')",
    retained.id,
    storedDose(9),
  );
  const refusal = await f.call("exercises", "deleteExercise", [
    String(retained.id),
  ]);
  assert.equal(refusal.status, 409);
  assert.match(refusal.body.error, /1 dose history row/);
});

test("classification is a whole atomic replacement and counts completed Rome weeks", async (t) => {
  const f = await fixture(t);
  await f.ok("exercises", "addMuscle", ["Leg"]);
  await f.exercise({ muscles: [{ muscle: "Leg", volume_factor: 1 }] });
  await session(f, "2026-03-29", [{}]);
  await session(f, "2026-03-30", [{ reps: 1 }]);
  const beforeMonday = await f.ok(
    "exercises",
    "reclassifyMuscles",
    ["Squat", []],
    { now: "2026-03-29T21:59:00Z" },
  );
  assert.match(beforeMonday.note, /No finished week/);
  const monday = await f.ok(
    "exercises",
    "reclassifyMuscles",
    ["Squat", [{ muscle: "Leg", volume_factor: 0.5 }]],
    { now: "2026-03-29T22:00:00Z" },
  );
  assert.match(monday.note, /1 finished week/);
  assert.equal(
    (
      await f.call("exercises", "reclassifyMuscles", [
        "Squat",
        [
          { muscle: "Leg", volume_factor: 1 },
          { muscle: "Leg", volume_factor: 0 },
        ],
      ])
    ).status,
    409,
  );
  assert.deepEqual((await f.ok("exercises", "exerciseById", [1])).muscles, [
    { muscle: "Leg", volume_factor: 0.5 },
  ]);
  await plans(f);
  await f.sql(
    "INSERT INTO mesocycle_exercises (mesocycle_id, exercise_id, role, priority) VALUES (1, 1, 'main', 1)",
  );
  assert.equal(
    (await f.call("exercises", "reclassifyMuscles", ["Squat", []])).status,
    409,
  );
});

test("registry batches reject stale eligibility and roll back failed readbacks", async (t) => {
  const f = await fixture(t);
  await f.exercise();
  await f.sql(
    "INSERT INTO sessions (id, date, rationale) VALUES (1, '2026-08-01', 'Synthetic')",
  );
  const lateSet = {
    beforeWrite: {
      sql:
        "INSERT INTO sets (session_id, position, exercise_id, kind) VALUES (1, 1, 1, 'working')",
    },
  };
  assert.equal(
    (
      await f.call(
        "exercises",
        "correctExercise",
        ["Squat", { measure: "reps", notes: "No" }],
        lateSet,
      )
    ).status,
    409,
  );
  assert.equal(
    (await f.ok("exercises", "exerciseById", [1])).measure,
    "load_reps",
  );
  await f.sql("DELETE FROM sets");
  assert.equal(
    (await f.call("exercises", "deleteExercise", ["Squat"], lateSet)).status,
    409,
  );
  await plans(f);
  assert.equal(
    (
      await f.call("exercises", "reclassifyMuscles", ["Squat", []], {
        beforeWrite: {
          sql:
            "INSERT INTO mesocycle_exercises (mesocycle_id, exercise_id, role, priority) VALUES (1, 1, 'main', 1)",
        },
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await f.call("exercises", "correctExercise", ["Squat", { notes: "No" }], {
        failReadback: true,
      })
    ).status,
    500,
  );
  assert.equal((await f.ok("exercises", "exerciseById", [1])).notes, null);
  assert.equal(
    (
      await f.call(
        "exercises",
        "addExercise",
        [
          {
            name: "No",
            measure: "reps",
            stimulus_type: "strength",
            systemic_fatigue: "normal",
          },
        ],
        { failReadback: true },
      )
    ).status,
    500,
  );
  assert.equal(await f.count("exercises"), 1);
  assert.equal(await f.count("api_write_assertions"), 0);
});

test("state distinguishes onboarding from programming and emits Rome clock plus wire instants", async (t) => {
  const f = await fixture(t);
  const first = await f.ok("state", "trainingState", [], {
    now: "2026-03-29T22:30:00Z",
  });
  assert.deepEqual(first.now, {
    date: "2026-03-30",
    time: "00:30",
    weekday: "Monday",
    tz: "Europe/Rome",
  });
  assert.match(first.note, /onboarding/);
  assert.equal(Object.hasOwn(first, "recent_sessions"), false);
  assert.equal(first.week_schedule, null);
  await f.sql(
    "INSERT INTO user_context (topic, content, written_at) VALUES ('sleep', 'Old', '2026-03-29T12:00:00.123456Z'), ('sleep', 'New', '2026-03-29T12:00:00.123456Z')",
  );
  await f.sql(
    "INSERT INTO week_schedules (week_start, schedule, written_at) VALUES ('2026-03-30', 'Train', '2026-03-29T12:00:00.123456Z')",
  );
  const known = await f.ok("state", "trainingState", [], {
    now: "2026-03-29T22:30:00Z",
  });
  assert.match(known.note, /programming/);
  assert.equal(known.user_context[0].content, "New");
  assert.equal(known.user_context[0].written_at, "2026-03-29T12:00:00.123Z");
  assert.equal(known.week_schedule.written_at, "2026-03-29T12:00:00.123Z");
});

async function summaryFixture(t) {
  const f = await fixture(t);
  await f.ok("exercises", "addMuscle", ["Leg"]);
  await f.exercise({ muscles: [{ muscle: "Leg", volume_factor: 0.5 }] });
  await f.exercise({
    name: "Run",
    measure: "distance_duration",
    stimulus_type: "power",
    muscles: [{ muscle: "Leg", volume_factor: 1 }],
  });
  await plans(f);
  await f.sql(
    "INSERT INTO mesocycle_exercises (mesocycle_id, exercise_id, role, priority) VALUES (1, 1, 'main', 1), (2, 2, 'main', 1)",
  );
  await f.sql(
    `INSERT INTO mesocycle_exercise_doses (mesocycle_id, exercise_id, weekly_dose, weekly_dose_unit, effective_from) VALUES
    (1, 1, ?, 'sets', '2026-08-03'), (1, 1, ?, 'sets', '2026-08-06'), (1, 1, ?, 'sets', '2026-08-06'),
    (2, 2, ?, 'km', '2026-08-03'), (2, 2, ?, 'minutes', '2026-08-10')`,
    ...[9, 11, 12, 1.25, 10].map(storedDose),
  );
  await session(f, "2026-08-04", [
    { mesocycle_id: 1, weight_kg: 8235, reps: 5 },
    { mesocycle_id: 1 },
    { weight_kg: 7000, reps: 4 },
    { mesocycle_id: 2, exercise_id: 2, distance_m: 12345, duration_s: 60000 },
    { mesocycle_id: 1, kind: "warmup", reps: 3 },
  ]);
  await session(f, "2026-08-11", [
    { mesocycle_id: 2, exercise_id: 2, duration_s: 12000 },
  ]);
  await session(f, "2026-08-24", [
    { mesocycle_id: 1, weight_kg: 8000, reps: 4 },
    { mesocycle_id: 1, weight_kg: 9000, reps: 3 },
    { exercise_id: 2, mesocycle_id: 2, duration_s: 9000 },
  ]);
  await session(f, "2026-08-29", [{ kind: "warmup", reps: 2 }]);
  return f;
}

test("volume applies finished-week cutoff, attribution, strength filtering and fractional factors", async (t) => {
  const f = await summaryFixture(t);
  const all = await f.ok("volume", "volumePerMuscle", ["all"]);
  assert.deepEqual(all, {
    weekly_volume: [
      { week_start: "2026-08-03", muscle: "Leg", working_sets: 1 },
    ],
  });
  assert.deepEqual(
    (await f.ok("volume", "volumePerMuscle", ["current:hypertrophy"]))
      .weekly_volume,
    [{ week_start: "2026-08-03", muscle: "Leg", working_sets: 0.5 }],
  );
  assert.equal(
    (await f.call("volume", "volumePerMuscle", ["current"])).status,
    422,
  );
  assert.deepEqual(
    (await f.ok("volume", "volumePerMuscle", ["current:speed"])).weekly_volume,
    [],
  );
  assert.equal(
    (await f.call("volume", "dosePerExercise", ["all"])).status,
    422,
  );
  const after = await f.ok("volume", "volumePerMuscle", ["all"], {
    now: "2026-08-30T22:00:00Z",
  });
  assert.equal(after.weekly_volume.length, 2);
});

test("weekly delivery uses historical Sunday dose and retains removed membership, missing dose nulls and scaled units", async (t) => {
  const f = await summaryFixture(t);
  const lift = await f.ok("volume", "dosePerExercise", ["1"]);
  assert.equal(lift.weekly_exercise_sets[0].dose, 12);
  assert.equal(lift.weekly_exercise_sets[0].sets_done, 1);
  const run = await f.ok("volume", "dosePerExercise", ["2"]);
  assert.deepEqual(
    run.weekly_exercise_sets.map((r) => [
      r.week,
      r.dose,
      r.dose_unit,
      r.delivered,
    ]),
    [
      [1, 1.3, "km", 1.2345],
      [2, 10, "minutes", 2],
    ],
  );
  assert.equal(run.weekly_exercise_sets[1].distance_m, null);
  await f.sql("DELETE FROM mesocycle_exercises WHERE mesocycle_id = 2");
  assert.deepEqual(await f.ok("volume", "dosePerExercise", ["2"]), run);
  await session(f, "2026-08-12", [{ mesocycle_id: 2, reps: 1 }]);
  const missing = (
    await f.ok("volume", "dosePerExercise", ["2"])
  ).weekly_exercise_sets.find((r) => r.exercise_id === 1);
  assert.equal(missing.dose, null);
  assert.equal(missing.dose_unit, null);
  assert.equal(missing.delivered, null);
});

test("state scopes delivery to plan but staleness to exercise and preserves top sets and decisions", async (t) => {
  const f = await summaryFixture(t);
  await f.sql(
    `INSERT INTO mesocycle_decisions (mesocycle_id, made_at, what_changed, why) VALUES
    (1, '2026-08-29T12:00:00.123456Z', 'First', 'Synthetic'), (1, '2026-08-29T12:00:00.123456Z', 'Second', 'Synthetic')`,
  );
  const state = await f.ok("state", "trainingState");
  const lift = state.mesocycles.find((m) => m.id === 1);
  const run = state.mesocycles.find((m) => m.id === 2);
  assert.equal(lift.week, 4);
  assert.equal(lift.method_doc, "method/hypertrophy");
  assert.equal(run.method_doc, null);
  assert.match(run.method_note, /general knowledge/);
  assert.equal(lift.exercises[0].dose, 12);
  assert.equal(lift.exercises[0].sets_done, 2);
  assert.equal(lift.exercises[0].days_since_trained, 1);
  assert.equal(lift.exercises[0].delivered_this_week, 2);
  assert.equal(lift.this_week.sessions_done, 1);
  assert.equal(run.exercises[0].delivered_this_week, 1.5);
  assert.equal(lift.recent_decisions[0].what_changed, "Second");
  assert.equal(lift.recent_decisions[0].made_at, "2026-08-29T12:00:00.123Z");
  assert.deepEqual(lift.recent_weeks, [
    { week: 1, working_sets_done: 1, sessions_done: 1 },
    { week: 2, working_sets_done: 0, sessions_done: 0 },
    { week: 3, working_sets_done: 0, sessions_done: 0 },
  ]);
  assert.deepEqual(state.recent_sessions[0].exercises, []);
  const top = state.recent_sessions[1].exercises.find(
    (e) => e.exercise === "Squat",
  );
  assert.equal(top.working_sets, 2);
  assert.equal(top.top_weight_kg, 90);
  assert.equal(top.top_reps, 3);
  assert.equal(top.top_duration_s, null);
});

test("future plans preview start-day dose and pre-start performed sets keep historical cutoff", async (t) => {
  const f = await fixture(t);
  await f.exercise();
  await plans(f);
  await f.sql("UPDATE mesocycles SET started_on = '2026-08-31' WHERE id = 1");
  await f.sql(
    "INSERT INTO mesocycle_exercises (mesocycle_id, exercise_id, role, priority) VALUES (1, 1, 'main', 1)",
  );
  await f.sql(
    `INSERT INTO mesocycle_exercise_doses (mesocycle_id, exercise_id, weekly_dose, weekly_dose_unit, effective_from) VALUES
    (1, 1, ?, 'sets', '2026-08-31'), (1, 1, ?, 'sets', '2026-08-31')`,
    storedDose(9),
    storedDose(12),
  );
  const state = await f.ok("state", "trainingState", [], {
    now: "2026-08-23T12:00:00Z",
  });
  assert.equal(state.mesocycles[0].week, null);
  assert.equal((await f.ok("state", "trainingState")).mesocycles[0].week, 1);
  assert.equal(state.mesocycles[0].exercises[0].dose, 12);
  assert.deepEqual(state.mesocycles[0].recent_weeks, []);
  await session(f, "2026-08-30", [{ mesocycle_id: 1, reps: 1 }]);
  await session(f, "2026-08-31", [{ mesocycle_id: 1, reps: 1 }]);
  const dose = await f.ok("volume", "dosePerExercise", ["1"], {
    now: "2026-08-30T22:30:00Z",
  });
  assert.equal(dose.weekly_exercise_sets[0].week, 1);
  assert.equal(dose.weekly_exercise_sets[0].sets_done, 1);
});

test("concurrent registry creation leaves one owner and no partial alias list", async (t) => {
  const f = await fixture(t);
  const input = {
    name: "Concurrent",
    measure: "reps",
    stimulus_type: "strength",
    systemic_fatigue: "normal",
    aliases: ["Shared"],
  };
  const replies = await Promise.all([
    f.call("exercises", "addExercise", [input]),
    f.call("exercises", "addExercise", [{ ...input, name: "Competitor" }]),
  ]);
  assert.deepEqual(replies.map((r) => r.status).sort(), [200, 409]);
  assert.equal(await f.count("exercises"), 1);
  assert.equal(await f.count("exercise_aliases"), 1);
  const e = (await f.ok("exercises", "listExercises"))[0];
  const aliases = Array.from({ length: 1200 }, (_, n) => `Alias ${n}`);
  await f.ok("exerciseAliases", "addAliases", [e.id, aliases]);
  assert.equal(await f.count("exercise_aliases"), 1201);
  assert.equal(
    (
      await f.call("exerciseAliases", "addAliases", [
        e.id,
        ["Unsaved", "Shared"],
      ])
    ).status,
    409,
  );
  assert.equal(await f.count("exercise_aliases"), 1201);
});

test("a failing classification readback rolls back deletion and replacement together", async (t) => {
  const f = await fixture(t);
  await f.ok("exercises", "addMuscle", ["Leg"]);
  await f.exercise({ muscles: [{ muscle: "Leg", volume_factor: 1 }] });
  const failed = await f.call(
    "exercises",
    "reclassifyMuscles",
    ["Squat", [{ muscle: "Leg", volume_factor: 0.5 }]],
    { failReadback: true },
  );
  assert.equal(failed.status, 500);
  assert.deepEqual((await f.ok("exercises", "exerciseById", [1])).muscles, [
    { muscle: "Leg", volume_factor: 1 },
  ]);
  assert.equal(await f.count("api_write_assertions"), 0);
});
