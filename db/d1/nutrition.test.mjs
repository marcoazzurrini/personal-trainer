import assert from "node:assert/strict";
import { before, test } from "node:test";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { build } from "esbuild";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { migrationStatements } from "./local.mjs";

let script;
let migrations;
before(async () => {
  const compiled = await build({
    entryPoints: [
      fileURLToPath(new URL("./nutrition.test.worker.ts", import.meta.url)),
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
    "The Worker persistence bundle must not load the PostgreSQL client or its environment reader.",
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
  // Wrangler's pinned Miniflare currently supplies this option adapter too.
  const options = convertV4MiniflareOptions({
    modules: true,
    script,
    compatibilityDate: "2026-08-03",
    d1Databases: { DB: `synthetic-api-${randomUUID()}` },
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
  async function call(store, method, args = [], options = {}) {
    const response = await mf.dispatchFetch("http://local.invalid/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ store, method, args, ...options }),
    });
    return { status: response.status, body: await response.json() };
  }
  async function ok(store, method, args = [], options = {}) {
    const result = await call(store, method, args, options);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    return result.body;
  }
  async function food(name = "Rice", extra = {}) {
    return (
      await ok("foods", "saveFood", [
        {
          name,
          kcal_100g: 360,
          protein_100g: 0,
          carbs_100g: 90,
          fat_100g: 0,
          source: "label",
          request_id: randomUUID(),
          ...extra,
        },
      ])
    ).row;
  }
  async function count(table) {
    assert.match(table, /^[a-z_]+$/);
    return (await db.prepare(`SELECT count(*) AS n FROM ${table}`).first()).n;
  }
  return { db, call, ok, food, count };
}

const targetInput = (extra = {}) => ({
  goal: "maintain",
  rate_pct_bw_week: 0,
  kcal_target: 2200,
  protein_g_target: 150,
  decision: "Synthetic plan",
  request_id: randomUUID(),
  ...extra,
});
async function weighIn(f) {
  await f.db
    .prepare(
      "INSERT INTO bodyweight (value_kg, measured_at, measured_date, source) VALUES (8000, '2026-08-20T10:00:00.000000Z', '2026-08-20', 'synthetic')",
    )
    .run();
}

test("foods: decimal ties, aliases, UUID retries, live corrections and deletion restrictions", async (t) => {
  const f = await fixture(t);
  const uuid = randomUUID();
  const rice = await f.food("Rìce", {
    aliases: ["RISO", "grain"],
    grams_per_unit: 1.5,
    request_id: uuid.toUpperCase(),
  });
  assert.deepEqual(rice.aliases, ["RISO", "grain"]);
  assert.equal(
    (await f.ok("foods", "saveFood", [{ request_id: uuid }])).created,
    false,
  );
  assert.equal((await f.ok("foods", "foodByRef", ["riso"])).id, rice.id);
  assert.equal((await f.ok("foods", "searchFoods", ["RÌ"])).length, 1);
  const intake = await f.ok("intake", "logIntake", [
    { food: rice.id, units: 1, request_id: randomUUID() },
  ]);
  assert.equal(intake.view.entries[0].carbs_g, 1.4);
  const id = intake.view.entries[0].id;
  await f.ok("intake", "correctEntry", [id, { kcal: 50 }]);
  const unchanged = await f.ok("foods", "correctFood", [
    String(rice.id),
    { kcal_100g: 360.01 },
  ]);
  assert.equal(unchanged.corrected_entries.count, 0);
  assert.equal((await f.ok("intake", "viewDay")).entries[0].kcal, 50);
  const changed = await f.ok("foods", "correctFood", [
    String(rice.id),
    { kcal_100g: 400, carbs_100g: 100 },
  ]);
  assert.equal(changed.corrected_entries.count, 1);
  assert.equal((await f.ok("intake", "viewDay")).entries[0].kcal, 6);
  assert.equal(
    (await f.call("foods", "deleteFood", [String(rice.id)])).status,
    409,
  );
  await f.ok("intake", "removeEntry", [id]);
  assert.equal(await f.ok("foods", "deleteFood", [String(rice.id)]), "Rìce");
  assert.equal(await f.count("food_aliases"), 0);
  assert.equal(await f.count("nutrition_write_assertions"), 0);
});

test("food corrections validate complete labels and roll back alias failures", async (t) => {
  const f = await fixture(t);
  const rice = await f.food("Rice", { aliases: ["taken"] });
  assert.equal(
    (
      await f.call("foods", "saveFood", [
        {
          name: "Other",
          kcal_100g: 360,
          protein_100g: 0,
          carbs_100g: 90,
          fat_100g: 0,
          source: "label",
          aliases: ["new", "NEW"],
          request_id: randomUUID(),
        },
      ])
    ).status,
    409,
  );
  assert.equal(await f.count("foods"), 1);
  assert.equal(await f.count("food_aliases"), 1);
  assert.equal(
    (
      await f.call("foods", "correctFood", [
        String(rice.id),
        { carbs_100g: 200 },
      ])
    ).status,
    422,
  );
  assert.equal(
    (
      await f.call("foods", "correctFood", [
        String(rice.id),
        { kcal_100g: null },
      ])
    ).status,
    422,
  );
  assert.equal((await f.ok("foods", "foodById", [rice.id])).carbs_100g, 90);
});

test("meals: atomic replacement, historical ingredients, large JSON lists and replay", async (t) => {
  const f = await fixture(t);
  const rice = await f.food();
  const other = await f.food("Other");
  const uuid = randomUUID();
  const aliases = Array.from({ length: 180 }, (_, i) => `Meal alias ${i}`);
  const meal = (
    await f.ok("meals", "saveMeal", [
      {
        name: "Lunch",
        items: [{ food: "Rice", grams: 10 }],
        aliases,
        request_id: uuid,
      },
    ])
  ).meal;
  assert.equal(meal.aliases.length, 180);
  assert.equal(
    (await f.ok("meals", "saveMeal", [{ request_id: uuid.toUpperCase() }]))
      .created,
    false,
  );
  assert.equal((await f.ok("meals", "mealByRef", [aliases[0]])).id, meal.id);
  assert.equal((await f.ok("meals", "listMeals"))[0].items, 1);
  const logged = await f.ok("intake", "logIntake", [
    { meal: "Lunch", scale: 0.5, request_id: randomUUID() },
  ]);
  assert.equal(logged.view.entries[0].grams, 5);
  const failed = await f.call("meals", "editMeal", [
    String(meal.id),
    {
      name: "Bad",
      items: [
        { food: rice.id, grams: 20 },
        { food: rice.id, grams: 30 },
      ],
    },
  ]);
  assert.equal(failed.status, 409);
  assert.equal((await f.ok("meals", "mealDetail", [meal.id])).name, "Lunch");
  await f.ok("meals", "editMeal", [
    String(meal.id),
    { items: [{ food: other.id, grams: 30 }] },
  ]);
  assert.equal((await f.ok("intake", "viewDay")).entries[0].food_id, rice.id);
  assert.equal(
    (await f.ok("meals", "mealDetail", [meal.id])).items[0].food_id,
    other.id,
  );
  await f.ok("meals", "editMeal", [String(meal.id), { items: [] }]);
  assert.equal(
    (
      await f.call("intake", "logIntake", [
        { meal: meal.id, request_id: randomUUID() },
      ])
    ).status,
    422,
  );
  assert.equal(await f.count("nutrition_write_assertions"), 0);
});

test("intake: override composition, quantity reset, moves, gaps, flags, defaults, refusal", async (t) => {
  const f = await fixture(t);
  const rice = await f.food();
  const initial = await f.ok("intake", "logIntake", [
    { food: rice.id, grams: 10, request_id: randomUUID() },
  ]);
  const id = initial.view.entries[0].id;
  await f.ok("intake", "correctEntry", [id, { kcal: 100 }]);
  let view = (await f.ok("intake", "correctEntry", [id, { protein_g: 20 }]))
    .view;
  assert.equal(view.entries[0].kcal, 100);
  assert.equal(view.entries[0].protein_g, 20);
  assert.equal(view.entries[0].carbs_g, 9);
  view = (await f.ok("intake", "correctEntry", [id, { grams: 20 }])).view;
  assert.equal(view.entries[0].kcal, 72);
  assert.equal(view.entries[0].protein_g, 0);
  assert.equal(
    (await f.call("intake", "correctEntry", [id, { grams: 30, kcal: 10 }]))
      .status,
    422,
  );
  const moved = await f.ok("intake", "correctEntry", [
    id,
    { day: "2026-08-23", note: "Fixed" },
  ]);
  assert.equal(moved.movedFrom, "2026-08-24");
  assert.equal(moved.view.day, "2026-08-23");
  const uuid = randomUUID();
  view = (
    await f.ok("intake", "logIntake", [
      { adhoc_kcal: 100.05, request_id: uuid },
    ])
  ).view;
  assert.equal(view.totals.kcal, 100.1);
  assert.deepEqual(view.totals.unaccounted.protein_g, {
    entries: 1,
    kcal: 100.1,
  });
  assert.equal(
    (
      await f.ok("intake", "logIntake", [
        { request_id: uuid.toUpperCase(), day: "2999-01-01" },
      ])
    ).created,
    false,
  );
  assert.equal(
    (
      await f.call("intake", "logIntake", [
        { adhoc_kcal: 20, day: "2026-08-25", request_id: randomUUID() },
      ])
    ).status,
    422,
  );
  assert.deepEqual(
    (await f.ok("intake", "flagDay", ["2026-08-24", "incomplete"])).flags,
    ["incomplete"],
  );
  await f.ok("intake", "flagDay", ["2026-08-24", "incomplete"]);
  assert.deepEqual(
    (await f.ok("intake", "unflagDay", ["2026-08-24", "incomplete"])).flags,
    [],
  );
  assert.equal(
    (await f.call("intake", "unflagDay", ["2026-08-24", "incomplete"])).status,
    404,
  );
  assert.equal(
    (await f.ok("intake", "viewDay", [], { now: "2026-08-24T22:30:00Z" })).day,
    "2026-08-25",
  );
});

test("concurrent UUID intake calls cannot append different foods to one request", async (t) => {
  const f = await fixture(t);
  const a = await f.food("A"),
    b = await f.food("B");
  const uuid = randomUUID();
  const results = await Promise.all(
    [a, b].map((food) =>
      f.ok("intake", "logIntake", [
        { food: food.id, grams: 10, request_id: uuid },
      ])
    ),
  );
  assert.deepEqual(results.map((r) => r.created).sort(), [false, true]);
  assert.equal(await f.count("intake_entries"), 1);
});

test("targets and events: history winners, atomic switch flag, suppression, UUID replay and protein", async (t) => {
  const f = await fixture(t);
  assert.equal(
    (await f.call("targets", "setTarget", [targetInput()])).status,
    422,
  );
  await weighIn(f);
  const first = await f.ok("targets", "setTarget", [
    targetInput({ effective_from: "2026-08-01" }),
  ]);
  assert.equal(first.body.phase_switch_registered, false);
  const uuid = randomUUID();
  const cut = await f.ok("targets", "setTarget", [
    targetInput({
      effective_from: "2026-08-10",
      goal: "cut",
      rate_pct_bw_week: -0.5,
      request_id: uuid,
    }),
  ]);
  assert.equal(cut.body.phase_switch_registered, true);
  assert.equal(cut.body.target.rate_pct_bw_week, -0.5);
  assert.equal(cut.body.target.clipped, false);
  assert.deepEqual(cut.body.target.clipped_reasons, []);
  const replay = await f.ok("targets", "setTarget", [
    { request_id: uuid.toUpperCase() },
  ]);
  assert.deepEqual(Object.keys(replay.body), ["target"]);
  assert.equal(replay.created, false);
  const event = (await f.ok("events", "listEvents"))[0];
  assert.equal(event.id, -cut.body.target.id);
  assert.equal(event.note, "maintain -> cut");
  assert.equal(
    (await f.ok("events", "activeTransients", ["2026-08-24"])).length,
    1,
  );
  assert.equal(
    (await f.ok("events", "activeTransients", ["2026-08-25"])).length,
    0,
  );
  const withdrawn = await f.ok("events", "withdrawEvent", [event.id]);
  assert.equal(withdrawn.note, event.note);
  assert.equal(
    (await f.call("events", "withdrawEvent", [event.id])).status,
    404,
  );
  assert.equal(
    (await f.ok("targets", "activeTarget", ["2026-08-10"])).id,
    cut.body.target.id,
  );
  const sameDay = await f.ok("targets", "setTarget", [
    targetInput({
      effective_from: "2026-08-10",
      protein_g_target: null,
      protein_g_per_kg_bw: 2,
    }),
  ]);
  assert.equal(sameDay.body.protein_computation.protein_g_target, 160);
  assert.equal(sameDay.body.phase_switch_registered, false);
  assert.equal(
    (await f.ok("targets", "listTargets"))[0].id,
    sameDay.body.target.id,
  );
  assert.equal(
    (await f.ok("read", "activeTarget", ["2026-08-10"])).id,
    sameDay.body.target.id,
  );
  const manual = await f.ok("events", "registerEvent", [
    { kind: "other", request_id: randomUUID() },
  ]);
  assert.equal(manual.created, true);
  await f.ok("events", "withdrawEvent", [manual.row.id]);
  assert.equal((await f.ok("events", "listEvents")).length, 0);
});

test("analytical reader excludes incomplete intake and reports insufficient data", async (t) => {
  const f = await fixture(t);
  const result = await f.ok("read", "currentExpenditure", [[]]);
  assert.equal(result.status, "insufficient_data");
  assert.equal(result.as_of, null);
  assert.equal(result.tdee_kcal, null);
  const slope = await f.ok("read", "slopePctBwWeek", [
    [
      { day: "2026-08-01", trend_kg: 80 },
      { day: "2026-08-08", trend_kg: 81 },
    ],
    7,
  ]);
  assert.equal(slope.kg_per_week, 1);
});

test("meal portions preserve the public Math.round operation order at fractional ties", async (t) => {
  const f = await fixture(t);
  const food = await f.food();
  for (
    const [grams, scale] of [
      [0.3, 4.5],
      [0.7, 1.5],
      [2.5, 0.58],
      [1.5, 1],
    ]
  ) {
    const meal = (
      await f.ok("meals", "saveMeal", [
        {
          name: `Portion ${grams}`,
          items: [{ food: food.id, grams }],
          request_id: randomUUID(),
        },
      ])
    ).meal;
    const result = await f.ok("intake", "logIntake", [
      { meal: meal.id, scale, request_id: randomUUID() },
    ]);
    const entry = result.view.entries.find((e) => e.meal_id === meal.id);
    assert.equal(
      entry.grams,
      Math.round(grams * scale * 10) / 10,
      `${grams} at ${scale}`,
    );
  }
});

test("complete analytical history computes clipped targets, protein and stale windows", async (t) => {
  const f = await fixture(t);
  const trend = [];
  const writes = [];
  for (let i = 0; i < 35; i++) {
    const day = new Date(Date.UTC(2026, 6, 20 + i)).toISOString().slice(0, 10);
    trend.push({ day, trend_kg: 80, value_kg: 80, interpolated: false });
    writes.push(
      f.db
        .prepare("INSERT INTO intake_entries (day, kcal) VALUES (?, 22000)")
        .bind(day),
    );
    writes.push(
      f.db
        .prepare(
          "INSERT INTO bodyweight (value_kg, measured_at, measured_date, source) VALUES (8000, ?, ?, 'synthetic')",
        )
        .bind(day + "T10:00:00.000000Z", day),
    );
  }
  writes.push(
    f.db.prepare(
      "INSERT INTO bodyfat_estimates (day, percent, method) VALUES ('2026-08-20', 300, 'visual')",
    ),
  );
  await f.db.batch(writes);
  const expenditure = await f.ok("read", "currentExpenditure", [trend]);
  assert.equal(expenditure.status, "ok");
  assert.equal(expenditure.as_of, "2026-08-23");
  assert.equal(expenditure.tdee_kcal, 2200);
  const computed = await f.ok("targets", "setTarget", [
    targetInput({
      goal: "cut",
      rate_pct_bw_week: -2,
      kcal_target: null,
      protein_g_target: null,
      protein_g_per_kg_ffm: 2.5,
    }),
  ]);
  assert.equal(computed.body.target.kcal_target, 1700);
  assert.equal(computed.body.target.protein_g_target, 140);
  assert.equal(computed.body.target.clipped, true);
  assert.ok(computed.body.target.clipped_reasons.includes("rate"));
  assert.ok(computed.body.target.clipped_reasons.includes("deficit"));
  assert.equal(computed.body.computation.tdee_kcal, 2200);
  assert.equal(computed.body.target.tdee_at_creation, 2200);
  await f.db.batch(
    Array.from({ length: 8 }, (_, i) =>
      f.db
        .prepare("INSERT INTO day_flags (day, flag) VALUES (?, 'incomplete')")
        .bind(`2026-08-${16 + i}`)),
  );
  const stale = await f.ok("read", "currentExpenditure", [trend]);
  assert.equal(stale.status, "stale");
  assert.equal(stale.as_of, "2026-08-16");
  assert.equal(stale.tdee_kcal, 2200);
});

test("large recipes resolve and write without the D1 parameter ceiling", async (t) => {
  const f = await fixture(t);
  const foods = Array.from({ length: 160 }, (_, i) => ({
    name: `Ingredient ${i}`,
    key: `ingredient ${i}`,
  }));
  await f.db
    .prepare(
      `INSERT INTO foods (name, name_key, kcal_100g, protein_100g, carbs_100g, fat_100g, source)
    SELECT json_extract(value, '$.name'), json_extract(value, '$.key'), 3600, 0, 900, 0, 'label' FROM json_each(?)`,
    )
    .bind(JSON.stringify(foods))
    .run();
  const saved = await f.ok("meals", "saveMeal", [
    {
      name: "Large",
      items: foods.map((food) => ({ food: food.name, grams: 1 })),
      request_id: randomUUID(),
    },
  ]);
  assert.equal(saved.meal.items.length, 160);
  const logged = await f.ok("intake", "logIntake", [
    { meal: saved.meal.id, request_id: randomUUID() },
  ]);
  assert.equal(logged.view.entries.length, 160);
  assert.equal(logged.view.totals.kcal, 576);
});
