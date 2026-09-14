import { assert, assertEquals } from "@std/assert";
import postgres from "postgres";
import {
  api,
  daysBefore,
  DB_URL,
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
  // DB_URL passed the disposable DB/API identity checks in helpers. An event
  // writer that fails must no longer stop a target being saved.
  const db = postgres(DB_URL);
  try {
    await db`create function test_target_event_failure() returns trigger language plpgsql as $$
      begin
        raise exception 'target writes must not insert nutrition_events' using errcode = '23514', constraint = 'test_target_event_failure';
      end $$`;
    await db`create trigger test_target_event_failure before insert on nutrition_events
      for each row execute function test_target_event_failure()`;

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
    await db`drop trigger if exists test_target_event_failure on nutrition_events`;
    await db`drop function if exists test_target_event_failure()`;
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
  const db = postgres(DB_URL);
  const [original] = await db<{ definition: string }[]>`
    select pg_get_viewdef('nutrition_goal_switches'::regclass) as definition`;
  try {
    await db`create function test_target_response_failure() returns boolean language plpgsql as $$
      begin
        raise exception 'injected failure reading the inserted target switch' using errcode = '23514', constraint = 'test_target_response_failure';
      end $$`;
    // The predicate can run only for a derived switch. The baseline has none;
    // the newly inserted maintain target must be visible before this fails.
    await db.unsafe(`create or replace view nutrition_goal_switches as
      select * from (${original.definition.replace(/;\s*$/, "")}) switches
      where test_target_response_failure()`);
    const failed = await api.post("/nutrition-targets", input);
    assertEquals(failed.status, 422);
    assert(failed.body.error.includes("test_target_response_failure"));
    assertEquals((await api.get("/nutrition-targets")).body.targets, [
      baseline.body.target,
    ]);
    await db.unsafe(
      `create or replace view nutrition_goal_switches as ${original.definition}`,
    );
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
    await db.unsafe(
      `create or replace view nutrition_goal_switches as ${original.definition}`,
    );
    await db`drop function if exists test_target_response_failure()`;
    await db.end();
  }
});
