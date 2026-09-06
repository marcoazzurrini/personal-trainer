import { assert, assertEquals } from "@std/assert";
import { api, resetNutrition, uuid } from "./helpers.ts";

Deno.test("logIntake refuses quantities belonging to another branch before writing", async () => {
  await resetNutrition();
  assertEquals(
    (await api.post("/foods", {
      name: "Branch food",
      kcal_100g: 100,
      protein_100g: 25,
      carbs_100g: 0,
      fat_100g: 0,
      grams_per_unit: 20,
      source: "label",
    })).status,
    201,
  );
  assertEquals(
    (await api.post("/meals", {
      name: "Branch meal",
      items: [{ food: "Branch food", grams: 100 }],
    })).status,
    201,
  );

  for (const value of [0, 2]) {
    for (const branch of [{ meal: "Branch meal" }, { adhoc_kcal: 100 }]) {
      for (const field of ["grams", "units"]) {
        const refused = await api.post("/intake", {
          ...branch,
          [field]: value,
        });
        assertEquals(refused.status, 422);
        assert(refused.body.error.includes(`"${field}"`));
        assert(refused.body.error.includes('"food"'));
      }
    }
    for (
      const branch of [{ meal: "Branch meal" }, {
        food: "Branch food",
        grams: 100,
      }]
    ) {
      const refused = await api.post("/intake", {
        ...branch,
        adhoc_protein_g: value,
      });
      assertEquals(refused.status, 422);
      assert(refused.body.error.includes('"adhoc_kcal"'));
    }
  }
  assertEquals((await api.get("/intake")).body.entries, []);

  for (
    const [input, grams, protein] of [
      [
        {
          meal: "Branch meal",
          scale: 0.5,
          grams: null,
          units: null,
          adhoc_protein_g: null,
        },
        50,
        12.5,
      ],
      [
        { food: "Branch food", grams: 40, units: null, adhoc_protein_g: null },
        40,
        10,
      ],
      [{ food: "Branch food", units: 2, grams: null }, 40, 10],
      [
        { adhoc_kcal: 100, adhoc_protein_g: 0, grams: null, units: null },
        null,
        0,
      ],
    ] as const
  ) {
    const request_id = uuid();
    const first = await api.post("/intake", {
      ...input,
      note: request_id,
      request_id,
    });
    assertEquals(first.status, 201);
    const entry = first.body.entries.find((e: { note: string }) =>
      e.note === request_id
    );
    assertEquals(entry.grams, grams);
    assertEquals(entry.protein_g, protein);
    // A spent ID replays before branch validation, even with changed fields.
    const replay = await api.post("/intake", {
      meal: "Branch meal",
      units: 0,
      request_id,
    });
    assertEquals(replay.status, 200);
    assertEquals(replay.body, first.body);
  }
});
