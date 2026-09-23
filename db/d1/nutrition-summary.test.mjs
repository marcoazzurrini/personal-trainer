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
      fileURLToPath(
        new URL("./nutrition-summary.test.worker.ts", import.meta.url),
      ),
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
    "Summary reads must not load PostgreSQL or its environment reader.",
  );
  script = compiled.outputFiles[0].text;
  assert.doesNotMatch(script, /\bDeno\b/);
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
    d1Databases: { DB: `synthetic-nutrition-summary-${randomUUID()}` },
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
  const run = (sql, ...values) =>
    db
      .prepare(sql)
      .bind(...values)
      .run();
  async function call(method, extra = {}) {
    const response = await mf.dispatchFetch("http://local.invalid/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ method, now: "2026-03-30T00:30:00Z", ...extra }),
    });
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    return body;
  }
  const target = async (day, goal, extra = {}) => {
    const result = await db
      .prepare(
        `INSERT INTO nutrition_targets
      (effective_from, goal, rate_pct_bw_week, kcal_target, protein_g_target,
       decision, clipped, clipped_reasons, phase_switch_suppressed, created_at)
      VALUES (?, ?, ?, ?, 150, 'Synthetic plan', ?, ?, ?, '2026-01-01T00:00:00.123456Z') RETURNING id`,
      )
      .bind(
        day,
        goal,
        extra.rate ?? -35,
        extra.kcal ?? 2000,
        extra.clipped ? 1 : 0,
        JSON.stringify(extra.reasons ?? []),
        extra.suppressed ? 1 : 0,
      )
      .first();
    return result.id;
  };
  const intake = (day, kcal, protein = null) =>
    run(
      "INSERT INTO intake_entries (day, kcal, protein_g) VALUES (?, ?, ?)",
      day,
      Math.round(kcal * 10),
      protein === null ? null : Math.round(protein * 10),
    );
  const weight = (day, kg, time = "06:00:00.000000") =>
    run(
      "INSERT INTO bodyweight (value_kg, measured_at, measured_date) VALUES (?, ?, ?)",
      Math.round(kg * 100),
      `${day}T${time}Z`,
      day,
    );
  return { db, run, call, target, intake, weight };
}
const addDays = (day, count) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + count);
  return d.toISOString().slice(0, 10);
};

test("empty state retains unknowns, thirteen completed days, and bounded 104-week reads", async (t) => {
  const f = await fixture(t);
  const {
    result: state,
    queries,
    maxBindings,
  } = await f.call("nutritionState");
  assert.deepEqual(state.now, {
    date: "2026-03-30",
    time: "02:30",
    weekday: "Monday",
    tz: "Europe/Rome",
  });
  assert.equal(state.today_so_far.totals.kcal, 0);
  assert.equal(state.today_so_far.totals.protein_g, null);
  assert.equal(state.today_so_far.vs_target, null);
  assert.equal(state.target, null);
  assert.equal(state.trend_weight, null);
  assert.equal(state.latest_bodyfat, null);
  assert.equal(state.expenditure.status, "insufficient_data");
  assert.equal(state.expenditure.as_of, null);
  assert.equal(state.expenditure.window.to, "2026-03-29");
  assert.equal(state.recent_days.length, 13);
  assert.equal(state.recent_days[0].day, "2026-03-17");
  assert.equal(state.recent_days.at(-1).day, "2026-03-29");
  assert.ok(
    state.recent_days.every(
      (d) =>
        d.kcal === null &&
        d.protein_g === null &&
        d.weight_kg === null &&
        d.entries === 0 &&
        d.incomplete === false,
    ),
  );
  assert.deepEqual(state.adherence, {
    days_logged_last_7: 0,
    days_logged_last_21: 0,
    weigh_ins_last_7: 0,
    weigh_ins_last_21: 0,
    last_logged_day: null,
    last_weigh_in: null,
  });
  assert.ok(queries <= 16);
  assert.ok(maxBindings <= 9);
  const short = await f.call("finishedWeeks", { weeks: 1 });
  const long = await f.call("finishedWeeks", { weeks: 104 });
  assert.equal(long.result.weeks.length, 104);
  assert.equal(long.queries, 4);
  assert.equal(long.queries, short.queries);
  assert.ok(long.maxBindings <= 4);
  assert.equal(long.result.weeks.at(-1).week_end, "2026-03-29");
  for (const week of long.result.weeks) {
    assert.equal(week.mean_kcal, null);
    assert.equal(week.mean_protein_g, null);
    assert.equal(week.implied_tdee_kcal, null);
    assert.equal(week.target, null);
    assert.deepEqual(week.events, []);
    assert.deepEqual(week.protein_coverage, {
      days_in_mean: 0,
      entries: 0,
      unknown_entries: 0,
    });
  }
});

test("Rome DST, midnight and completed-week boundaries use one clock snapshot", async (t) => {
  const f = await fixture(t);
  const cases = [
    ["2026-03-29T00:30:00Z", "2026-03-29", "01:30", "Sunday", "2026-03-22"],
    ["2026-03-29T01:30:00Z", "2026-03-29", "03:30", "Sunday", "2026-03-22"],
    ["2026-03-29T22:30:00Z", "2026-03-30", "00:30", "Monday", "2026-03-29"],
    ["2026-10-25T00:30:00Z", "2026-10-25", "02:30", "Sunday", "2026-10-18"],
    ["2026-10-25T01:30:00Z", "2026-10-25", "02:30", "Sunday", "2026-10-18"],
    ["2026-10-25T23:30:00Z", "2026-10-26", "00:30", "Monday", "2026-10-25"],
  ];
  for (const [now, date, time, weekday, end] of cases) {
    const state = await f.call("nutritionState", {
      now,
      nextNow: "2027-01-01T12:00:00Z",
    });
    assert.deepEqual(state.result.now, {
      date,
      time,
      weekday,
      tz: "Europe/Rome",
    });
    assert.equal(state.clockCalls, 1);
    assert.equal(state.result.expenditure.window.to, end);
    const weekly = await f.call("finishedWeeks", { now, weeks: 1 });
    assert.equal(weekly.result.weeks[0].week_end, end);
    assert.equal(weekly.result.weeks[0].week_start, addDays(end, -6));
  }
});

test("state preserves scaled live food values, null floors, target winners and rolling adherence", async (t) => {
  const f = await fixture(t);
  await f.run(
    `INSERT INTO foods (id, name, name_key, source, kcal_100g, protein_100g, carbs_100g, fat_100g)
    VALUES (1, 'Synthetic food', 'synthetic food', 'label', 1000, 15, 100, 50)`,
  );
  await f.run(`INSERT INTO intake_entries (day, food_id, grams, created_at)
    VALUES ('2026-03-30', 1, 900, '2026-03-30T00:00:00.123456Z')`);
  await f.intake("2026-03-30", 10.1);
  await f.intake("2026-03-09", 100);
  await f.intake("2026-03-08", 100);
  await f.intake("2026-03-23", 100);
  await f.intake("2026-03-29", 100);
  await f.run(
    "INSERT INTO day_flags(day, flag) VALUES ('2026-03-28', 'incomplete')",
  );
  await f.weight("2026-03-09", 81);
  await f.weight("2026-03-10", 80.7);
  await f.weight("2026-03-23", 80.5);
  await f.weight("2026-03-24", 80.4);
  await f.weight("2026-03-30", 80.12);
  await f.weight("2026-03-30", 85, "08:00:00.000000");
  await f.run(`INSERT INTO bodyfat_estimates(day, percent, method) VALUES
    ('2026-03-29', 121, 'bia'), ('2026-03-29', 134, 'visual')`);
  await f.target("2026-03-30", "cut", { kcal: 1900 });
  const winner = await f.target("2026-03-30", "cut", {
    clipped: true,
    reasons: ["rate"],
    rate: -37,
  });
  await f.target("2026-03-31", "gain", { kcal: 3000 });
  let { result: state } = await f.call("nutritionState");
  assert.equal(state.today_so_far.entries[0].grams, 90);
  assert.equal(state.today_so_far.entries[0].protein_g, 1.4);
  assert.equal(
    state.today_so_far.entries[0].created_at,
    "2026-03-30T00:00:00.123Z",
  );
  assert.equal(state.today_so_far.totals.kcal, 100.1);
  assert.equal(state.today_so_far.totals.fiber_g, null);
  assert.deepEqual(state.today_so_far.totals.unaccounted.protein_g, {
    entries: 1,
    kcal: 10.1,
  });
  assert.deepEqual(state.today_so_far.vs_target, {
    kcal_target: 2000,
    kcal_remaining: 1899.9,
    protein_g_target: 150,
    protein_g_remaining: 148.6,
  });
  assert.equal(state.target.id, winner);
  assert.equal(state.target.rate_pct_bw_week, -0.37);
  assert.equal(state.target.clipped, true);
  assert.deepEqual(state.target.clipped_reasons, ["rate"]);
  assert.equal(state.target.created_at, "2026-01-01T00:00:00.123Z");
  assert.equal(state.latest_bodyfat.percent, 13.4);
  assert.equal(state.trend_weight.earliest_scale_kg, 80.12);
  assert.deepEqual(state.adherence, {
    days_logged_last_7: 2,
    days_logged_last_21: 3,
    weigh_ins_last_7: 2,
    weigh_ins_last_21: 4,
    last_logged_day: "2026-03-29",
    last_weigh_in: "2026-03-30",
  });
  assert.ok(
    state.expenditure.blockers.some((b) =>
      b.includes("1 weigh-in day since the window closed")
    ),
  );
  assert.deepEqual(
    state.recent_days.find((d) => d.day === "2026-03-28"),
    {
      day: "2026-03-28",
      kcal: null,
      protein_g: null,
      entries: 0,
      incomplete: true,
      weight_kg: null,
    },
  );
  await f.run(
    "UPDATE foods SET kcal_100g = 2000, macro_revision = macro_revision + 1 WHERE id = 1",
  );
  state = (await f.call("nutritionState")).result;
  assert.equal(state.today_so_far.totals.kcal, 190.1);
  await f.run("DELETE FROM intake_entries WHERE day = '2026-03-30'");
  state = (await f.call("nutritionState")).result;
  assert.equal(state.today_so_far.vs_target.kcal_remaining, 2000);
  assert.equal(state.today_so_far.vs_target.protein_g_remaining, null);
});

test("weekly coverage excludes flagged days, preserves zero protein and uses elapsed six-day slope", async (t) => {
  const f = await fixture(t);
  await f.intake("2026-03-23", 100.1, 10.2);
  await f.intake("2026-03-23", 200.2);
  await f.intake("2026-03-24", 500, 100);
  await f.run(
    "INSERT INTO day_flags(day, flag) VALUES ('2026-03-24', 'incomplete'), ('2026-03-26', 'incomplete')",
  );
  await f.intake("2026-03-25", 400);
  await f.intake("2026-03-27", 600, 0);
  await f.intake("2026-03-30", 9999, 900);
  for (let i = 0; i < 7; i++) {
    await f.weight(addDays("2026-03-23", i), 80 - i * 0.2);
  }
  await f.weight("2026-03-23", 99, "09:00:00.000000");
  await f.run(
    "INSERT INTO bodyfat_estimates(day, percent, method) VALUES ('2026-03-23', 125, 'visual')",
  );
  await f.target("2026-03-23", "cut", { rate: -40 });
  let week = (await f.call("finishedWeeks", { weeks: 1 })).result.weeks[0];
  assert.equal(week.days_logged, 4);
  assert.equal(week.days_flagged, 2);
  assert.equal(week.weigh_ins, 7);
  assert.equal(week.mean_kcal, 433);
  assert.equal(week.mean_protein_g, 5);
  assert.deepEqual(week.protein_coverage, {
    days_in_mean: 2,
    entries: 4,
    unknown_entries: 2,
  });
  assert.equal(week.target.changed_during_week, false);
  assert.equal(week.target.rate_pct_bw_week, -0.4);
  assert.equal(week.trend_start_kg, 80);
  let ema = 80;
  for (let i = 1; i < 7; i++) ema = 0.1 * (80 - i * 0.2) + 0.9 * ema;
  const end = Math.round(ema * 100) / 100;
  assert.equal(week.trend_end_kg, end);
  const slope = (end - 80) / 6;
  const p = 10.4 / (10.4 + end * 0.125);
  const density = p * 1020 + (1 - p) * 9440;
  assert.equal(
    week.implied_tdee_kcal,
    Math.round((300.3 + 400 + 600) / 3 - slope * density),
  );
  assert.equal(
    week.rate_pct_bw_week,
    Math.round(((slope * 7) / 80) * 10000) / 100,
  );
  await f.run("DELETE FROM bodyfat_estimates");
  week = (await f.call("finishedWeeks", { weeks: 1 })).result.weeks[0];
  assert.equal(week.implied_tdee_kcal, null);
  assert.notEqual(week.trend_delta_kg, null);
});

test("goal switches compare full history before filters, including backdates, suppression and same-day winners", async (t) => {
  const f = await fixture(t);
  await f.target("2025-01-01", "cut");
  await f.target("2026-03-10", "maintain");
  await f.target("2026-03-15", "gain");
  const cutoff = await f.target("2026-03-16", "cut");
  await f.target("2026-03-23", "maintain");
  await f.target("2026-03-24", "gain", { suppressed: true });
  const winner = await f.target("2026-03-25", "cut");
  await f.target("2026-03-25", "maintain");
  await f.target("2026-03-26", "maintain");
  await f.target("2026-03-31", "gain");
  await f.run(`INSERT INTO nutrition_events(day, kind, note) VALUES
    ('2026-03-16', 'other', 'inclusive cutoff'),
    ('2026-03-15', 'other', 'too old'),
    ('2026-03-31', 'other', 'future'),
    ('2026-03-25', 'phase_switch', 'independent manual event')`);
  const state = (await f.call("nutritionState")).result;
  assert.ok(state.active_transients.some((e) => e.id === -cutoff));
  assert.ok(state.active_transients.some((e) => e.note === "inclusive cutoff"));
  assert.ok(
    !state.active_transients.some(
      (e) => e.day < "2026-03-16" || e.day > "2026-03-30",
    ),
  );
  assert.ok(!state.active_transients.some((e) => e.id === -winner));
  let week = (await f.call("finishedWeeks", { weeks: 1 })).result.weeks[0];
  assert.equal(week.target.changed_during_week, true);
  assert.deepEqual(
    week.events.map((e) => [e.day, e.note]),
    [
      ["2026-03-23", "cut -> maintain"],
      ["2026-03-25", "gain -> maintain"],
      ["2026-03-25", "independent manual event"],
    ],
  );
  // Backdating a continuation changes the predecessor outside this week.
  await f.target("2026-03-22", "maintain");
  week = (await f.call("finishedWeeks", { weeks: 1 })).result.weeks[0];
  assert.ok(!week.events.some((e) => e.day === "2026-03-23"));
  assert.equal(week.events[0].note, "gain -> maintain");
});

test("expenditure uses completed weeks, holds stale estimates and damps only effective transients", async (t) => {
  const f = await fixture(t);
  await f.run(
    "INSERT INTO bodyfat_estimates(day, percent, method) VALUES ('2026-03-01', 150, 'visual')",
  );
  for (let i = 0; i < 28; i++) {
    const day = addDays("2026-03-02", i);
    await f.weight(day, 80);
    await f.intake(day, i < 21 ? 2000 : 4000, 150);
  }
  await f.target("2025-01-01", "cut");
  await f.target("2026-03-25", "maintain");
  let state = (await f.call("nutritionState")).result;
  assert.equal(state.expenditure.status, "damped");
  assert.equal(state.expenditure.tdee_kcal, 2100);
  assert.equal(state.expenditure.as_of, "2026-03-29");
  await f.run(
    "UPDATE nutrition_targets SET phase_switch_suppressed = 1 WHERE effective_from = '2026-03-25'",
  );
  await f.target("2026-03-30", "gain");
  state = (await f.call("nutritionState")).result;
  assert.equal(state.expenditure.status, "ok");
  assert.equal(state.expenditure.tdee_kcal, 2667);
  assert.ok(state.active_transients.some((e) => e.day === "2026-03-30"));
  await f.run("DELETE FROM intake_entries WHERE day >= '2026-03-16'");
  state = (await f.call("nutritionState")).result;
  assert.equal(state.expenditure.status, "stale");
  assert.equal(state.expenditure.as_of, "2026-03-22");
  assert.equal(state.expenditure.tdee_kcal, 2000);
  state = (await f.call("nutritionState", { now: "2026-05-04T12:00:00Z" }))
    .result;
  assert.equal(state.expenditure.status, "insufficient_data");
  assert.equal(state.expenditure.as_of, null);
  assert.equal(state.expenditure.tdee_kcal, null);
});
