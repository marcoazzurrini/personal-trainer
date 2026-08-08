import { assert, assertEquals } from "@std/assert";
import {
  api,
  ensureCatalogue,
  lastMonday,
  resetNutrition,
  resetTraining,
  today,
  uuid,
} from "./helpers.ts";

// A refused write leaves nothing behind.
//
// Every case here is a call that creates a parent row and then its children in
// the same transaction, where a child is what fails. The parent is already
// inserted by then, so the only thing standing between a 409 and a half-built
// row is the rollback — and a half-built row is worse than the error, because
// it is indistinguishable from a real one afterwards. A meal with no items
// silently logs nothing; an orphan mesocycle occupies the "one active" slot and
// blocks the next create with a conflict about a plan that was never made.
//
// The failure has to come from the database rather than a validator, or the
// test proves only that validation runs first. Colliding aliases and a CHECK
// on a set both do that: they are unreachable until the insert is attempted.

Deno.test("a food that cannot take its alias is not created", async () => {
  await resetNutrition();
  await api.post("/foods", {
    name: "Skyr",
    kcal_100g: 63,
    protein_100g: 11,
    carbs_100g: 4,
    fat_100g: 0.2,
    source: "label",
    aliases: ["lo yogurt islandese"],
    request_id: uuid(),
  });

  // The food row inserts, then the alias collides on the global unique index.
  const { status, body } = await api.post("/foods", {
    name: "Icelandic Yoghurt",
    kcal_100g: 60,
    protein_100g: 10,
    carbs_100g: 4,
    fat_100g: 0.2,
    source: "label",
    aliases: ["lo yogurt islandese"],
    request_id: uuid(),
  });
  assertEquals(status, 409);
  assert(body.error.includes("alias"), body.error);

  // Without the rollback this is where a second yoghurt would be sitting,
  // aliasless and invisible, splitting the food's history the moment either
  // one gets logged.
  assertEquals((await api.get("/foods/Icelandic Yoghurt")).status, 422);
  const all = await api.get("/foods");
  assertEquals(all.body.foods.length, 1);
});

Deno.test("a meal that cannot take its alias is not created", async () => {
  await resetNutrition();
  await api.post("/foods", {
    name: "Oats",
    kcal_100g: 379,
    protein_100g: 13,
    carbs_100g: 68,
    fat_100g: 6.5,
    source: "usda",
    request_id: uuid(),
  });
  await api.post("/meals", {
    name: "Colazione",
    aliases: ["la solita colazione"],
    items: [{ food: "Oats", grams: 80 }],
    request_id: uuid(),
  });

  const { status } = await api.post("/meals", {
    name: "Colazione due",
    aliases: ["la solita colazione"],
    items: [{ food: "Oats", grams: 100 }],
    request_id: uuid(),
  });
  assertEquals(status, 409);

  // A meal row with items but no alias would be the worst outcome: it exists,
  // it is loggable, and the word Marco actually says still points elsewhere.
  const meals = await api.get("/meals");
  assertEquals(meals.body.meals.length, 1);
  assertEquals((await api.get("/meals/Colazione due")).status, 422);
});

Deno.test("a session whose sets break a rule is not created", async (t) => {
  await resetTraining();
  await ensureCatalogue();
  const block = await api.post("/blocks", {
    name: "Atomicity block",
    goal: "testing",
    started_on: lastMonday(),
  });
  await api.post("/mesocycles", {
    block_id: block.body.block.id,
    name: "Meso",
    intent: "testing",
    planned_weeks: 4,
    sessions_per_week: 3,
    started_on: lastMonday(),
    exercises: [{ exercise: "squat", role: "main", priority: 1 }],
  });

  await t.step("effort on a warmup is refused by the database", async () => {
    // Not caught by parseNewSet — effort is legal on a set, and the rule that
    // warmups do not carry it lives in a CHECK. So the session row and the
    // first set are already inserted when the second one fails, which is
    // exactly the shape this suite is about.
    const { status, body } = await api.post("/sessions", {
      date: today(),
      rationale: "one good set and one impossible one",
      sets: [
        { exercise: "squat", weight_kg: 100, reps: 5, effort: "hard" },
        {
          exercise: "squat",
          kind: "warmup",
          weight_kg: 60,
          reps: 5,
          effort: "easy",
        },
      ],
    });
    assertEquals(status, 422);
    assert(body.error.includes("Warmup"), body.error);
  });

  await t.step("no session, and no orphan set, survives it", async () => {
    const sessions = await api.get("/sessions?limit=100");
    assertEquals(sessions.body.sessions.length, 0);
    // The squat set that did insert would otherwise still be counted: it is a
    // performed working set, so it would show up in the volume view as a
    // session's worth of work that never happened.
    const history = await api.get("/exercises/squat/history");
    assertEquals(history.body.sets.length, 0);
  });
});

Deno.test("a mesocycle naming an unknown exercise is not created", async () => {
  await resetTraining();
  await ensureCatalogue();
  const block = await api.post("/blocks", {
    name: "Orphan block",
    goal: "testing",
    started_on: lastMonday(),
  });

  const { status, body } = await api.post("/mesocycles", {
    block_id: block.body.block.id,
    name: "Meso with a typo in it",
    intent: "testing",
    planned_weeks: 4,
    sessions_per_week: 3,
    started_on: lastMonday(),
    exercises: [
      { exercise: "squat", role: "main", priority: 1 },
      { exercise: "zercher yoke walk", role: "accessory", priority: 2 },
    ],
  });
  assertEquals(status, 422);
  assert(body.error.includes("Unknown exercise"), body.error);

  // "Only one active mesocycle" is a unique index, so an orphan here does not
  // just sit there — it takes the slot, and every retry after the typo is
  // fixed comes back as a conflict about a mesocycle nobody planned.
  const current = await api.get("/mesocycles/current");
  assertEquals(current.status, 404);
});
