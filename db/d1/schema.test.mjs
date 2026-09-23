import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { readdir, readFile } from "node:fs/promises";
import { localDatabase } from "./local.mjs";

let platform;
let db;
let storage;
before(async () => {
  platform = await localDatabase();
  db = platform.db;
  storage = JSON.parse(
    await readFile(new URL("./storage.json", import.meta.url), "utf8"),
  );
});
after(async () => {
  await platform?.dispose();
});

test("trigger delimiters remain compatible with hosted D1's case-sensitive parser", async () => {
  const directory = new URL("./migrations/", import.meta.url);
  for (
    const name of (await readdir(directory)).filter((name) =>
      name.endsWith(".sql")
    )
  ) {
    const sql = await readFile(new URL(name, directory), "utf8");
    // Local SQLite accepts lowercase delimiters, but hosted D1 rejects them
    // with `incomplete input: SQLITE_ERROR` before the migration can commit.
    for (const match of sql.matchAll(/^\s*(begin|end)\s*;?\s*$/gim)) {
      assert.equal(match[1], match[1].toUpperCase(), `${name}: ${match[1]}`);
    }
  }
});

test("the migration creates the complete declared table inventory and all seven views on local D1", async () => {
  const catalog = await db.prepare(
    "SELECT name, type FROM sqlite_schema WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' AND name <> '_cf_METADATA'",
  ).all();
  const tables = catalog.results.filter((item) => item.type === "table").map((
    item,
  ) => item.name).sort();
  assert.deepEqual(tables, Object.keys(storage.tables).sort());
  assert.equal(tables.length, 27);
  const tableOptions = (await db.prepare("PRAGMA table_list").all()).results;
  for (const name of tables) {
    assert.equal(
      tableOptions.find((entry) => entry.name === name).strict,
      1,
      name,
    );
  }
  const views = catalog.results.filter((item) => item.type === "view").map((
    item,
  ) => item.name).sort();
  assert.deepEqual(views, [
    "daily_bodyweight",
    "daily_intake",
    "intake_values",
    "nutrition_effective_events",
    "nutrition_goal_switches",
    "weekly_exercise_sets_done",
    "weekly_volume",
  ]);
  for (const view of views) {
    await db.prepare(`SELECT * FROM "${view}" LIMIT 1`).all();
  }
  for (const [table, spec] of Object.entries(storage.tables)) {
    const { results } = await db.prepare(`PRAGMA table_info("${table}")`).all();
    for (const column of Object.keys(spec.decimals)) {
      assert.equal(
        results.find((entry) => entry.name === column)?.type,
        "INTEGER",
        `${table}.${column}`,
      );
    }
  }
});

test("bodyweight preserves microseconds, Rome days, numeric bounds, and earliest-ID ties", async () => {
  const insert =
    "INSERT INTO bodyweight (value_kg, measured_at, measured_date, source) VALUES (?, ?, ?, ?)";
  const instant = "2026-07-01T22:30:00.123456Z";
  await db.prepare(insert).bind(8235, instant, "2026-07-02", "manual").run();
  await db.prepare(insert).bind(8400, instant, "2026-07-02", "withings").run();
  const row = await db.prepare(
    "SELECT * FROM daily_bodyweight WHERE day = '2026-07-02'",
  ).first();
  assert.equal(row.value_kg, 82.35);
  assert.equal(row.measured_at, instant);
  await assert.rejects(
    db.prepare(insert).bind(8235, instant, "2026-07-02", "manual").run(),
  );
  await assert.rejects(
    db.prepare(insert).bind(
      100000,
      "2026-07-02T10:00:00.000000Z",
      "2026-07-02",
      "manual",
    ).run(),
  );
  await assert.rejects(
    db.prepare(insert).bind(
      0,
      "2026-07-02T10:00:00.000000Z",
      "2026-07-02",
      "manual",
    ).run(),
  );
});

test("case-insensitive keys enforce Unicode duplicates without conflating accents", async () => {
  await db.prepare(
    "INSERT INTO exercises (name, name_key) VALUES ('CAFFÈ', 'caffè')",
  ).run();
  await assert.rejects(
    db.prepare(
      "INSERT INTO exercises (name, name_key) VALUES ('caffè', 'caffè')",
    ).run(),
  );
  await db.prepare(
    "INSERT INTO exercises (name, name_key) VALUES ('caffe', 'caffe')",
  ).run();
});

test("foreign keys reject missing references and deleting history", async () => {
  await assert.rejects(
    db.prepare(
      "INSERT INTO exercise_aliases (exercise_id, alias, alias_key) VALUES (99999, 'missing', 'missing')",
    ).run(),
  );
  const exercise = await db.prepare(
    "SELECT id FROM exercises WHERE name_key = 'caffè'",
  ).first();
  await db.prepare(
    "INSERT INTO exercise_aliases (exercise_id, alias, alias_key) VALUES (?, 'alias', 'alias')",
  ).bind(exercise.id).run();
  await db.prepare(
    "INSERT INTO sessions (date, rationale) VALUES ('2020-01-06', 'Synthetic record')",
  ).run();
  const session = await db.prepare(
    "SELECT id FROM sessions ORDER BY id DESC LIMIT 1",
  ).first();
  await db.prepare(
    "INSERT INTO sets (session_id, exercise_id, position, kind, reps, effort) VALUES (?, ?, 1, 'working', 5, 'hard')",
  ).bind(session.id, exercise.id).run();
  await assert.rejects(
    db.prepare("DELETE FROM exercises WHERE id = ?").bind(exercise.id).run(),
  );
  assert.equal(
    (await db.prepare("SELECT COUNT(*) AS n FROM sets WHERE session_id = ?")
      .bind(session.id).first()).n,
    1,
  );
  assert.equal(
    (await db.prepare("PRAGMA foreign_key_check").all()).results.length,
    0,
  );
});

test("request uniqueness distinguishes ad-hoc entries from different foods in one meal", async () => {
  const request = "00000000-0000-0000-0000-000000000001";
  const adhoc = db.prepare(
    "INSERT INTO intake_entries (day, kcal, request_id) VALUES ('2020-01-06', 1000, ?)",
  );
  await adhoc.bind(request).run();
  await assert.rejects(adhoc.bind(request).run());
  const shared = "00000000-0000-0000-0000-000000000002";
  for (const name of ["first food", "second food"]) {
    const food = await db.prepare(
      "INSERT INTO foods (name, name_key, kcal_100g, protein_100g, carbs_100g, fat_100g, source) VALUES (?, ?, 1000, 100, 100, 0, 'label') RETURNING id",
    ).bind(name, name).first();
    const entry = db.prepare(
      "INSERT INTO intake_entries (day, food_id, grams, request_id) VALUES ('2020-01-06', ?, 1000, ?)",
    ).bind(food.id, shared);
    await entry.run();
    await assert.rejects(entry.run());
  }
  assert.equal(
    (await db.prepare(
      "SELECT COUNT(*) AS n FROM intake_entries WHERE request_id = ?",
    ).bind(shared).first()).n,
    2,
  );
});

test("JSON clipping reasons enforce array shape and allowed membership on local D1", async () => {
  const insert = db.prepare(
    "INSERT INTO nutrition_targets (effective_from, goal, rate_pct_bw_week, kcal_target, protein_g_target, decision, clipped, clipped_reasons) VALUES ('2020-01-06', 'cut', -50, 2200, 160, 'Synthetic decision', 1, ?)",
  );
  await insert.bind('["rate","deficit"]').run();
  for (
    const reasons of [
      '["unknown"]',
      "[42]",
      '[["rate"]]',
      "{}",
      "null",
      "invalid",
    ]
  ) {
    await assert.rejects(insert.bind(reasons).run());
  }
  await assert.rejects(
    db.prepare("UPDATE nutrition_targets SET clipped_reasons = '[\"unknown\"]'")
      .run(),
  );
});

test("identity allocation preserves a high-water mark even after deleting the largest record", async () => {
  await db.prepare("INSERT INTO users (name) VALUES ('synthetic discarded ID')")
    .run();
  await db.prepare("DELETE FROM users").run();
  await db.prepare("UPDATE sqlite_sequence SET seq = 500 WHERE name = 'users'")
    .run();
  const created = await db.prepare(
    "INSERT INTO users (name) VALUES ('synthetic next ID') RETURNING id",
  ).first();
  assert.equal(created.id, 501);
});
