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
    entryPoints: [fileURLToPath(new URL("./test.worker.ts", import.meta.url))],
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
  const files = (await readdir(directory)).filter((name) =>
    name.endsWith(".sql")
  ).sort();
  migrations = migrationStatements(
    (await Promise.all(
      files.map((name) => readFile(new URL(name, directory), "utf8")),
    )).join("\n"),
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
  await db.prepare(
    `INSERT INTO exercises (id, name, name_key, measure, stimulus_type) VALUES
    (1, 'Squat', 'squat', 'load_reps', 'strength'),
    (2, 'Sprint', 'sprint', 'distance_duration', 'power'),
    (3, 'Pushup', 'pushup', 'reps', 'strength')`,
  ).run();
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
  async function session(sets = [planned()], options = {}) {
    return (await ok("sessions", "writeSession", [{
      date: "2026-08-10",
      rationale: "Synthetic session",
      sets,
      request_id: randomUUID(),
      ...options,
    }])).session;
  }
  async function count(table) {
    assert.match(table, /^[a-z_]+$/);
    return (await db.prepare(`SELECT count(*) AS n FROM ${table}`).first()).n;
  }
  async function state(id) {
    return {
      header: await db.prepare("SELECT * FROM sessions WHERE id = ?").bind(id)
        .first(),
      sets: (await db.prepare(
        "SELECT * FROM sets WHERE session_id = ? ORDER BY position",
      ).bind(id).all()).results,
    };
  }
  return { db, call, ok, session, count, state };
}
const planned = (extra = {}) => ({
  exercise: 1,
  kind: "working",
  target_weight_kg: 82.345,
  target_reps: 5,
  ...extra,
});
const actual = (extra = {}) => ({
  exercise: 1,
  kind: "working",
  weight_kg: 80,
  reps: 5,
  effort: "hard",
  ...extra,
});

const planEntry = (exercise = 1, extra = {}) => ({
  exercise,
  role: "main",
  priority: 1,
  weekly_dose: 9,
  weekly_dose_unit: "sets",
  ...extra,
});
async function plan(f, extra = {}) {
  const block = await f.ok("blocks", "openBlock", [{
    name: "Synthetic block",
    goal: "strength",
    started_on: "2026-08-03",
    request_id: randomUUID(),
  }]);
  return (await f.ok("plans", "createMesocycle", [{
    block_id: block.row.id,
    name: "Synthetic plan",
    track: "strength",
    intent: "Original intent",
    started_on: "2026-08-03",
    planned_weeks: 6,
    sessions_per_week: 3,
    exercises: [planEntry()],
    request_id: randomUUID(),
    ...extra,
  }])).mesocycle;
}
const decision = (extra = {}) => ({
  what_changed: "Synthetic change",
  why: "Synthetic reason",
  request_id: randomUUID(),
  ...extra,
});

test("D1 blocks and append-only context preserve UUID replay, full history and timestamp/id winners", async (t) => {
  const f = await fixture(t);
  const uuid = randomUUID();
  const input = {
    name: "Block",
    goal: "strength",
    started_on: "2026-08-03",
    request_id: uuid,
  };
  const blocks = await Promise.all([
    f.ok("blocks", "openBlock", [input]),
    f.ok("blocks", "openBlock", [input]),
  ]);
  assert.equal(blocks.filter((b) => b.created).length, 1);
  assert.deepEqual(blocks[0].row, blocks[1].row);
  assert.equal(
    (await f.ok("blocks", "openBlock", [{
      ...input,
      request_id: uuid.toUpperCase(),
      started_on: "bad",
    }])).created,
    false,
  );
  assert.equal((await f.ok("blocks", "listBlocks")).length, 1);
  assert.equal(
    (await f.call("blocks", "openBlock", [{
      ...input,
      ended_on: "2026-08-01",
      request_id: randomUUID(),
    }])).status,
    422,
  );
  const original = {
    topic: "sleep",
    content: "Original",
    request_id: randomUUID(),
  };
  const first = await f.ok("context", "appendContext", [original]);
  const second = await f.ok("context", "appendContext", [{
    ...original,
    content: "Corrected",
    request_id: randomUUID(),
  }]);
  const other = await f.ok("context", "appendContext", [{
    topic: "equipment",
    content: "Rack",
    request_id: randomUUID(),
  }]);
  const older = await f.ok("context", "appendContext", [{
    ...original,
    content: "Earlier",
    request_id: randomUUID(),
  }], { now: "2026-08-29T12:00:00Z" });
  assert.deepEqual(await f.ok("context", "currentContext"), [
    other.row,
    second.row,
  ]);
  assert.deepEqual(await f.ok("context", "contextHistory"), [
    older.row,
    first.row,
    second.row,
    other.row,
  ]);
  assert.deepEqual(
    (await f.ok("context", "appendContext", [{
      ...original,
      content: "Ignored retry",
    }])).row,
    first.row,
  );
  assert.equal(await f.count("user_context"), 4);
});

test("D1 schedules use Rome Mondays across DST and retain the weekend warning", async (t) => {
  const f = await fixture(t);
  const sunday = await f.ok("schedule", "writeWeekSchedule", [{
    schedule: "Current week",
  }], { now: "2026-03-29T12:00:00Z" });
  assert.equal(sunday.row.week_start, "2026-03-23");
  assert.equal(sunday.row.week_end, "2026-03-29");
  assert.match(sunday.note, /2026-03-30/);
  const monday = await f.ok("schedule", "writeWeekSchedule", [{
    schedule: "New week",
  }], { now: "2026-03-29T22:30:00Z" });
  assert.equal(monday.row.week_start, "2026-03-30");
  assert.equal(monday.note, null);
  const replacement = await f.ok("schedule", "writeWeekSchedule", [{
    week_start: "2026-03-30",
    schedule: "Updated",
  }]);
  assert.equal(replacement.row.schedule, "Updated");
  assert.equal(replacement.note, null);
  const winter = await f.ok("schedule", "writeWeekSchedule", [{
    schedule: "Winter",
  }], { now: "2026-10-25T23:30:00Z" });
  assert.equal(winter.row.week_start, "2026-10-26");
  assert.equal(
    (await f.call("schedule", "writeWeekSchedule", [{
      week_start: "2026-03-31",
      schedule: "Not Monday",
    }])).status,
    422,
  );
  assert.equal(await f.count("week_schedules"), 3);
});

test("D1 plans read the dose history, including future starts, redoses, removals and readdition", async (t) => {
  const f = await fixture(t);
  const p = await plan(f, { started_on: "2026-09-14" });
  assert.equal(p.week, null);
  assert.equal(p.exercises[0].weekly_dose, 9);
  const changed = await f.ok("plans", "recordDecision", [
    String(p.id),
    decision({
      intent: "Replaced intent",
      redose: [{
        exercise: "Squat",
        weekly_dose: 12.345,
        weekly_dose_unit: "sets",
      }],
    }),
  ]);
  assert.equal(changed.mesocycle.exercises[0].weekly_dose, 12.3);
  assert.equal(changed.mesocycle.intent, "Replaced intent");
  assert.deepEqual(
    (await f.db.prepare(
      "SELECT effective_from, weekly_dose FROM mesocycle_exercise_doses ORDER BY id",
    ).all()).results,
    [{ effective_from: "2026-09-14", weekly_dose: storedDose(9) }, {
      effective_from: "2026-09-14",
      weekly_dose: storedDose(12.345),
    }],
  );
  assert.equal(
    (await f.ok("plans", "decisionLog", [String(p.id)])).decisions[0]
      .prior_intent,
    "Original intent",
  );
  const held = await f.ok("plans", "recordDecision", [
    String(p.id),
    decision(),
  ]);
  assert.equal(held.created, true);
  assert.equal(await f.count("mesocycle_exercise_doses"), 2);
  const removed = await f.ok("plans", "recordDecision", [
    String(p.id),
    decision({ remove: [1] }),
  ]);
  assert.deepEqual(removed.mesocycle.exercises, []);
  assert.equal(await f.count("mesocycle_exercise_doses"), 2);
  const refused = await f.call("plans", "recordDecision", [
    String(p.id),
    decision({
      redose: [{ exercise: 1, weekly_dose: 10, weekly_dose_unit: "sets" }],
    }),
  ]);
  assert.equal(refused.status, 422);
  assert.match(refused.body.error, /not in this mesocycle's plan/);
  const restored = await f.ok("plans", "recordDecision", [
    String(p.id),
    decision({ add: [planEntry(1, { weekly_dose: 15 })] }),
  ]);
  assert.equal(restored.mesocycle.exercises[0].weekly_dose, 15);
  assert.notEqual(restored.mesocycle.exercises[0].id, p.exercises[0].id);
  assert.equal(await f.count("mesocycle_exercise_doses"), 3);
  assert.equal(await f.count("api_write_assertions"), 0);
});

test("D1 decisions replay the original row with the current plan and refuse cross-plan UUID reuse", async (t) => {
  const f = await fixture(t);
  const p = await plan(f);
  const input = decision({
    redose: [{ exercise: 1, weekly_dose: 10, weekly_dose_unit: "sets" }],
  });
  const first = await f.ok("plans", "recordDecision", [String(p.id), input]);
  await f.ok("plans", "recordDecision", [
    String(p.id),
    decision({ intent: "Later intent" }),
  ]);
  const retry = await f.ok("plans", "recordDecision", [String(p.id), {
    ...input,
    request_id: input.request_id.toUpperCase(),
    weekly_sets: "ignored on replay",
  }]);
  assert.equal(retry.created, false);
  assert.deepEqual(retry.decision, first.decision);
  assert.equal(retry.mesocycle.intent, "Later intent");
  const other = await plan(f, { track: "hypertrophy" });
  const rejected = await f.call("plans", "recordDecision", [
    String(other.id),
    input,
  ]);
  assert.equal(rejected.status, 409);
  assert.equal(
    (await f.ok("plans", "decisionLog", [String(other.id)])).decisions.length,
    0,
  );
  assert.equal(
    (await f.ok("plans", "mesocycleDetail", [other.id])).exercises[0]
      .weekly_dose,
    9,
  );
});

test("D1 decisions serialize simultaneous intent replacements and duplicate request ids", async (t) => {
  const f = await fixture(t);
  const p = await plan(f);
  const input = decision({ intent: "Once", add: [planEntry(3)] });
  const duplicates = await Promise.all([
    f.ok("plans", "recordDecision", [String(p.id), input]),
    f.ok("plans", "recordDecision", [String(p.id), input]),
  ]);
  assert.equal(duplicates.filter((d) => d.created).length, 1);
  assert.equal(await f.count("mesocycle_decisions"), 1);
  assert.equal(await f.count("mesocycle_exercises"), 2);
  await Promise.all([
    f.ok("plans", "recordDecision", [String(p.id), decision({ intent: "A" })]),
    f.ok("plans", "recordDecision", [String(p.id), decision({ intent: "B" })]),
  ]);
  const log = (await f.ok("plans", "decisionLog", [String(p.id)])).decisions;
  assert.equal(log[1].prior_intent, "Once");
  const current = (await f.ok("plans", "mesocycleDetail", [p.id])).intent;
  assert.equal(log[2].prior_intent, current === "A" ? "B" : "A");
  assert.equal(await f.count("api_write_assertions"), 0);
});

test("D1 plan creation rolls back duplicate membership and readback failures; concurrent replay creates once", async (t) => {
  const f = await fixture(t);
  const block = (await f.ok("blocks", "openBlock", [{
    name: "B",
    goal: "strength",
    started_on: "2026-08-03",
    request_id: randomUUID(),
  }])).row;
  const input = {
    block_id: block.id,
    name: "Plan",
    track: "strength",
    intent: "Intent",
    started_on: "2026-08-03",
    planned_weeks: 4,
    sessions_per_week: 3,
    exercises: [planEntry()],
    request_id: randomUUID(),
  };
  const invalid = await f.call("plans", "createMesocycle", [{
    ...input,
    exercises: [planEntry(), planEntry()],
  }]);
  assert.equal(invalid.status, 409);
  assert.equal(await f.count("mesocycles"), 0);
  assert.equal(await f.count("mesocycle_exercise_doses"), 0);
  assert.equal(
    (await f.call("plans", "createMesocycle", [input], { failReadback: true }))
      .status,
    500,
  );
  assert.equal(await f.count("mesocycles"), 0);
  const replies = await Promise.all([
    f.ok("plans", "createMesocycle", [input]),
    f.ok("plans", "createMesocycle", [input]),
  ]);
  assert.equal(replies.filter((r) => r.created).length, 1);
  assert.equal(await f.count("mesocycles"), 1);
  assert.equal(await f.count("mesocycle_exercise_doses"), 1);
  const replay = await f.ok("plans", "createMesocycle", [{
    ...input,
    started_on: "bad",
    exercises: [],
  }]);
  assert.equal(replay.created, false);
  assert.equal(replay.mesocycle.exercises.length, 1);
});

test("D1 a final plan constraint failure rolls back decisions, membership, doses and intent", async (t) => {
  const f = await fixture(t);
  const p = await plan(f);
  const refused = await f.call("plans", "recordDecision", [
    String(p.id),
    decision({
      remove: [1],
      add: [planEntry(3)],
      intent: "Must not save",
      ended_on: "2026-08-02",
    }),
  ]);
  assert.equal(refused.status, 422);
  assert.deepEqual(await f.ok("plans", "mesocycleDetail", [p.id]), p);
  assert.equal(await f.count("mesocycle_decisions"), 0);
  assert.equal(await f.count("mesocycle_exercise_doses"), 1);
  assert.equal(await f.count("api_write_assertions"), 0);
  const duplicateRemoval = await f.call("plans", "recordDecision", [
    String(p.id),
    decision({ remove: [1, 1] }),
  ]);
  assert.equal(duplicateRemoval.status, 422);
  assert.deepEqual(await f.ok("plans", "mesocycleDetail", [p.id]), p);
});

test("D1 redose/removal races reject stale membership and roll back earlier sibling changes", async (t) => {
  const f = await fixture(t);
  const p = await plan(f);
  const result = await f.call("plans", "recordDecision", [
    String(p.id),
    decision({
      intent: "Must not save",
      add: [planEntry(3)],
      redose: [{ exercise: 1, weekly_dose: 12, weekly_dose_unit: "sets" }],
    }),
  ], {
    beforeWrite: {
      sql:
        "DELETE FROM mesocycle_exercises WHERE mesocycle_id = ? AND exercise_id = 1",
      values: [p.id],
    },
  });
  assert.equal(result.status, 422);
  assert.match(result.body.error, /not in this mesocycle's plan/);
  assert.equal(await f.count("mesocycle_decisions"), 0);
  assert.equal(await f.count("mesocycle_exercise_doses"), 1);
  const current = await f.ok("plans", "mesocycleDetail", [p.id]);
  assert.equal(current.intent, "Original intent");
  assert.deepEqual(current.exercises, []);
  assert.equal(await f.count("api_write_assertions"), 0);
});

test("D1 plan endings, reopening, replacement order and refusal contracts remain atomic", async (t) => {
  const f = await fixture(t);
  const p = await plan(f);
  assert.equal(
    (await f.call("plans", "renameMesocycle", [String(p.id), {
      name: "Bad",
      intent: "No",
    }])).status,
    422,
  );
  assert.equal(
    (await f.call("plans", "renameMesocycle", [String(p.id), {
      name: "Bad",
      ended_on: null,
    }])).status,
    422,
  );
  const renamed = await f.ok("plans", "renameMesocycle", [String(p.id), {
    name: "Renamed",
  }]);
  assert.equal(renamed.name, "Renamed");
  const replaced = await f.ok("plans", "recordDecision", [
    String(p.id),
    decision({
      remove: [1],
      add: [planEntry(1, { weekly_dose: 11 })],
      redose: [{ exercise: 1, weekly_dose: 13, weekly_dose_unit: "sets" }],
    }),
  ]);
  assert.equal(replaced.mesocycle.exercises[0].weekly_dose, 13);
  const rollback = await f.call("plans", "recordDecision", [
    String(p.id),
    decision({
      intent: "No",
      remove: [1],
      add: [planEntry(3)],
      ended_on: "2026-08-29",
    }),
  ], { failReadback: true });
  assert.equal(rollback.status, 500);
  assert.deepEqual(
    await f.ok("plans", "mesocycleDetail", [p.id]),
    replaced.mesocycle,
  );
  const ended = await f.ok("plans", "recordDecision", [
    String(p.id),
    decision({ ended_on: "2026-08-29" }),
  ]);
  assert.equal(ended.mesocycle.ended_on, "2026-08-29");
  const next = await plan(f);
  const reopening = await f.call("plans", "recordDecision", [
    String(p.id),
    decision({ intent: "Must not replace", ended_on: null }),
  ]);
  assert.equal(reopening.status, 409);
  assert.equal(
    (await f.ok("plans", "mesocycleDetail", [p.id])).intent,
    "Original intent",
  );
  await f.ok("plans", "recordDecision", [
    String(next.id),
    decision({ ended_on: "2026-08-29" }),
  ]);
  assert.equal(
    (await f.ok("plans", "recordDecision", [
      String(p.id),
      decision({ ended_on: null }),
    ])).mesocycle.ended_on,
    null,
  );
});

test("D1 distinct references and large plans stay below a fixed query budget", async (t) => {
  const f = await fixture(t);
  const ids = Array.from({ length: 1200 }, (_, i) => i + 10);
  await f.db.prepare(
    `INSERT INTO exercises (id, name, name_key, measure, stimulus_type)
    SELECT value, 'Lift ' || value, 'lift ' || value, 'load_reps', 'strength' FROM json_each(?)`,
  ).bind(JSON.stringify(ids)).run();
  const sets = ids.map((id) =>
    planned({ exercise: id % 2 ? id : `LIFT ${id}` })
  );
  const written = await f.ok("sessions", "writeSession", [{
    date: "2026-08-10",
    rationale: "Large catalogue",
    sets,
    request_id: randomUUID(),
  }], { maxQueries: 35 });
  assert.equal(written.session.sets.length, 1200);
  assert.deepEqual(written.session.sets.map((s) => s.exercise_id), ids);
  const block = (await f.ok("blocks", "openBlock", [{
    name: "Large",
    goal: "strength",
    started_on: "2026-08-03",
    request_id: randomUUID(),
  }])).row;
  const p = await f.ok("plans", "createMesocycle", [{
    block_id: block.id,
    name: "Large",
    track: "strength",
    intent: "Synthetic",
    started_on: "2026-08-03",
    planned_weeks: 4,
    sessions_per_week: 3,
    exercises: ids.map((id) => planEntry(id)),
    request_id: randomUUID(),
  }], { maxQueries: 35 });
  assert.equal(p.mesocycle.exercises.length, 1200);
  const redosed = await f.ok("plans", "recordDecision", [
    String(p.mesocycle.id),
    decision({
      redose: ids.map((exercise) => ({
        exercise,
        weekly_dose: 10,
        weekly_dose_unit: "sets",
      })),
    }),
  ], { maxQueries: 40 });
  assert.equal(redosed.mesocycle.exercises.length, 1200);
  assert.ok(redosed.mesocycle.exercises.every((e) => e.weekly_dose === 10));
  const pastPlans = ids.map((id) => id + 3000);
  await f.db.prepare(`INSERT INTO mesocycles
    (id, block_id, name, intent, planned_weeks, sessions_per_week, started_on, ended_on, track)
    SELECT value, ?, 'Past ' || value, 'Synthetic', 1, 3, '2026-08-03', '2026-08-09', 'strength'
    FROM json_each(?)`).bind(block.id, JSON.stringify(pastPlans)).run();
  const explicit = await f.ok("sessions", "writeSession", [{
    date: "2026-08-10",
    rationale: "Explicit past attribution",
    request_id: randomUUID(),
    sets: pastPlans.map((id) => planned({ mesocycle: String(id) })),
  }], { maxQueries: 35 });
  assert.deepEqual(explicit.session.sets.map((s) => s.mesocycle_id), pastPlans);
  assert.equal(await f.count("api_write_assertions"), 0);
});

// The operations execute inside workerd, not in the Node test process. Node
// owns only synthetic setup and assertions against the same local D1 binding.
test("D1 session creation, immutable targets, mixed plans and UUID replay", async (t) => {
  const f = await fixture(t);
  await f.db.batch([
    f.db.prepare(
      "INSERT INTO blocks (id, name, goal, started_on) VALUES (1, 'Synthetic', 'strength', '2026-08-03')",
    ),
    f.db.prepare(
      `INSERT INTO mesocycles (id, block_id, name, intent, planned_weeks, sessions_per_week, started_on, track) VALUES
      (1, 1, 'Lift', 'Synthetic', 4, 3, '2026-08-03', 'strength'),
      (2, 1, 'Run', 'Synthetic', 4, 2, '2026-08-03', 'speed')`,
    ),
    f.db.prepare(
      "INSERT INTO mesocycle_exercises (mesocycle_id, exercise_id, role, priority) VALUES (1, 1, 'main', 1), (2, 2, 'main', 1)",
    ),
  ]);
  const uuid = randomUUID();
  const created = await f.ok("sessions", "writeSession", [{
    date: "2026-08-10",
    rationale: "Mixed",
    sets: [planned(), {
      exercise: 2,
      kind: "working",
      target_distance_m: 50,
      target_duration_s: 9.125,
    }],
    request_id: uuid.toUpperCase(),
  }]);
  assert.equal(created.created, true);
  assert.deepEqual(created.session.sets.map((s) => s.mesocycle_id), [1, 2]);
  assert.equal(created.session.sets[0].target_weight_kg, 82.35);
  assert.equal(created.session.sets[1].target_duration_s, 9.13);
  assert.equal(created.session.sets[0].reps, null);
  assert.equal(Object.hasOwn(created.session, "write_version"), false);
  assert.equal(Object.hasOwn(created.session.sets[0], "request_id"), false);
  const replay = await f.ok("sessions", "writeSession", [{
    date: "bad",
    rationale: "ignored retry",
    sets: [],
    request_id: uuid,
  }]);
  assert.equal(replay.created, false);
  assert.deepEqual(replay.session, created.session);
  const filtered = await f.ok("sessions", "listSessions", [
    20,
    "current:speed",
  ]);
  assert.equal(filtered[0].id, created.session.id);
  const immutable = await f.call("sessions", "correctSet", [
    created.session.sets[0].id,
    { target_reps: 7 },
  ]);
  assert.equal(immutable.status, 422);
  assert.match(immutable.body.error, /Targets are immutable/);
  assert.equal(await f.count("api_write_assertions"), 0);
});

test("D1 resolves Unicode aliases, canonical names before aliases, and refuses ambiguous plans", async (t) => {
  const f = await fixture(t);
  await f.db.prepare(
    "INSERT INTO exercises (id, name, name_key) VALUES (5, '', '')",
  ).run();
  const blank = await f.call("sessions", "writeSession", [{
    date: "2026-08-10",
    rationale: "Blank refs stay invalid",
    sets: [planned({ exercise: " " })],
    request_id: randomUUID(),
  }]);
  assert.equal(blank.status, 422);
  assert.match(blank.body.error, /"exercise" is required/);
  await f.db.batch([
    f.db.prepare(
      "INSERT INTO exercises (id, name, name_key) VALUES (4, 'Élévation', 'élévation')",
    ),
    f.db.prepare(
      "INSERT INTO exercise_aliases (exercise_id, alias, alias_key) VALUES (1, 'Élévation', 'élévation'), (1, 'Accosciata', 'accosciata')",
    ),
  ]);
  const named = await f.session([
    planned({ exercise: "ÉLÉVATION" }),
    planned({ exercise: "ACCOSCIATA" }),
    planned({ exercise: "1" }),
  ]);
  assert.deepEqual(named.sets.map((s) => s.exercise_id), [4, 1, 1]);
  await f.db.batch([
    f.db.prepare(
      "INSERT INTO blocks (id, name, goal, started_on) VALUES (1, 'Synthetic', 'strength', '2026-08-03')",
    ),
    f.db.prepare(
      `INSERT INTO mesocycles (id, block_id, name, intent, planned_weeks, sessions_per_week, started_on, track) VALUES
      (1, 1, 'A', 'Synthetic', 4, 3, '2026-08-03', 'strength'),
      (2, 1, 'B', 'Synthetic', 4, 3, '2026-08-03', 'hypertrophy')`,
    ),
    f.db.prepare(
      "INSERT INTO mesocycle_exercises (mesocycle_id, exercise_id, role, priority) VALUES (1, 1, 'main', 1), (2, 1, 'main', 1)",
    ),
  ]);
  const refused = await f.call("sessions", "writeSession", [{
    date: "2026-08-10",
    rationale: "No guessing",
    sets: [planned()],
    request_id: randomUUID(),
  }]);
  assert.equal(refused.status, 422);
  assert.match(refused.body.error, /more than one active plan/);
  assert.equal(await f.count("sessions"), 1);
  const explicit = await f.session([
    planned({ mesocycle: "current:strength" }),
  ]);
  assert.equal(explicit.sets[0].mesocycle_id, 1);
});

test("D1 creates and corrects a 1500-set session with bounded statement and bind counts", async (t) => {
  const f = await fixture(t);
  const s = await f.session(Array.from({ length: 1500 }, () => planned()));
  assert.equal(s.sets.length, 1500);
  const changed = await f.ok("sessions", "correctSession", [s.id, {
    notes: "All saved",
    sets: s.sets.map((set) => ({
      id: set.id,
      weight_kg: 82.345,
      reps: 5,
      effort: "hard",
    })),
  }]);
  assert.equal(changed.notes, "All saved");
  assert.equal(changed.sets.at(-1).weight_kg, 82.35);
  assert.equal(changed.sets.at(-1).position, 1500);
  assert.equal(await f.count("api_write_assertions"), 0);
});

test("D1 rejects invalid reports without changing facts, including explicit null and foreign set ids", async (t) => {
  const f = await fixture(t);
  const s = await f.session([planned(), planned()]);
  const other = await f.session();
  const before = await f.state(s.id);
  for (
    const sets of [
      [{ id: s.sets[0].id, weight_kg: 80, reps: 5, effort: "hard" }, {
        id: s.sets[1].id,
        weight_kg: 90,
      }],
      [{ id: s.sets[0].id, notes: "first" }, {
        id: s.sets[0].id,
        notes: "duplicate",
      }],
      [{ id: other.sets[0].id, notes: "wrong owner" }],
      [],
    ]
  ) {
    const result = await f.call("sessions", "correctSession", [s.id, {
      notes: "must not save",
      sets,
    }]);
    assert.ok([404, 422].includes(result.status), JSON.stringify(result));
    assert.deepEqual(await f.state(s.id), before);
  }
  const cleared = await f.ok("sessions", "correctSession", [s.id, {
    notes: null,
    sets: [{ id: s.sets[0].id, notes: null }],
  }]);
  assert.equal(cleared.notes, null);
  assert.equal(await f.count("api_write_assertions"), 0);
});

test("D1 corrections preserve omitted microseconds and round supplied values only", async (t) => {
  const f = await fixture(t);
  const precise = "2026-08-10T10:00:00.123456Z";
  const s = await f.session([actual({ performed_at: precise })]);
  await f.ok("sessions", "correctSession", [s.id, {
    started_at: "2026-08-10T11:59:00.654321+02:00",
  }]);
  const corrected = await f.ok("sessions", "correctSet", [s.sets[0].id, {
    notes: "Keep instant",
    weight_kg: 82.345,
  }]);
  assert.equal(corrected.performed_at, "2026-08-10T10:00:00.123Z");
  assert.equal(corrected.weight_kg, 82.35);
  const result = await f.state(s.id);
  assert.equal(result.header.started_at, "2026-08-10T09:59:00.654321Z");
  assert.equal(result.sets[0].performed_at, precise);
  assert.equal(result.sets[0].weight_kg, 8235);
});

for (const change of ["measure = 'duration'", "stimulus_type = 'power'"]) {
  test(`D1 refuses session creation when exercise identity changes after validation: ${change}`, async (t) => {
    const f = await fixture(t);
    const result = await f.call("sessions", "writeSession", [{
      date: "2026-08-10",
      rationale: "Must not save stale validation",
      sets: [actual()],
      request_id: randomUUID(),
    }], {
      beforeWrite: { sql: `UPDATE exercises SET ${change} WHERE id = 1` },
    });
    assert.equal(result.status, 409, JSON.stringify(result.body));
    assert.equal(await f.count("sessions"), 0);
    assert.equal(await f.count("sets"), 0);
    assert.equal(await f.count("api_write_assertions"), 0);
  });
}

test("D1 refuses a stale exercise identity on first append without changing the session", async (t) => {
  const f = await fixture(t);
  const s = await f.session([{ exercise: 3, kind: "working", target_reps: 5 }]);
  const before = await f.state(s.id);
  const result = await f.call("sessions", "appendSet", [s.id, {
    ...actual(),
    request_id: randomUUID(),
  }], {
    beforeWrite: {
      sql: "UPDATE exercises SET measure = 'duration' WHERE id = 1",
    },
  });
  assert.equal(result.status, 409, JSON.stringify(result.body));
  assert.deepEqual(await f.state(s.id), before);
  assert.equal(await f.count("api_write_assertions"), 0);
});

test("D1 SQL failure in response readback rolls back both creation and correction", async (t) => {
  const f = await fixture(t);
  const failed = await f.call("sessions", "writeSession", [{
    date: "2026-08-10",
    rationale: "Must roll back",
    sets: [planned()],
    request_id: randomUUID(),
  }], { failReadback: true });
  assert.equal(failed.status, 500);
  assert.equal(await f.count("sessions"), 0);
  assert.equal(await f.count("sets"), 0);
  const s = await f.session();
  const before = await f.state(s.id);
  const correction = await f.call("sessions", "correctSession", [s.id, {
    notes: "Must roll back",
    sets: [{ id: s.sets[0].id, weight_kg: 80, reps: 5, effort: "hard" }],
  }], { failReadback: true });
  assert.equal(correction.status, 500);
  assert.deepEqual(await f.state(s.id), before);
  assert.equal(await f.count("api_write_assertions"), 0);
});

test("D1 affected-row assertions roll back a partially applied set report", async (t) => {
  const f = await fixture(t);
  const s = await f.session([planned(), planned()]);
  const before = await f.state(s.id);
  await f.db.prepare(
    `CREATE TRIGGER test_ignore_set BEFORE UPDATE ON sets WHEN OLD.id = ${
      s.sets[1].id
    }
    BEGIN SELECT RAISE(IGNORE); END`,
  ).run();
  const result = await f.call("sessions", "correctSession", [s.id, {
    notes: "Must not save",
    sets: s.sets.map((set) => ({
      id: set.id,
      weight_kg: 80,
      reps: 5,
      effort: "hard",
    })),
  }]);
  assert.equal(result.status, 409, JSON.stringify(result.body));
  assert.deepEqual(await f.state(s.id), before);
  assert.equal(await f.count("api_write_assertions"), 0);
});

test("D1 stale corrections re-read and validate rather than combine incompatible actuals", async (t) => {
  const f = await fixture(t);
  const s = await f.session([actual()]);
  const result = await f.call("sessions", "correctSession", [s.id, {
    notes: "Must not save",
    sets: [{ id: s.sets[0].id, reps: 6, effort: "hard" }],
  }], {
    beforeWrite: {
      sql:
        "UPDATE sets SET weight_kg = NULL, reps = NULL, effort = NULL, performed_at = NULL WHERE id = ?",
      values: [s.sets[0].id],
    },
  });
  assert.equal(result.status, 422, JSON.stringify(result.body));
  const stored = await f.state(s.id);
  assert.equal(stored.header.notes, null);
  assert.equal(stored.sets[0].weight_kg, null);
  assert.equal(stored.sets[0].reps, null);
  assert.equal(await f.count("api_write_assertions"), 0);
});

test("D1 versions cover direct set insert, update, delete and parent facts", async (t) => {
  const f = await fixture(t);
  const s = await f.session();
  let version = (await f.state(s.id)).header.write_version;
  for (
    const sql of [
      "UPDATE sets SET notes = 'other writer' WHERE session_id = ?",
      "UPDATE sessions SET notes = 'other writer' WHERE id = ?",
      "INSERT INTO sets (session_id, exercise_id, position, kind) VALUES (?, 1, 2, 'warmup')",
      "DELETE FROM sets WHERE session_id = ? AND position = 2",
    ]
  ) {
    await f.db.prepare(sql).bind(s.id).run();
    const next = (await f.state(s.id)).header.write_version;
    assert.ok(next > version);
    version = next;
  }
});

test("D1 discard cannot delete work performed after its initial eligibility read", async (t) => {
  const f = await fixture(t);
  const s = await f.session();
  const result = await f.call("sessions", "discardSession", [s.id], {
    beforeWrite: {
      sql:
        "UPDATE sets SET weight_kg = 8000, reps = 5, effort = 'hard' WHERE id = ?",
      values: [s.sets[0].id],
    },
  });
  assert.equal(result.status, 409);
  assert.match(result.body.error, /on the record/);
  assert.equal((await f.state(s.id)).sets[0].reps, 5);
  const draft = await f.session();
  assert.deepEqual(await f.ok("sessions", "discardSession", [draft.id]), {
    id: draft.id,
    date: draft.date,
    sets: 1,
  });
  assert.equal(await f.count("api_write_assertions"), 0);
});

test("D1 bounded contention retries refuse without committing the request", async (t) => {
  const f = await fixture(t);
  const s = await f.session();
  const result = await f.call("sessions", "correctSession", [s.id, {
    notes: "Must not save",
  }], {
    beforeWrite: {
      sql: "UPDATE sessions SET rationale = 'Competing writer' WHERE id = ?",
      values: [s.id],
      repeat: true,
    },
  });
  assert.equal(result.status, 409);
  assert.match(result.body.error, /kept changing/);
  const state = await f.state(s.id);
  assert.equal(state.header.notes, null);
  assert.equal(state.header.rationale, "Competing writer");
  assert.equal(await f.count("api_write_assertions"), 0);
});

test("D1 concurrent appends allocate unique positions and replay only within their session", async (t) => {
  const f = await fixture(t);
  const s = await f.session();
  const uuid = randomUUID();
  const results = await Promise.all([
    f.ok("sessions", "appendSet", [s.id, actual({ request_id: uuid })]),
    f.ok("sessions", "appendSet", [s.id, actual({ request_id: randomUUID() })]),
  ]);
  assert.deepEqual(results.map((r) => r.set.position).sort(), [2, 3]);
  const replay = await f.ok("sessions", "appendSet", [s.id, {
    request_id: uuid,
    exercise: "not parsed on replay",
  }]);
  assert.equal(replay.created, false);
  assert.equal(replay.set.id, results[0].set.id);
  const other = await f.session();
  const conflict = await f.call("sessions", "appendSet", [
    other.id,
    actual({ request_id: uuid }),
  ]);
  assert.equal(conflict.status, 409);
  assert.equal((await f.state(other.id)).sets.length, 1);
});

test("D1 bodyweight retains storage precision, rejects changed retries and uses Rome dates", async (t) => {
  const f = await fixture(t);
  const input = {
    valueKg: 82.345,
    measuredAt: "2026-08-10T23:30:00.123456+02:00",
    source: "manual",
  };
  const created = await f.ok("bodyweight", "recordBodyweight", [input]);
  assert.equal(created.row.value_kg, 82.35);
  assert.equal(created.created, true);
  assert.equal(
    (await f.ok("bodyweight", "recordBodyweight", [input])).created,
    false,
  );
  const conflict = await f.call("bodyweight", "recordBodyweight", [{
    ...input,
    valueKg: 82.36,
  }]);
  assert.equal(conflict.status, 409);
  const row = await f.db.prepare("SELECT * FROM bodyweight").first();
  assert.equal(row.value_kg, 8235);
  assert.equal(row.measured_at, "2026-08-10T21:30:00.123456Z");
  assert.equal(row.measured_date, "2026-08-10");
  await f.ok("bodyweight", "recordBodyweight", [{
    ...input,
    valueKg: 82,
    measuredAt: "2026-08-10T23:30:00Z",
  }]);
  assert.equal(
    (await f.db.prepare(
      "SELECT measured_date FROM bodyweight ORDER BY id DESC LIMIT 1",
    ).first()).measured_date,
    "2026-08-11",
  );
  const invalid = await f.call("bodyweight", "recordBodyweight", [{
    ...input,
    valueKg: 8.2,
  }]);
  assert.equal(invalid.status, 422);
  const future = await f.call("bodyweight", "recordBodyweight", [{
    ...input,
    measuredAt: "2027-08-10T08:00:00Z",
  }]);
  assert.equal(future.status, 422);
  assert.equal((await f.ok("bodyweight", "listBodyweight")).length, 2);
  assert.equal(
    (await f.ok("bodyweight", "removeBodyweight", [created.row.id])).value_kg,
    82.35,
  );
});

test("D1 bodyfat preserves natural-key precedence and request replay across Rome midnight", async (t) => {
  const f = await fixture(t);
  const input = { percent: 15.45, method: "bia", requestId: randomUUID() };
  const created = await f.ok("bodyfat", "recordBodyfat", [input], {
    now: "2026-08-10T21:59:00Z",
  });
  assert.equal(created.row.day, "2026-08-10");
  assert.equal(created.row.percent, 15.5);
  assert.equal(
    (await f.ok("bodyfat", "recordBodyfat", [input], {
      now: "2026-08-10T22:01:00Z",
    })).row.id,
    created.row.id,
  );
  const second = await f.ok("bodyfat", "recordBodyfat", [{
    ...input,
    percent: 16,
    requestId: randomUUID(),
  }], { now: "2026-08-10T22:01:00Z" });
  const conflict = await f.call("bodyfat", "recordBodyfat", [input], {
    now: "2026-08-10T22:01:00Z",
  });
  assert.equal(conflict.status, 409);
  assert.equal((await f.ok("bodyfat", "latestBodyfat")).id, second.row.id);
  assert.equal((await f.ok("bodyfat", "listBodyfat")).length, 2);
  assert.equal(
    (await f.ok("bodyfat", "removeBodyfat", [second.row.id])).percent,
    16,
  );
  const future = await f.call("bodyfat", "recordBodyfat", [{
    ...input,
    day: "2027-01-01",
  }]);
  assert.equal(future.status, 422);
});

test("JSON bindings split by UTF-8 bytes without losing order or values", async (t) => {
  const f = await fixture(t);
  const result = await f.ok("codec", "chunks", [[
    { notes: "é".repeat(300000) },
    { notes: "é".repeat(300000) },
    { notes: "é".repeat(300000) },
  ]]);
  assert.equal(result.roundTrips, true);
  assert.deepEqual(result.chunks.map(({ count, offset }) => [count, offset]), [[
    2,
    0,
  ], [1, 2]]);
  assert.ok(result.chunks.every(({ bytes }) => bytes <= 1536 * 1024));
  assert.deepEqual(await f.ok("codec", "chunks", [[]]), {
    chunks: [{ count: 0, offset: 0, bytes: 2 }],
    roundTrips: true,
  });
  assert.equal(
    (await f.call("codec", "chunks", [[{ notes: "é".repeat(800000) }]])).status,
    413,
  );
});

test("an accepted-size request can span JSON chunks without partial commits or reset positions", async (t) => {
  const f = await fixture(t);
  const input = {
    date: "2026-08-10",
    rationale: "Synthetic large session",
    request_id: randomUUID(),
    sets: Array.from({ length: 8000 }, () => planned()),
  };
  assert.ok(Buffer.byteLength(JSON.stringify(input)) < 1024 * 1024);
  const written = (await f.ok("sessions", "writeSession", [input])).session;
  assert.equal(written.sets.length, 8000);
  assert.deepEqual(
    written.sets.map(({ position }) => position),
    Array.from({ length: 8000 }, (_, index) => index + 1),
  );
  const failed = await f.call("sessions", "writeSession", [{
    ...input,
    request_id: randomUUID(),
  }], { failReadback: true });
  assert.equal(failed.status, 500);
  assert.equal(await f.count("sessions"), 1);
  assert.equal(await f.count("sets"), 8000);
  assert.equal(await f.count("api_write_assertions"), 0);
});

test("D1 refusals identify required columns and do not classify unknown failures as success", async (t) => {
  const f = await fixture(t);
  let failure;
  try {
    await f.db.prepare(
      "INSERT INTO foods (name, name_key, source) VALUES ('Synthetic', 'synthetic', 'label')",
    ).run();
  } catch (error) {
    failure = error;
  }
  assert.ok(failure instanceof Error);
  const refusal = await f.ok("codec", "refusal", [failure.message]);
  assert.equal(refusal.status, 422);
  assert.match(refusal.message, /"kcal_100g" is required/);
  const duplicate = await f.ok("codec", "refusal", [
    "D1_ERROR: UNIQUE constraint failed: sets.session_id, sets.position",
  ]);
  assert.deepEqual(duplicate, {
    status: 409,
    message: "That position in the session is already taken.",
  });
  assert.deepEqual(
    await f.ok("codec", "refusal", ["D1_ERROR: unexpected private diagnostic"]),
    { status: 500 },
  );
  const inherited = await f.ok("codec", "refusal", [
    "D1_ERROR: CHECK constraint failed: constructor",
  ]);
  assert.equal(typeof inherited.message, "string");
  assert.doesNotMatch(inherited.message, /native code/);
});

test("Worker timestamp conversion rejects impossible dates and preserves offset microseconds", async (t) => {
  const f = await fixture(t);
  assert.equal(
    await f.ok("codec", "instant", ["2026-10-25T02:30:00.654321+02:00"]),
    "2026-10-25T00:30:00.654321Z",
  );
  for (
    const value of [
      "2026-02-30T10:00:00Z",
      "2026-01-01T25:00:00Z",
      "2026-01-01",
      "2026-01-01T10:00:00.1234567Z",
      "0000-01-01T00:00:00Z",
      "0001-01-01T00:00:00+02:00",
    ]
  ) {
    assert.equal(
      (await f.call("codec", "instant", [value])).status,
      422,
      value,
    );
  }
});
