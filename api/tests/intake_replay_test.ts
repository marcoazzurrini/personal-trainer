import { assertEquals } from "@std/assert";
import d1, { database } from "./d1.ts";
import { intakeStore } from "../nutrition/intake.ts";
import { api, resetNutrition, uuid } from "./helpers.ts";

Deno.test("logIntake replays the stored meal day across Rome midnight", {
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  await resetNutrition();
  for (const name of ["Midnight A", "Midnight B"]) {
    assertEquals(
      (await api.post("/foods", {
        name,
        kcal_100g: 100,
        protein_100g: 25,
        carbs_100g: 0,
        fat_100g: 0,
        source: "label",
      })).status,
      201,
    );
  }
  assertEquals(
    (await api.post("/meals", {
      name: "Midnight meal",
      items: [{ food: "Midnight A", grams: 100 }, {
        food: "Midnight B",
        grams: 50,
      }],
    })).status,
    201,
  );

  // An injected clock controls calendar decisions; storage remains real D1.
  const db = d1();
  let now = new Date("2026-01-01T22:59:59Z");
  const { logIntake } = intakeStore(database, () => now);
  try {
    const request_id = uuid();
    const first = await logIntake({ meal: "Midnight meal", request_id });
    assertEquals(first.created, true);
    assertEquals(first.view.day, "2026-01-01");
    assertEquals(first.view.entries.length, 2);
    now = new Date("2026-01-01T23:00:01Z");
    const retry = await logIntake({ meal: "Midnight meal", request_id });
    assertEquals(retry, { created: false, view: first.view });
    for (const day of ["2026-01-02", "2099-01-01"]) {
      const changed = await api.post("/intake", {
        day,
        meal: "Midnight meal",
        request_id,
      });
      assertEquals(changed.status, 200);
      assertEquals(changed.body, JSON.parse(JSON.stringify(first.view)));
    }
    assertEquals((await api.get("/intake?day=2026-01-02")).body.entries, []);
    assertEquals(
      (await db`select count(*) as n from intake_entries`)[0].n,
      2,
    );
  } finally {
    await db.end();
  }
});
