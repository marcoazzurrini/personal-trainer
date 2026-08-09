import { assert, assertEquals } from "@std/assert";
import {
  api,
  ensureCatalogue,
  lastMonday,
  resetTraining,
  today,
  uuid,
} from "./helpers.ts";

// The exercise correction surface, tier by tier. Foods had one from the
// start; exercises were write-once, and three documents plus one error
// message promised corrections the API never offered — a typo'd exercise
// lived forever, a wrong measure was "loud" and unrecoverable, and the
// promised reclassification between mesocycles had no endpoint. Each step
// here pins one tier: prose freely, identity fields only before the first
// set, the muscle classification only between plans, deletion only while
// nothing references the row.

Deno.test("the exercise correction surface", async (t) => {
  await resetTraining();
  await ensureCatalogue();
  // The catalogue outlives resetTraining, so scratch exercises from an
  // earlier run may still exist — now unreferenced, so the delete surface
  // itself is the cleanup. A 422 for "already gone" is fine.
  await api.delete("/exercises/Scratch Press");
  await api.delete("/exercises/Scratch Press Mk2");

  const created = await api.post("/exercises", {
    name: "Scratch Press",
    equipment: "barbell",
    measure: "load_reps",
    muscles: [
      { muscle: "chest", volume_factor: 1.0 },
      { muscle: "triceps", volume_factor: 0.5 },
    ],
  });
  assertEquals(created.status, 201, created.body.error);

  await t.step("prose fields change freely", async () => {
    const { status, body } = await api.patch("/exercises/Scratch Press", {
      equipment: "smith machine",
      notes: "the bar path is fixed, which is the point",
    });
    assertEquals(status, 200);
    assertEquals(body.exercise.equipment, "smith machine");
    assert(body.exercise.notes.includes("bar path"));
  });

  await t.step("a synonym becomes an alias after creation", async () => {
    // The docs have always promised "synonyms become aliases"; until this
    // surface existed that was only true at creation time.
    const added = await api.post("/exercises/Scratch Press/aliases", {
      alias: "panca scratch",
    });
    assertEquals(added.status, 201);
    assert(added.body.exercise.aliases.includes("panca scratch"));

    const removed = await api.delete(
      "/exercises/Scratch Press/aliases/panca scratch",
    );
    assertEquals(removed.status, 200);
    assertEquals(removed.body.exercise.aliases.length, 0);

    // Removing it again names the miss instead of pretending success.
    const again = await api.delete(
      "/exercises/Scratch Press/aliases/panca scratch",
    );
    assertEquals(again.status, 404);
  });

  await t.step("measure is fixable only until the first set", async () => {
    // The creation-mistake window: a wrong measure caught before anything is
    // logged is a one-call fix instead of a dead exercise.
    const fixed = await api.patch("/exercises/Scratch Press", {
      measure: "reps",
    });
    assertEquals(fixed.status, 200);
    assertEquals(fixed.body.exercise.measure, "reps");
    await api.patch("/exercises/Scratch Press", { measure: "load_reps" });

    const session = await api.post("/sessions", {
      date: today(),
      rationale: "one scratch set to freeze the measure",
      sets: [
        { exercise: "Scratch Press", weight_kg: 60, reps: 8, effort: "hard" },
      ],
    });
    assertEquals(session.status, 201, session.body.error);

    const frozen = await api.patch("/exercises/Scratch Press", {
      measure: "reps",
    });
    assertEquals(frozen.status, 422);
    assert(frozen.body.error.includes("frozen"), frozen.body.error);
    assert(frozen.body.error.includes("new exercise"), frozen.body.error);
  });

  await t.step("muscles replace whole, and only between plans", async () => {
    // A partial edit of a classification is ambiguous about the rows it
    // does not mention, so PATCH points at the PUT.
    const viaPatch = await api.patch("/exercises/Scratch Press", {
      muscles: [{ muscle: "chest", volume_factor: 1.0 }],
    });
    assertEquals(viaPatch.status, 422);
    assert(viaPatch.body.error.includes("PUT"), viaPatch.body.error);

    const block = await api.post("/blocks", {
      name: "Scratch block",
      goal: "testing the reclassification gate",
      started_on: lastMonday(),
    });
    const meso = await api.post("/mesocycles", {
      block_id: block.body.block.id,
      name: "Scratch meso",
      track: "hypertrophy",
      intent: "scratch",
      planned_weeks: 4,
      sessions_per_week: 2,
      started_on: lastMonday(),
      exercises: [{
        exercise: "Scratch Press",
        role: "accessory",
        priority: 5,
        weekly_dose: 6,
        weekly_dose_unit: "sets",
      }],
    });
    assertEquals(meso.status, 201, meso.body.error);

    // Mid-plan: refused, naming the plan and the rule.
    const midPlan = await api.put("/exercises/Scratch Press/muscles", {
      muscles: [{ muscle: "shoulders", volume_factor: 1.0 }],
    });
    assertEquals(midPlan.status, 409);
    assert(midPlan.body.error.includes("Scratch meso"), midPlan.body.error);
    assert(
      midPlan.body.error.includes("between mesocycles"),
      midPlan.body.error,
    );

    // Between plans: allowed, and the response says what it rewrote.
    await api.patch(`/mesocycles/${meso.body.mesocycle.id}`, {
      ended_on: today(),
    });
    const between = await api.put("/exercises/Scratch Press/muscles", {
      muscles: [
        { muscle: "chest", volume_factor: 1.0 },
        { muscle: "shoulders", volume_factor: 0.5 },
      ],
    });
    assertEquals(between.status, 200, between.body.error);
    assertEquals(between.body.exercise.muscles.length, 2);
    assert(between.body.note, "the retroactive consequence must be reported");
  });

  await t.step(
    "deleting a referenced exercise is refused with counts",
    async () => {
      const { status, body } = await api.delete("/exercises/Scratch Press");
      assertEquals(status, 409);
      assert(body.error.includes("1 logged set"), body.error);
      assert(body.error.includes("1 plan entry"), body.error);
    },
  );

  await t.step("an unreferenced duplicate deletes clean", async () => {
    await api.post("/exercises", {
      name: "Scratch Press Mk2",
      measure: "load_reps",
      request_id: uuid(), // ignored by the route; harmless
    });
    const { status, body } = await api.delete("/exercises/Scratch Press Mk2");
    assertEquals(status, 200);
    assertEquals(body.deleted, "Scratch Press Mk2");
  });
});
