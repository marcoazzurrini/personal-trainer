import { assert, assertEquals } from "@std/assert";
import d1, { batch } from "./d1.ts";
import {
  api,
  daysBefore,
  lastFinishedSunday,
  resetNutrition,
  seedWeighIns,
  uuid,
} from "./helpers.ts";

Deno.test("target retries and concurrent saves derive switches without event writes", async () => {
  await resetNutrition();
  const day = lastFinishedSunday();
  await seedWeighIns([day], 80);
  const base = {
    goal: "cut",
    rate_pct_bw_week: -0.5,
    kcal_target: 2200,
    protein_g_target: 180,
    decision: "Derived baseline",
    effective_from: daysBefore(day, 7),
  };
  const baseline = await api.post("/nutrition-targets", base);
  assertEquals(baseline.status, 201);
  assertEquals(baseline.body.phase_switch_registered, false);
  const switchInput = {
    ...base,
    goal: "maintain",
    rate_pct_bw_week: 0,
    effective_from: day,
    decision: "Derived switch",
    request_id: uuid(),
  };
  // A native trigger makes any accidental write of a derived event fail.
  const db = d1();
  try {
    await db`create trigger test_target_event_failure before insert on nutrition_events
      for each row begin
        select raise(abort, 'CHECK constraint failed: test_target_event_failure');
      end`;

    const saved = await api.post("/nutrition-targets", switchInput);
    assertEquals(saved.status, 201, saved.body.error);
    assertEquals(saved.body.phase_switch_registered, true);
    const events = (await api.get("/nutrition-events")).body.events;
    assertEquals(events.length, 1);
    assertEquals(events[0].id, -saved.body.target.id);
    assertEquals(events[0].note, "cut -> maintain");
    assertEquals((await db`select id from nutrition_events`).length, 0);

    const replay = await api.post("/nutrition-targets", switchInput);
    assertEquals(replay.status, 200);
    assertEquals(replay.body, { target: saved.body.target });
    assertEquals((await api.get("/nutrition-events")).body.events, events);

    const gain = {
      ...base,
      effective_from: day,
      goal: "gain",
      rate_pct_bw_week: 0.25,
      request_id: uuid(),
    };
    const raced = await Promise.all([
      api.post("/nutrition-targets", gain),
      api.post("/nutrition-targets", gain),
    ]);
    assertEquals(raced.filter((r) => r.status === 201).length, 1);
    assert(raced.every((r) => [200, 201, 409].includes(r.status)));
    assertEquals((await api.get("/nutrition-targets")).body.targets.length, 3);
    assertEquals((await api.post("/nutrition-targets", gain)).status, 200);

    // Concurrent same-date revisions cannot manufacture duplicate switches.
    const distinct = await Promise.all([
      api.post("/nutrition-targets", { ...switchInput, request_id: uuid() }),
      api.post("/nutrition-targets", { ...switchInput, request_id: uuid() }),
    ]);
    assertEquals(distinct.map((r) => r.status), [201, 201]);
    const current = (await api.get("/nutrition-targets")).body.active;
    const finalEvents = (await api.get("/nutrition-events")).body.events;
    assertEquals(finalEvents.length, 1);
    assertEquals(finalEvents[0].id, -current.id);
    assertEquals(finalEvents[0].note, "cut -> maintain");
    assertEquals((await db`select id from nutrition_events`).length, 0);
  } finally {
    await db`drop trigger if exists test_target_event_failure`;
    await db.end();
  }
});

Deno.test("a failed switch response read rolls back the target and permits retry", async () => {
  await resetNutrition();
  const day = lastFinishedSunday();
  await seedWeighIns([day], 80);
  const base = {
    goal: "cut",
    rate_pct_bw_week: -0.5,
    kcal_target: 2200,
    protein_g_target: 180,
    decision: "Response failure baseline",
    effective_from: daysBefore(day, 1),
  };
  const baseline = await api.post("/nutrition-targets", base);
  assertEquals(baseline.status, 201);
  const input = {
    ...base,
    goal: "maintain",
    rate_pct_bw_week: 0,
    effective_from: day,
    request_id: uuid(),
  };
  const db = d1();
  const [original] = await db`
    select sql from sqlite_schema where type = 'view' and name = 'nutrition_goal_switches'`;
  assert(typeof original?.sql === "string");
  const definition = original.sql.replace(
    /^create\s+view\s+nutrition_goal_switches\s+as\s+/i,
    "",
  ).replace(/;\s*$/, "");
  assert(
    definition !== original.sql,
    "Expected the native goal-switch view definition.",
  );
  const restore = () =>
    batch([
      { sql: "drop view nutrition_goal_switches", params: [] },
      { sql: original.sql, params: [] },
    ]);
  try {
    // SQLite RAISE is only legal in triggers. A row-dependent malformed JSON
    // read instead fails the actual response SELECT, not the target INSERT.
    // The baseline has no switch; only the inserted target makes it fail.
    await batch([
      { sql: "drop view nutrition_goal_switches", params: [] },
      {
        sql: `create view nutrition_goal_switches as
          select * from (${definition}) switches
          where json_extract(case when id < 0 then 'test_target_response_failure' else 'true' end, '$')`,
        params: [],
      },
    ]);
    assertEquals(await db`select * from nutrition_goal_switches`, []);
    const failed = await api.post("/nutrition-targets", input);
    // A broken response query is an internal error, not invalid caller input.
    assertEquals(failed.status, 500);
    assert(failed.body.error.includes("Internal error"), failed.body.error);
    assertEquals(
      (await db`select count(*) as n from nutrition_targets where request_id = ${input.request_id}`)[
        0
      ].n,
      0,
    );
    await restore();
    assertEquals((await api.get("/nutrition-targets")).body.targets, [
      baseline.body.target,
    ]);
    assertEquals((await api.get("/nutrition-events")).body.events, []);
    const retry = await api.post("/nutrition-targets", input);
    assertEquals(retry.status, 201);
    assertEquals(retry.body.phase_switch_registered, true);
    assertEquals((await api.get("/nutrition-targets")).body.targets.length, 2);
    assertEquals((await api.get("/nutrition-events")).body.events.length, 1);
    const replay = await api.post("/nutrition-targets", input);
    assertEquals(replay.status, 200);
    assertEquals(replay.body, { target: retry.body.target });
  } finally {
    await restore();
    await db.end();
  }
});
