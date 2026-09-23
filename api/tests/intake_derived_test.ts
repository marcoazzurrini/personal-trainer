import { assert, assertEquals } from "@std/assert";
import d1 from "./d1.ts";
import { api, daysAgo, resetNutrition, today } from "./helpers.ts";

async function seed() {
  await resetNutrition();
  const saved = await api.post("/foods", {
    name: "Derived yogurt",
    kcal_100g: 100,
    protein_100g: 10,
    carbs_100g: 15,
    fat_100g: 0,
    source: "label",
  });
  assertEquals(saved.status, 201);
  const meal = await api.post("/meals", {
    name: "Derived breakfast",
    items: [{ food: "Derived yogurt", grams: 200 }],
  });
  assertEquals(meal.status, 201);
  const logged = await api.post("/intake", { meal: "Derived breakfast" });
  assertEquals(logged.status, 201);
  return logged.body.entries[0].id as number;
}

Deno.test("derived intake preserves the eaten recipe while correcting all daily readers", async () => {
  const id = await seed();
  const db = d1();
  try {
    const [stored] = await db`select * from intake_entries where id = ${id}`;
    assertEquals(stored.kcal, null);
    assertEquals(stored.protein_g, null);
    assertEquals(stored.food_macro_revision, null);
    assertEquals(
      (await api.patch("/meals/Derived breakfast", {
        items: [{ food: "Derived yogurt", grams: 150 }],
      })).status,
      200,
    );
    assertEquals(
      (await api.patch("/foods/Derived yogurt", {
        kcal_100g: 80,
        protein_100g: 8,
        carbs_100g: 12,
      })).status,
      200,
    );
    const day = (await api.get("/intake")).body;
    assertEquals(day.entries[0].grams, 200);
    assertEquals(day.entries[0].kcal, 160);
    assertEquals(day.entries[0].protein_g, 16);
    assertEquals(day.entries[0].fiber_g, null);
    const [daily] = await db`select * from daily_intake where day = ${today()}`;
    assertEquals(daily.kcal, 160);
    assertEquals(daily.protein_g, 16);
    assertEquals(daily.protein_entries, 1);
    assertEquals(
      [...(await db`select * from intake_entries where id = ${id}`)],
      [stored],
    );
  } finally {
    await db.end();
  }
});

Deno.test("food corrections expire overrides without reviving them in later partial edits", async () => {
  const id = await seed();
  const path = `/intake/${id}`;
  const overridden = await api.patch(path, { kcal: 250, protein_g: 30 });
  assertEquals(overridden.status, 200);
  assertEquals(overridden.body.entries[0].kcal, 250);
  // Metadata and identical macro retries do not invalidate an override.
  assertEquals(
    (await api.patch("/foods/Derived yogurt", {
      source_note: "Checked label",
      kcal_100g: 100,
    })).body.corrected_entries.count,
    0,
  );
  assertEquals((await api.get("/intake")).body.entries[0].kcal, 250);
  const moved = await api.patch(path, { day: daysAgo(1), note: "Moved only" });
  assertEquals(moved.body.entries[0].kcal, 250);
  assertEquals(
    (await api.patch("/foods/Derived yogurt", {
      kcal_100g: 80,
      protein_100g: 8,
      carbs_100g: 12,
    })).status,
    200,
  );
  const fresh = await api.patch(path, { protein_g: 17 });
  assertEquals(fresh.status, 200);
  assertEquals(fresh.body.entries[0].protein_g, 17);
  assertEquals(
    fresh.body.entries[0].kcal,
    160,
    "do not revive the expired 250 kcal",
  );
  assertEquals(fresh.body.entries[0].carbs_g, 24);
  assertEquals(fresh.body.entries[0].fiber_g, null);
  const rescaled = await api.patch(path, { grams: 100 });
  assertEquals(rescaled.body.entries[0].protein_g, 8);
  assertEquals(rescaled.body.entries[0].kcal, 80);
  const db = d1();
  try {
    const [stored] = await db`select * from intake_entries where id = ${id}`;
    assertEquals(stored.food_macro_revision, null);
    assertEquals(stored.kcal, null);
  } finally {
    await db.end();
  }
});

Deno.test("storage-rounded food retries keep overrides until a stored macro actually changes", async () => {
  const id = await seed();
  await api.patch(`/intake/${id}`, { kcal: 250 });
  const retry = await api.patch("/foods/Derived yogurt", {
    kcal_100g: 100.01,
    protein_100g: 10.04,
    fiber_100g: null,
  });
  assertEquals(retry.status, 200);
  assertEquals(retry.body.corrected_entries.count, 0);
  assertEquals((await api.get("/intake")).body.entries[0].kcal, 250);

  // Postgres rounds decimal half steps, not JavaScript binary approximations.
  const changed = await api.patch("/foods/Derived yogurt", {
    kcal_100g: 80.05,
  });
  assertEquals(changed.status, 200);
  assertEquals(changed.body.food.kcal_100g, 80.1);
  assertEquals(changed.body.corrected_entries.count, 1);
  assertEquals((await api.get("/intake")).body.entries[0].kcal, 160.2);
});

Deno.test("overlapping intake corrections preserve omitted macros and use the latest grams", async () => {
  const db = d1();
  const pending: Array<ReturnType<typeof api.patch>> = [];
  async function overlap(id: number, first: object, second: object) {
    pending.length = 0;
    pending.push(
      api.patch(`/intake/${id}`, first),
      api.patch(`/intake/${id}`, second),
    );
    for (const result of await Promise.all(pending)) {
      assertEquals(result.status, 200);
    }
    return (await api.get("/intake")).body.entries[0];
  }
  try {
    let id = await seed();
    const macros = await overlap(id, { kcal: 250 }, { protein_g: 30 });
    assertEquals(macros.kcal, 250);
    assertEquals(macros.protein_g, 30);

    id = await seed();
    const rescaled = await overlap(id, { grams: 100 }, { protein_g: 18 });
    assertEquals(rescaled.grams, 100);
    assertEquals(rescaled.kcal, 100);
    assertEquals(rescaled.carbs_g, 15);
    assert([10, 18].includes(rescaled.protein_g));
  } finally {
    await Promise.allSettled(pending);
    await db.end();
  }
});

Deno.test("ad-hoc estimates and unknown protein are independent of food corrections", async () => {
  await seed();
  const logged = await api.post("/intake", { adhoc_kcal: 500 });
  assertEquals(logged.status, 201);
  const entry = logged.body.entries.find((e: { food_id: number | null }) =>
    e.food_id === null
  );
  assertEquals(entry.protein_g, null);
  assertEquals(
    (await api.patch("/foods/Derived yogurt", {
      kcal_100g: 80,
      protein_100g: 8,
      carbs_100g: 12,
    })).status,
    200,
  );
  const day = (await api.get("/intake")).body;
  assertEquals(day.totals.kcal, 660);
  const db = d1();
  try {
    const [daily] = await db`select * from daily_intake where day = ${today()}`;
    assertEquals(daily.entries, 2);
    assertEquals(daily.protein_entries, 1);
  } finally {
    await db.end();
  }
});
