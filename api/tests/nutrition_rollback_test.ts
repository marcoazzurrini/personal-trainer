import { assert, assertEquals } from "@std/assert";
import postgres from "postgres";
import { api, DB_URL, resetNutrition, today, uuid } from "./helpers.ts";

async function foods() {
  await resetNutrition();
  for (const name of ["Rollback oats", "Rollback rice"]) {
    assertEquals(
      (await api.post("/foods", {
        name,
        kcal_100g: 400,
        protein_100g: 10,
        carbs_100g: 90,
        fat_100g: 0,
        source: "label",
      })).status,
      201,
    );
  }
}

Deno.test("meal creation rolls back after a child insert, then the same request retries once", async () => {
  await foods();
  const input = {
    name: "Rollback breakfast",
    aliases: ["rollback breakfast alias"],
    request_id: uuid(),
    items: [{ food: "Rollback oats", grams: 40 }, {
      food: "Rollback rice",
      grams: 50,
    }],
  };
  const db = postgres(DB_URL);
  try {
    await db`create function test_meal_create_failure() returns trigger language plpgsql as $$
      begin
        if new.grams = 50 then
          if not exists (select 1 from meal_items where meal_id = new.meal_id and grams = 40)
             or not exists (select 1 from meal_aliases where meal_id = new.meal_id) then
            raise exception 'injection did not reach the second child';
          end if;
          raise exception 'injected child failure' using errcode = '23514', constraint = 'test_meal_create_failure';
        end if;
        return new;
      end $$`;
    await db`create trigger test_meal_create_failure before insert on meal_items
      for each row execute function test_meal_create_failure()`;
    const failed = await api.post("/meals", input);
    assertEquals(failed.status, 422);
    assert(failed.body.error.includes("test_meal_create_failure"));
    for (const table of ["meals", "meal_aliases", "meal_items"]) {
      assertEquals(
        (await db.unsafe(`select count(*)::int as n from ${table}`))[0].n,
        0,
      );
    }
    await db`drop trigger test_meal_create_failure on meal_items`;
    const saved = await api.post("/meals", input);
    assertEquals(saved.status, 201);
    assertEquals(saved.body.meal.items.length, 2);
    const replay = await api.post("/meals", input);
    assertEquals(replay.status, 200);
    assertEquals(replay.body, saved.body);
    assertEquals((await api.get("/meals")).body.meals.length, 1);
    assertEquals((await db`select count(*)::int as n from meal_items`)[0].n, 2);
    assertEquals(
      (await db`select count(*)::int as n from meal_aliases`)[0].n,
      1,
    );
  } finally {
    await db`drop trigger if exists test_meal_create_failure on meal_items`;
    await db`drop function if exists test_meal_create_failure()`;
    await db.end();
  }
});

Deno.test("meal replacement restores name, aliases and deleted items after a late failure", async () => {
  await foods();
  const created = await api.post("/meals", {
    name: "Original breakfast",
    aliases: ["original breakfast alias"],
    items: [{ food: "Rollback oats", grams: 70 }],
  });
  assertEquals(created.status, 201);
  const path = `/meals/${created.body.meal.id}`;
  const before = (await api.get(path)).body;
  const input = {
    name: "Changed breakfast",
    aliases: ["changed breakfast alias"],
    items: [{ food: "Rollback oats", grams: 40 }, {
      food: "Rollback rice",
      grams: 50,
    }],
  };
  const db = postgres(DB_URL);
  try {
    await db`create function test_meal_replace_failure() returns trigger language plpgsql as $$
      begin
        if new.grams = 50 then
          if not exists (select 1 from meals where id = new.meal_id and name = 'Changed breakfast')
             or not exists (select 1 from meal_items where meal_id = new.meal_id and grams = 40)
             or exists (select 1 from meal_items where meal_id = new.meal_id and grams = 70) then
            raise exception 'injection did not reach the replacement';
          end if;
          raise exception 'injected replacement failure' using errcode = '23514', constraint = 'test_meal_replace_failure';
        end if;
        return new;
      end $$`;
    await db`create trigger test_meal_replace_failure before insert on meal_items
      for each row execute function test_meal_replace_failure()`;
    const failed = await api.patch(path, input);
    assertEquals(failed.status, 422);
    assert(failed.body.error.includes("test_meal_replace_failure"));
    assertEquals((await api.get(path)).body, before);
    assertEquals((await api.get("/meals/changed breakfast alias")).status, 422);
    await db`drop trigger test_meal_replace_failure on meal_items`;
    const saved = await api.patch(path, input);
    assertEquals(saved.status, 200);
    assertEquals(saved.body.meal.name, input.name);
    assertEquals(
      saved.body.meal.items.map((i: { grams: number }) => i.grams).sort(),
      [40, 50],
    );
    assertEquals(
      (await api.get("/meals/changed breakfast alias")).body.meal.id,
      created.body.meal.id,
    );
  } finally {
    await db`drop trigger if exists test_meal_replace_failure on meal_items`;
    await db`drop function if exists test_meal_replace_failure()`;
    await db.end();
  }
});

Deno.test("food correction rolls back the food and historical intake together", async () => {
  await foods();
  for (const grams of [100, 200]) {
    assertEquals(
      (await api.post("/intake", {
        day: today(),
        food: "Rollback oats",
        grams,
      })).status,
      201,
    );
  }
  const path = "/foods/Rollback oats";
  const before = (await api.get(path)).body;
  const db = postgres(DB_URL);
  const snapshot =
    async () => [...await db`select * from intake_entries order by id`];
  try {
    const intake = await snapshot();
    await db`create function test_food_correct_failure() returns trigger language plpgsql as $$
      begin
        if not exists (select 1 from foods where id = new.food_id and kcal_100g = 360) then
          raise exception 'injection did not reach the food update';
        end if;
        raise exception 'injected historical correction failure' using errcode = '23514', constraint = 'test_food_correct_failure';
      end $$`;
    await db`create trigger test_food_correct_failure before update on intake_entries
      for each row execute function test_food_correct_failure()`;
    const input = { kcal_100g: 360, carbs_100g: 80 };
    const failed = await api.patch(path, input);
    assertEquals(failed.status, 422);
    assert(failed.body.error.includes("test_food_correct_failure"));
    assertEquals((await api.get(path)).body, before);
    assertEquals(await snapshot(), intake);
    await db`drop trigger test_food_correct_failure on intake_entries`;
    const saved = await api.patch(path, input);
    assertEquals(saved.status, 200);
    assertEquals(saved.body.corrected_entries.count, 2);
    assertEquals((await snapshot()).map((r) => Number(r.kcal)), [360, 720]);
    const replay = await api.patch(path, input);
    assertEquals(replay.status, 200);
    assertEquals(replay.body.corrected_entries.count, 0);
  } finally {
    await db`drop trigger if exists test_food_correct_failure on intake_entries`;
    await db`drop function if exists test_food_correct_failure()`;
    await db.end();
  }
});
