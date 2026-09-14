import { assertEquals } from "@std/assert";
import fc from "fast-check";
import { api, daysAgo, resetNutrition, today, uuid } from "./helpers.ts";

Deno.test("bodyweight retries compare at storage precision and normalize timestamp offsets", async () => {
  await resetNutrition();
  for (
    const [value, stored] of [[82.344, 82.34], [82.345, 82.35], [82.456, 82.46]]
  ) {
    const input = {
      value_kg: value,
      measured_at: `${daysAgo(1)}T08:00:00+02:00`,
      source: `precision-${value}`,
    };
    const first = await api.post("/bodyweight", input);
    assertEquals(first.status, 201);
    assertEquals(first.body.bodyweight.value_kg, stored);
    for (const value_kg of [value, stored]) {
      const retry = await api.post("/bodyweight", {
        ...input,
        value_kg,
        measured_at: `${daysAgo(1)}T06:00:00Z`,
      });
      assertEquals(retry.status, 200);
      assertEquals(retry.body, first.body);
    }
    assertEquals(
      (await api.post("/bodyweight", { ...input, value_kg: stored + 0.02 }))
        .status,
      409,
    );
  }
  assertEquals((await api.get("/bodyweight")).body.bodyweight.length, 3);
});

Deno.test("bodyfat retries compare at storage precision without hiding different readings", async () => {
  await resetNutrition();
  let age = 1;
  for (
    const [percent, stored] of [[14.54, 14.5], [14.55, 14.6], [14.56, 14.6]]
  ) {
    const input = {
      percent,
      day: daysAgo(age++),
      method: "bia",
      request_id: uuid(),
    };
    const first = await api.post("/bodyfat", input);
    assertEquals(first.status, 201);
    assertEquals(first.body.bodyfat_estimate.percent, stored);
    for (const value of [percent, stored]) {
      const retry = await api.post("/bodyfat", { ...input, percent: value });
      assertEquals(retry.status, 200);
      assertEquals(retry.body, first.body);
    }
    assertEquals(
      (await api.post("/bodyfat", { ...input, percent: stored + 0.2 })).status,
      409,
    );
  }
  assertEquals((await api.get("/bodyfat")).body.bodyfat_estimates.length, 3);
});

Deno.test("stored intake quantities determine macros on create, retry and correction", async () => {
  // Generate hundredths, not values already rounded to the database scale.
  // Each attempt owns its records, including fast-check shrinking attempts.
  await fc.assert(
    fc.asyncProperty(
      fc.integer({ min: 10, max: 100_000 }),
      async (hundredths) => {
        await resetNutrition();
        assertEquals(
          (await api.post("/foods", {
            name: "Precision food",
            kcal_100g: 400,
            protein_100g: 10,
            carbs_100g: 90,
            fat_100g: 0,
            source: "label",
            grams_per_unit: 1,
          })).status,
          201,
        );
        const input = {
          food: "Precision food",
          grams: hundredths / 100,
          day: today(),
          request_id: uuid(),
        };
        const created = await api.post("/intake", input);
        assertEquals(created.status, 201);
        assertEquals(created.body.entries.length, 1);
        const id = created.body.entries[0].id;
        const check = (
          entry: {
            grams: number;
            kcal: number;
            protein_g: number;
            carbs_g: number;
            fat_g: number;
            fiber_g: null;
          },
          amount: number,
        ) => {
          // Integer decimal oracle, independent of the production rounding helper.
          const tenths = Math.floor((amount + 5) / 10);
          const scaled = (per100g: number) =>
            Number((BigInt(tenths) * BigInt(per100g * 10) + 500n) / 1000n) / 10;
          assertEquals(entry.grams, tenths / 10);
          assertEquals(entry.kcal, scaled(400));
          assertEquals(entry.protein_g, scaled(10));
          assertEquals(entry.carbs_g, scaled(90));
          assertEquals(entry.fat_g, 0);
          assertEquals(entry.fiber_g, null);
        };
        check(created.body.entries[0], hundredths);
        const replay = await api.post("/intake", input);
        assertEquals(replay.status, 200);
        assertEquals(replay.body, created.body);
        const corrected = await api.patch(`/intake/${id}`, {
          grams: (hundredths + 7) / 100,
        });
        assertEquals(corrected.status, 200);
        assertEquals(corrected.body.entries.length, 1);
        check(corrected.body.entries[0], hundredths + 7);
        const again = await api.patch(`/intake/${id}`, {
          grams: (hundredths + 7) / 100,
        });
        assertEquals(again.status, 200);
        assertEquals(again.body, corrected.body);
      },
    ),
    { numRuns: 30, examples: [[104], [105], [106], [150], [1615]] },
  );
});
