import { assert, assertEquals } from "@std/assert";
import postgres from "postgres";
import {
  api,
  daysAgo,
  DB_URL,
  resetNutrition,
  seedWeighIns,
  today,
  uuid,
} from "./helpers.ts";

Deno.test("setTarget rolls back a failed automatic event and retries exactly once", async () => {
  await resetNutrition();
  await seedWeighIns([daysAgo(1)], 80);
  const base = {
    goal: "cut",
    rate_pct_bw_week: -0.5,
    kcal_target: 2200,
    protein_g_target: 180,
    decision: "Atomic baseline",
    effective_from: today(),
  };
  const baseline = await api.post("/nutrition-targets", base);
  assertEquals(baseline.status, 201);
  assertEquals(baseline.body.phase_switch_registered, false);
  const switchInput = {
    ...base,
    goal: "maintain",
    rate_pct_bw_week: 0,
    decision: "Atomic switch",
    request_id: uuid(),
  };
  // DB_URL came through helpers' disposable DB/API identity checks before
  // token setup. This trigger exists only in that freshly owned database.
  const db = postgres(DB_URL);
  try {
    await db`create function test_target_event_failure() returns trigger language plpgsql as $$
      begin
        if not exists (select 1 from nutrition_targets where decision = 'Atomic switch') then
          raise exception 'failure injection did not reach the target insert';
        end if;
        raise exception 'injected failure after target insert' using errcode = '23514', constraint = 'test_target_event_failure';
      end $$`;
    await db`create trigger test_target_event_failure before insert on nutrition_events
      for each row execute function test_target_event_failure()`;
    const failed = await api.post("/nutrition-targets", switchInput);
    assertEquals(failed.status, 422);
    assert(failed.body.error.includes("test_target_event_failure"));
    assertEquals((await api.get("/nutrition-targets")).body.targets, [
      baseline.body.target,
    ]);
    assertEquals((await api.get("/nutrition-events")).body.events, []);
    await db`drop trigger test_target_event_failure on nutrition_events`;
    const retry = await api.post("/nutrition-targets", switchInput);
    assertEquals(retry.status, 201);
    assertEquals(retry.body.phase_switch_registered, true);
    assertEquals((await api.get("/nutrition-targets")).body.targets.length, 2);
    const events = (await api.get("/nutrition-events")).body.events;
    assertEquals(events.length, 1);
    assertEquals(events[0].note, "cut -> maintain");
    const replay = await api.post("/nutrition-targets", switchInput);
    assertEquals(replay.status, 200);
    assertEquals(replay.body, { target: retry.body.target });
    assertEquals((await api.get("/nutrition-events")).body.events, events);
    const sameGoal = await api.post("/nutrition-targets", {
      ...switchInput,
      request_id: uuid(),
    });
    assertEquals(sameGoal.status, 201);
    assertEquals(sameGoal.body.phase_switch_registered, false);
    assertEquals((await api.get("/nutrition-events")).body.events, events);

    const gain = {
      ...base,
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
    assertEquals(
      raced.find((r) => r.status === 201)!.body.phase_switch_registered,
      true,
    );
    assertEquals((await api.get("/nutrition-targets")).body.targets.length, 4);
    assertEquals((await api.get("/nutrition-events")).body.events.length, 2);
    assertEquals((await api.post("/nutrition-targets", gain)).status, 200);

    // Widen the overlap after the previous-target read, not before it. Without
    // writer serialization both distinct calls can declare gain -> maintain.
    await db`create function test_target_delay() returns trigger language plpgsql as $$
      begin perform pg_sleep(0.1); return new; end $$`;
    await db`create trigger test_target_delay before insert on nutrition_targets
      for each row execute function test_target_delay()`;
    const distinct = await Promise.all([
      api.post("/nutrition-targets", { ...switchInput, request_id: uuid() }),
      api.post("/nutrition-targets", { ...switchInput, request_id: uuid() }),
    ]);
    assertEquals(distinct.map((r) => r.status), [201, 201]);
    assertEquals(distinct.map((r) => r.body.phase_switch_registered).sort(), [
      false,
      true,
    ]);
    assertEquals((await api.get("/nutrition-events")).body.events.length, 3);
  } finally {
    await db`drop trigger if exists test_target_event_failure on nutrition_events`;
    await db`drop function if exists test_target_event_failure()`;
    await db`drop trigger if exists test_target_delay on nutrition_targets`;
    await db`drop function if exists test_target_delay()`;
    await db.end();
  }
});
