import { assert, assertEquals } from "@std/assert";
import postgres from "postgres";
import {
  api,
  type ApiResponse,
  DB_URL,
  resetNutrition,
  today,
  uuid,
} from "./helpers.ts";

Deno.test("a meal retry arriving mid-write cannot expose or duplicate part of the meal", async () => {
  await resetNutrition();
  const ids: number[] = [];
  for (const name of ["Retry rice", "Retry oats"]) {
    const saved = await api.post("/foods", {
      name,
      kcal_100g: 400,
      protein_100g: 10,
      carbs_100g: 90,
      fat_100g: 0,
      source: "label",
    });
    assertEquals(saved.status, 201);
    ids.push(saved.body.food.id);
  }
  const meal = await api.post("/meals", {
    name: "Retry lunch",
    items: [{ food: ids[0], grams: 100 }, { food: ids[1], grams: 50 }],
  });
  assertEquals(meal.status, 201);
  const input = { meal: meal.body.meal.id, day: today(), request_id: uuid() };
  const db = postgres(DB_URL);
  const gate = await db.reserve();
  let first: Promise<ApiResponse> | undefined;
  let retry: Promise<ApiResponse> | undefined;
  const blocked = async (count: number) => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const [{ n }] = await db`select count(*)::int as n from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock'
          and query like '%insert into intake_entries%'`;
      if (n >= count) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(
      `Expected ${count} intake writes blocked at the retry boundary.`,
    );
  };
  try {
    // Hold the first insertion after it has written but before it commits.
    // The retry must then block on that uncommitted unique key, not merely
    // happen to run at roughly the same time as the original request.
    await db`create function test_intake_retry_gate() returns trigger language plpgsql as $$
      begin perform pg_advisory_xact_lock(90255); return new; end $$`;
    await db`create trigger test_intake_retry_gate after insert on intake_entries
      for each row execute function test_intake_retry_gate()`;
    await gate`select pg_advisory_lock(90255)`;
    first = api.post("/intake", input);
    await blocked(1);
    retry = api.post("/intake", input);
    await blocked(2);
    const during = await api.get(`/intake?day=${today()}`);
    assertEquals(during.status, 200);
    assertEquals(during.body.entries, []);
    await gate`select pg_advisory_unlock(90255)`;
    const [created, collision] = await Promise.all([first, retry]);
    assertEquals(created.status, 201);
    assertEquals(collision.status, 409);
    assert(collision.body.error.includes("request_id"), collision.body.error);
    assertEquals(created.body.entries.length, 2);
    assertEquals(
      created.body.entries.map((e: { grams: number }) => e.grams).sort((
        a: number,
        b: number,
      ) => a - b),
      [50, 100],
    );
    assertEquals(created.body.totals.kcal, 600);
    const replay = await api.post("/intake", input);
    assertEquals(replay.status, 200);
    assertEquals(replay.body, created.body);
    assertEquals(
      (await db`select count(*)::int as n from intake_entries where request_id = ${input.request_id}`)[
        0
      ].n,
      2,
    );
  } finally {
    await gate`select pg_advisory_unlock_all()`;
    await Promise.allSettled([first, retry].filter((p) => p !== undefined));
    gate.release();
    await db`drop trigger if exists test_intake_retry_gate on intake_entries`;
    await db`drop function if exists test_intake_retry_gate()`;
    await db.end();
  }
});
