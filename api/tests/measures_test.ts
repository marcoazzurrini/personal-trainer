import { assert, assertEquals } from "@std/assert";
import {
  api,
  endPlan,
  ensureCatalogue,
  lastMonday,
  resetTraining,
  seedPlan,
  today,
} from "./helpers.ts";

// What a set records is a property of its exercise, not a choice the caller
// makes per row. These are the rules that keep a squat from being logged in
// metres and a sprint from being logged in reps — neither of which any
// downstream reader could detect afterwards.
Deno.test("a set is measured the way its exercise is", async (t) => {
  await resetTraining();
  await ensureCatalogue();

  await seedPlan({
    name: "Mixed",
    track: "speed",
    intent: "testing measures",
    exercises: [
      { exercise: "sprint", weekly_dose: 0.4, weekly_dose_unit: "km" },
      { exercise: "box jump", role: "accessory", weekly_dose: 30 },
    ],
  });

  const one = (set: unknown) =>
    api.post("/sessions", {
      date: today(),
      rationale: "measure check",
      sets: [set],
    });

  await t.step("a squat is weight and reps, and neither alone", async () => {
    assertEquals(
      (await one({
        exercise: "squat",
        weight_kg: 100,
        reps: 5,
        effort: "hard",
      })).status,
      201,
    );

    const noWeight = await one({ exercise: "squat", reps: 5, effort: "hard" });
    assertEquals(noWeight.status, 422);
    assert(noWeight.body.error.includes("weight_kg"), noWeight.body.error);
    // The distinction that matters: a bodyweight set is 0, an absent one was
    // not done, and the schema must not let those collapse into each other.
    assert(noWeight.body.error.includes("0 is a real bodyweight set"));

    const metres = await one({
      exercise: "squat",
      weight_kg: 100,
      reps: 5,
      distance_m: 40,
      effort: "hard",
    });
    assertEquals(metres.status, 422);
    assert(metres.body.error.includes("not distance_m"), metres.body.error);
  });

  await t.step("a sprint is metres and a stopwatch", async () => {
    assertEquals(
      (await one({ exercise: "sprint", distance_m: 40, duration_s: 5.21 }))
        .status,
      201,
    );
    // Either alone is legitimate: a bout timed but not measured, or measured
    // but not timed.
    assertEquals(
      (await one({ exercise: "sprint", distance_m: 40 })).status,
      201,
    );
    assertEquals(
      (await one({ exercise: "sprint", duration_s: 5.4 })).status,
      201,
    );

    const reps = await one({ exercise: "sprint", reps: 6, effort: "hard" });
    assertEquals(reps.status, 422);
    assert(reps.body.error.includes("not reps"), reps.body.error);
  });

  // Effort reports proximity to failure, so it is asked for exactly where that
  // drives the adaptation — and nowhere else. The discriminator is the
  // stimulus, not whether the set happened to count reps.
  await t.step("strength work answers for its effort", async () => {
    assertEquals(
      (await one({
        exercise: "squat",
        weight_kg: 100,
        reps: 5,
        effort: "hard",
      }))
        .status,
      201,
    );
    const noChip = await one({ exercise: "squat", weight_kg: 100, reps: 5 });
    assertEquals(noChip.status, 422);
    assert(noChip.body.error.includes("effort is required"), noChip.body.error);

    // An unloaded strength set is still strength work, and this is the hole the
    // old weight-keyed rule left open: no weight, so no chip demanded. Nothing
    // in the catalogue is shaped like this yet — every strength lift there is
    // load_reps — so the case is built rather than borrowed.
    await api.post("/exercises", {
      name: "Nordic Curl",
      equipment: "bodyweight",
      measure: "reps",
      stimulus_type: "strength",
      muscles: [{ muscle: "hamstrings", volume_factor: 1.0 }],
    });
    const bodyweight = await one({ exercise: "nordic curl", reps: 6 });
    assertEquals(bodyweight.status, 422);
    assert(
      bodyweight.body.error.includes("effort is required"),
      bodyweight.body.error,
    );
    assertEquals(
      (await one({ exercise: "nordic curl", reps: 6, effort: "hard" })).status,
      201,
    );
  });

  await t.step("explosive and conditioning work does not", async () => {
    // A box jump counts contacts, so a rep-keyed rule would demand a chip for
    // it. Jumps are not taken to failure and easy/hard says nothing true about
    // one — worse, "easy" is defined as "too light, a programming error", so a
    // forced chip would feed a false diagnosis into every review.
    assertEquals((await one({ exercise: "box jump", reps: 5 })).status, 201);
    assertEquals(
      (await one({ exercise: "sprint", distance_m: 40, duration_s: 5.3 }))
        .status,
      201,
    );
    assertEquals(
      (await one({ exercise: "broad jump", distance_m: 240 })).status,
      201,
    );
  });

  await t.step(
    "a load may ride along, but is never the measurement",
    async () => {
      // A weighted vest on a jump, a sled pushed for metres: legitimate.
      assertEquals(
        (await one({
          exercise: "box jump",
          weight_kg: 10,
          reps: 5,
          effort: "hard",
        })).status,
        201,
      );
      assertEquals(
        (await one({ exercise: "sprint", weight_kg: 20, distance_m: 30 }))
          .status,
        201,
      );

      // A weight on its own measures nothing.
      const bare = await one({ exercise: "sprint", weight_kg: 20 });
      assertEquals(bare.status, 422);
    },
  );

  await t.step("targets are held to the same rule as actuals", async () => {
    const bad = await one({
      exercise: "sprint",
      target_weight_kg: 100,
      target_reps: 5,
    });
    assertEquals(bad.status, 422);
    assert(bad.body.error.includes("target_"), bad.body.error);

    const good = await one({
      exercise: "sprint",
      target_distance_m: 40,
      target_duration_s: 5.2,
    });
    assertEquals(good.status, 201);
  });

  await t.step("a correction is judged on what the row becomes", async () => {
    const s = await one({
      exercise: "squat",
      weight_kg: 100,
      reps: 5,
      effort: "hard",
    });
    const setId = s.body.session.sets[0].id;

    // Clearing the reps would leave a weight measuring nothing. The patch says
    // nothing about weight_kg, so only the merged row reveals the problem.
    const orphaned = await api.patch(`/sets/${setId}`, { reps: null });
    assertEquals(orphaned.status, 422);

    const fine = await api.patch(`/sets/${setId}`, {
      weight_kg: 102.5,
      reps: 4,
    });
    assertEquals(fine.status, 200);
    assertEquals(fine.body.set.weight_kg, 102.5);
  });
});

// A dose has to be comparable with what gets delivered, or it is a number
// that can never be met and never be judged.
Deno.test("a dose is stated in a unit the exercise can deliver", async (t) => {
  await resetTraining();
  await ensureCatalogue();

  const block = await api.post("/blocks", {
    name: "Dose block",
    goal: "testing",
    started_on: lastMonday(),
  });

  const plan = (exercise: string, dose: number, unit: string) => ({
    block_id: block.body.block.id,
    name: `${exercise} ${unit}`,
    track: "endurance",
    intent: "testing dose units",
    planned_weeks: 4,
    sessions_per_week: 3,
    started_on: lastMonday(),
    exercises: [{
      exercise,
      role: "main",
      priority: 1,
      weekly_dose: dose,
      weekly_dose_unit: unit,
    }],
  });

  await t.step("sets always work", async () => {
    const { status, body } = await api.post(
      "/mesocycles",
      plan("squat", 9, "sets"),
    );
    assertEquals(status, 201);
    await endPlan(body.mesocycle.id);
  });

  await t.step("km needs an exercise that records distance", async () => {
    const bad = await api.post("/mesocycles", plan("squat", 5, "km"));
    assertEquals(bad.status, 422);
    assert(bad.body.error.includes("Allowed here: sets"), bad.body.error);

    const good = await api.post("/mesocycles", plan("easy run", 30, "km"));
    assertEquals(good.status, 201);
    await endPlan(good.body.mesocycle.id);
  });

  await t.step("minutes needs an exercise that records time", async () => {
    const bad = await api.post("/mesocycles", plan("box jump", 20, "minutes"));
    assertEquals(bad.status, 422);

    const good = await api.post(
      "/mesocycles",
      plan("easy run", 150, "minutes"),
    );
    assertEquals(good.status, 201);
    await endPlan(good.body.mesocycle.id);
  });

  await t.step("a dose of zero is not a dose", async () => {
    const { status, body } = await api.post(
      "/mesocycles",
      plan("squat", 0, "sets"),
    );
    assertEquals(status, 422);
    assert(body.error.includes("greater than 0"), body.error);
  });

  await t.step("an unknown unit is refused with the list", async () => {
    const { status, body } = await api.post(
      "/mesocycles",
      plan("easy run", 5, "metres"),
    );
    assertEquals(status, 422);
    assert(body.error.includes("sets, minutes, km"), body.error);
  });
});
