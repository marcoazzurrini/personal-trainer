import { assert, assertEquals } from "@std/assert";
import d1 from "./d1.ts";
import { api, resetNutrition, today, uuid } from "./helpers.ts";

Deno.test("concurrent meal retries cannot expose or duplicate part of the meal", async () => {
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
  const db = d1();
  try {
    // D1 batches cannot be paused with connection locks. Race real HTTP
    // requests and reads instead; every visible state must be a whole meal.
    const [first, retry, ...reads] = await Promise.all([
      api.post("/intake", input),
      api.post("/intake", input),
      ...Array.from({ length: 4 }, () => api.get(`/intake?day=${today()}`)),
    ]);
    assertEquals([first, retry].filter((r) => r.status === 201).length, 1);
    assert([first, retry].every((r) => [200, 201, 409].includes(r.status)));
    const created = first.status === 201 ? first : retry;
    const collision = first.status === 201 ? retry : first;
    if (collision.status === 200) {
      assertEquals(collision.body, created.body);
    } else {
      assert(collision.body.error.includes("request_id"), collision.body.error);
    }
    for (const read of reads) {
      assertEquals(read.status, 200);
      assert([0, 2].includes(read.body.entries.length));
      if (read.body.entries.length === 2) {
        assertEquals(
          read.body.entries.map((e: { id: number }) => e.id).sort(),
          created.body.entries.map((e: { id: number }) => e.id).sort(),
        );
      }
    }
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
      (await db`select count(*) as n from intake_entries where request_id = ${input.request_id}`)[
        0
      ].n,
      2,
    );
    assertEquals(
      (await api.get(`/intake?day=${today()}`)).body.entries.length,
      2,
    );
  } finally {
    await db.end();
  }
});
