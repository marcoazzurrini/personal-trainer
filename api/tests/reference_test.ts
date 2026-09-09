import { assert, assertEquals } from "@std/assert";
import { api, ensureCatalogue, resetTraining } from "./helpers.ts";

Deno.test("reference data", async (t) => {
  await resetTraining();
  await ensureCatalogue();

  await t.step("the catalogue is loaded with aliases and muscles", async () => {
    const { status, body } = await api.get("/exercises");
    assertEquals(status, 200);
    assert(body.exercises.length >= 54);
    const squat = body.exercises.find(
      (e: { name: string }) => e.name === "Back Squat",
    );
    assert(squat.aliases.includes("squat"));
    assertEquals(squat.systemic_fatigue, "high");
    const factorOf = (muscle: string) =>
      squat.muscles.find(
        (m: { muscle: string; volume_factor: number }) => m.muscle === muscle,
      )?.volume_factor;
    assertEquals(factorOf("quads"), 1); // direct
    assertEquals(factorOf("glutes"), 0.5); // indirect
    assertEquals(factorOf("hamstrings"), 0); // considered and excluded
  });

  await t.step("duplicate exercise names are rejected, any case", async () => {
    const { status, body } = await api.post("/exercises", {
      name: "back squat",
    });
    assertEquals(status, 409);
    assert(body.error.includes("already exists"));
  });

  await t.step("an unknown muscle names the known ones", async () => {
    const { status, body } = await api.post("/exercises", {
      name: "Test Exercise",
      muscles: [{ muscle: "quadz", volume_factor: 1 }],
    });
    assertEquals(status, 422);
    assert(body.error.includes("quads"));
  });

  await t.step(
    "the old muscle fields are rejected with directions",
    async () => {
      const oldCounts = await api.post("/exercises", {
        name: "Test Exercise",
        muscles: [{ muscle: "quads", counts: true }],
      });
      assertEquals(oldCounts.status, 422);
      assert(oldCounts.body.error.includes("volume_factor"));

      const oldFatigue = await api.post("/exercises", {
        name: "Test Exercise",
        muscles: [{ muscle: "quads", volume_factor: 1, fatigue: "lots" }],
      });
      assertEquals(oldFatigue.status, 422);
      assert(oldFatigue.body.error.includes("systemic_fatigue"));

      const freeForm = await api.post("/exercises", {
        name: "Test Exercise",
        muscles: [{ muscle: "quads", volume_factor: 0.75 }],
      });
      assertEquals(freeForm.status, 422);
      assert(freeForm.body.error.includes("0.5"));
    },
  );

  await t.step("user context: latest row per topic wins", async () => {
    await api.post("/user-context", {
      topic: "lower back",
      content: "wants 48h between heavy days",
    });
    await api.post("/user-context", {
      topic: "lower back",
      content: "fine lately",
    });
    const current = await api.get("/user-context");
    const rows = current.body.context.filter(
      (r: { topic: string }) => r.topic === "lower back",
    );
    assertEquals(rows.length, 1);
    assertEquals(rows[0].content, "fine lately");

    const history = await api.get("/user-context?history=true");
    assertEquals(history.body.history.length, 2);
  });

  await t.step('"all" is refused where weeks are plan-relative', async () => {
    // It works on /weekly-volume, so the coach will try it here; the refusal
    // has to say why rather than implying the parameter never exists.
    const { status, body } = await api.get(
      "/weekly-exercise-sets?mesocycle=all",
    );
    assertEquals(status, 422);
    assert(body.error.includes("weekly-volume"));
    assert(body.error.includes("different doses"));
  });

  await t.step("bodyweight dedupes on its natural key", async () => {
    const measurement = {
      value_kg: 82.5,
      measured_at: "2026-08-01T07:30:00Z",
    };
    const first = await api.post("/bodyweight", measurement);
    assertEquals(first.status, 201);
    const retry = await api.post("/bodyweight", measurement);
    assertEquals(retry.status, 200);
    assertEquals(retry.body.bodyweight.id, first.body.bodyweight.id);

    const conflicting = await api.post("/bodyweight", {
      ...measurement,
      value_kg: 83.1,
    });
    assertEquals(conflicting.status, 409);

    const series = await api.get("/bodyweight");
    assertEquals(series.status, 200);
    assertEquals(series.body.bodyweight.length, 1);
    assertEquals(series.body.bodyweight[0].value_kg, 82.5);
  });

  await t.step("a canonical name outranks an alias spelling it", async () => {
    // The catalogue survives resets, so clear any leftovers from a prior run
    // before creating the fixtures.
    await api.delete("/exercises/Collision Probe");
    await api.delete("/exercises/Collision Prober");

    const canonical = await api.post("/exercises", {
      name: "Collision Probe",
      measure: "reps",
      muscles: [{ muscle: "quads", volume_factor: 1 }],
    });
    assertEquals(canonical.status, 201, canonical.body.error);
    const other = await api.post("/exercises", {
      name: "Collision Prober",
      measure: "reps",
      muscles: [{ muscle: "quads", volume_factor: 1 }],
      aliases: ["collision probe"],
    });
    assertEquals(other.status, 201, other.body.error);

    // "collision probe" is now both a canonical name and another exercise's
    // alias. The name must win — the exercise resolver once left this
    // collision to whichever row the planner happened to produce first.
    const { status, body } = await api.get(
      "/exercises/collision%20probe/history?limit=1",
    );
    assertEquals(status, 200);
    assertEquals(body.exercise, "Collision Probe");

    await api.delete("/exercises/Collision Prober");
    await api.delete("/exercises/Collision Probe");
  });
});
